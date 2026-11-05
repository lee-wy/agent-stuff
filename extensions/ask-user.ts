import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Choice = { label: string; description?: string };
type Selection = number | "other" | undefined;

const OTHER = "Other";
const SUBTITLE = "Choose an answer, or Other to type your own.";

function escapeTerminalControls(text: string): string {
	// Keep line feeds for layout; show other C0/C1 controls literally, before adding trusted styling.
	return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * Picks an answer. The TUI gets a two-column list (label, then a muted, wrapped description);
 * other dialog-capable modes (RPC) keep the native select, which only accepts plain strings.
 */
async function selectChoice(ctx: ExtensionContext, question: string, choices: Choice[], signal?: AbortSignal): Promise<Selection> {
	question = escapeTerminalControls(question);
	choices = choices.map(({ label, description }) => ({
		label: escapeTerminalControls(label),
		description: description === undefined ? undefined : escapeTerminalControls(description),
	}));
	if (ctx.mode !== "tui") {
		const display = choices.map(({ label, description }) => (description ? `${label}\n    ${description}` : label));
		const selected = await ctx.ui.select(`${question}\n\n${SUBTITLE}`, [...display, OTHER], { signal });
		if (selected === undefined) return undefined;
		if (selected === OTHER) return "other";
		const index = display.indexOf(selected);
		if (index === -1) throw new Error("The selected answer must match one of the presented choices.");
		return index;
	}

	const rows: Choice[] = [...choices, { label: OTHER }];
	return ctx.ui.custom<Selection>((tui, theme, keybindings, done) => {
		let selectedIndex = 0;
		let cached: { width: number; height: number; lines: string[] } | undefined;
		const onAbort = () => done(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) queueMicrotask(onAbort);

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		const hint = (keys: string, action: string) => theme.fg("dim", keys) + theme.fg("muted", ` ${action}`);
		const keysFor = (binding: Parameters<typeof keybindings.getKeys>[0]) => keybindings.getKeys(binding).join("/");

		function renderList(width: number): { lines: string[]; selectedLine: number } {
			const prefixWidth = 2;
			const gap = 2;
			const hasDescriptions = rows.some((row) => row.description);
			const widestLabel = Math.max(...rows.map((row) => visibleWidth(row.label)));
			const labelWidth = Math.max(1, Math.min(widestLabel, Math.floor(width * 0.4)));
			const descriptionWidth = width - prefixWidth - labelWidth - gap;
			const twoColumns = hasDescriptions && descriptionWidth >= 24;

			const blocks = rows.map((row, index) => {
				const selected = index === selectedIndex;
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const color = selected ? "accent" : "text";
				const indent = " ".repeat(prefixWidth);

				if (!twoColumns) {
					// Narrow terminals: stack the description under the label.
					const labels = wrapTextWithAnsi(row.label, Math.max(1, width - prefixWidth));
					const lines = labels.map((line, i) => (i === 0 ? prefix : indent) + theme.fg(color, line));
					if (row.description) {
						const descIndent = indent + "  ";
						for (const line of wrapTextWithAnsi(row.description, Math.max(1, width - descIndent.length))) {
							lines.push(descIndent + theme.fg("muted", line));
						}
					}
					return lines;
				}

				const labels = wrapTextWithAnsi(row.label, labelWidth);
				const descriptions = row.description ? wrapTextWithAnsi(row.description, descriptionWidth) : [];
				const lines: string[] = [];
				for (let i = 0; i < Math.max(labels.length, descriptions.length); i++) {
					const label = labels[i] ?? "";
					const description = descriptions[i];
					let line = (i === 0 ? prefix : indent) + theme.fg(color, label);
					if (description) line += " ".repeat(labelWidth - visibleWidth(label) + gap) + theme.fg("muted", description);
					lines.push(line);
				}
				return lines;
			});

			// Keep single-line lists compact; separate options once any of them wraps.
			const spaced = blocks.some((block) => block.length > 1);
			const lines: string[] = [];
			let selectedLine = 0;
			for (const [index, block] of blocks.entries()) {
				if (spaced && index > 0) lines.push("");
				if (index === selectedIndex) selectedLine = lines.length;
				lines.push(...block);
			}
			return { lines, selectedLine };
		}

		function render(width: number): string[] {
			// Leave space for Pi's transcript, widgets, status, and footer in both screen modes.
			const height = Math.max(1, tui.terminal.rows - 8);
			if (cached?.width === width && cached.height === height) return cached.lines;
			const inner = Math.max(1, width - 2);
			const pad = (lines: string[]) => lines.map((line) => (line ? truncateToWidth(` ${line}`, width, "") : ""));
			const border = theme.fg("border", "─".repeat(Math.max(1, width)));
			const header = [
				"",
				...pad(wrapTextWithAnsi(question, inner).map((line) => theme.fg("accent", theme.bold(line)))),
				"",
				...pad(wrapTextWithAnsi(SUBTITLE, inner).map((line) => theme.fg("text", line))),
				"",
			];
			const list = renderList(inner);
			const body = [...header, ...pad(list.lines), ""];
			const selectedLine = header.length + list.selectedLine;
			const viewportHeight = Math.max(1, height - 5);
			const start = selectedIndex === 0 && selectedLine < viewportHeight
				? 0
				: Math.max(0, Math.min(selectedLine - Math.floor(viewportHeight / 2), body.length - viewportHeight));
			const end = start + viewportHeight;
			const scrollInfo = body.length > viewportHeight
				? theme.fg("dim", `${start > 0 ? "↑ more  " : ""}${selectedIndex + 1}/${rows.length}${end < body.length ? "  ↓ more" : ""}`)
				: "";
			const help = [
				hint("↑↓", "navigate"),
				hint(keysFor("tui.select.confirm"), "select"),
				hint(keysFor("tui.select.cancel"), "cancel"),
			].join("  ");
			const lines = height < 6
				? body.slice(selectedLine, selectedLine + height)
				: [border, ...body.slice(start, end), ...pad([scrollInfo, help]), "", border];
			cached = { width, height, lines };
			return lines;
		}

		function handleInput(data: string) {
			if (keybindings.matches(data, "tui.select.up") || data === "k") {
				selectedIndex = Math.max(0, selectedIndex - 1);
				refresh();
			} else if (keybindings.matches(data, "tui.select.down") || data === "j") {
				selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
				refresh();
			} else if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
				done(selectedIndex === rows.length - 1 ? "other" : selectedIndex);
			} else if (keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
			}
		}

		return {
			render,
			handleInput,
			invalidate: () => {
				cached = undefined;
			},
			dispose: () => signal?.removeEventListener("abort", onAbort),
		};
	}, { blocked: { kind: "question", message: question } });
}

type AskUserDetails =
	| {
			question: string;
			status: "answered";
			answerKind: "option" | "custom";
			answer: string;
	  }
	| {
			question: string;
			status: "cancelled" | "skipped";
			answer: null;
	  };

export default function (pi: ExtensionAPI) {
	// Subagents run in detached tmux sessions; questions must be handled by the parent.
	if (process.env.PI_SUBAGENT_RUN_DIR) return;

	const cancellationNotice = "Cancellation is not an answer or approval. Stop this run and wait for the user to tell you how to proceed.";

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		exposure: "model-only",
		promptSnippet: "Ask a necessary clarification or user decision and wait for the answer",
		promptGuidelines: [
			"When you need the user's answer before proceeding, call ask_user rather than asking only in prose.",
			"Use ask_user for unresolved requirements, consequential choices, or necessary authorization.",
			"Before calling ask_user, investigate available information. Proceed without ask_user for routine, low-risk, reversible decisions or work already authorized by the user.",
		],
		description: [
			"Collect a necessary clarification or user decision through an interactive prompt and wait for the answer. Use ask_user instead of a prose question when progress depends on the answer.",
			"Investigate first; do not ask for discoverable information, routine confirmation, or low-risk, reversible decisions. Keep open-ended brainstorming in normal conversation.",
			"Ask one focused question with enough context to answer. For a choice, provide 2–4 distinct options with short labels and optional trade-off descriptions. Omit options for a free-text answer; never invent alternatives.",
			"Put a recommended option first and mark it (Recommended). Other is added automatically; do not include it. Treat custom answers as user instructions, including requests to explain, change scope, or wait.",
		].join(" "),
		parameters: Type.Object({
			question: Type.String({ minLength: 1, description: "The question to show the user" }),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ minLength: 1, description: "A concise, single-line choice label" }),
						description: Type.Optional(Type.String({ description: "A short explanation of the choice or its trade-offs" })),
					}),
					{
						minItems: 2,
						maxItems: 4,
						description: "2–4 meaningful choices, without Other (added automatically). Omit options for a free-text answer.",
					},
				),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, { question, options }, signal, _onUpdate, ctx) {
			question = question.trim();
			if (options !== undefined && (options.length < 2 || options.length > 4)) {
				throw new Error("Provide 2–4 meaningful choices, or omit options for a free-text answer. Do not invent alternatives.");
			}
			const suggested = (options ?? []).map((option) => ({ label: option.label.trim(), description: option.description?.trim() }));
			if (!question || suggested.some((option) => !option.label || /[\r\n]/.test(option.label))) {
				throw new Error("Provide a non-empty question and non-empty, single-line choice labels.");
			}
			const labels = suggested.map((option) => option.label);
			if (labels.some((label) => label.toLowerCase() === "other") || new Set(labels).size !== labels.length) {
				throw new Error("Suggested answers must be distinct and must not include Other.");
			}
			if (!ctx.hasUI) {
				throw new Error("ask_user requires an interactive UI.");
			}

			let answer: string | undefined;
			let answerKind: "option" | "custom" = "option";
			while (!signal?.aborted) {
				const selected = suggested.length > 0 ? await selectChoice(ctx, question, suggested, signal) : "other";
				if (signal?.aborted || selected === undefined) break;
				if (selected !== "other") {
					answer = suggested[selected].label;
					break;
				}

				// Empty text is not an answer. Escape goes back if choices exist, otherwise cancels.
				const escapeHint = suggested.length > 0 ? "Esc returns to the choices." : "Esc cancels.";
				while (!signal?.aborted) {
					const input = await ctx.ui.input(`${escapeTerminalControls(question)}\n\nType your answer. ${escapeHint}`, "Type your answer...", { signal });
					if (signal?.aborted || input === undefined) break;
					if (input.trim()) {
						answer = input.trim();
						answerKind = "custom";
						break;
					}
					const escapeAction = suggested.length > 0 ? "go back" : "cancel";
					ctx.ui.notify(`Please enter an answer, or press Esc to ${escapeAction}.`, "warning");
				}
				if (answer !== undefined || suggested.length === 0) break;
			}

			if (answer === undefined) {
				// terminate alone cannot stop sibling tools or a batch with an earlier answer.
				if (!signal?.aborted) ctx.abort();
				return {
					content: [{ type: "text", text: `The user cancelled ${JSON.stringify(question)} without answering. ${cancellationNotice}` }],
					details: { question, status: "cancelled", answer: null } satisfies AskUserDetails,
					terminate: true,
				};
			}

			return {
				content: [{ type: "text", text: `The user answered ${JSON.stringify(question)} with: ${JSON.stringify(answer)}.` }],
				details: { question, status: "answered", answerKind, answer } satisfies AskUserDetails,
			};
		},

		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("ask_user"))} ${theme.fg("muted", escapeTerminalControls(args.question ?? ""))}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? escapeTerminalControls(content.text) : "", 0, 0);
			}
			// Keep historical skipped results readable, although new calls no longer skip questions.
			const skipped = details.status === "skipped" || ("skipped" in details && details.skipped === true);
			return new Text(
				details.answer === null
					? theme.fg("warning", skipped ? "Skipped (questions cancelled)" : "Cancelled")
					: theme.fg("success", "✓ ") + theme.fg("accent", escapeTerminalControls(details.answer)),
				0,
				0,
			);
		},
	});
}
