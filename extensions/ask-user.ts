import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Choice = { label: string; description?: string };
type Selection = number | "other" | undefined;

const OTHER = "Other";
const SUBTITLE = "Choose an answer, or Other to type your own.";

/**
 * Picks an answer. The TUI gets a two-column list (label, then a muted, wrapped description);
 * other dialog-capable modes (RPC) keep the native select, which only accepts plain strings.
 */
async function selectChoice(ctx: ExtensionContext, question: string, choices: Choice[], signal?: AbortSignal): Promise<Selection> {
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
		let cached: { width: number; lines: string[] } | undefined;
		const onAbort = () => done(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) queueMicrotask(onAbort);

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		const hint = (keys: string, action: string) => theme.fg("dim", keys) + theme.fg("muted", ` ${action}`);
		const keysFor = (binding: Parameters<typeof keybindings.getKeys>[0]) => keybindings.getKeys(binding).join("/");

		function renderList(width: number): string[] {
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
			return blocks.flatMap((block, index) => (spaced && index > 0 ? ["", ...block] : block));
		}

		function render(width: number): string[] {
			if (cached?.width === width) return cached.lines;
			const inner = Math.max(1, width - 2);
			const pad = (lines: string[]) => lines.map((line) => (line ? truncateToWidth(` ${line}`, width, "") : ""));
			const border = theme.fg("border", "─".repeat(Math.max(1, width)));
			const lines = [
				border,
				"",
				...pad(wrapTextWithAnsi(question, inner).map((line) => theme.fg("accent", theme.bold(line)))),
				"",
				...pad(wrapTextWithAnsi(SUBTITLE, inner).map((line) => theme.fg("text", line))),
				"",
				...pad(renderList(inner)),
				"",
				...pad(
					wrapTextWithAnsi(
						[
							hint("↑↓", "navigate"),
							hint(keysFor("tui.select.confirm"), "select"),
							hint(keysFor("tui.select.cancel"), "cancel"),
						].join("  "),
						inner,
					),
				),
				"",
				border,
			];
			cached = { width, lines };
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
	});
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
	if (process.env.PI_TMUX_SUBAGENT_CHILD === "1") return;

	const cancellationNotice = "Cancellation is not an answer or approval. Stop this run and wait for the user to tell you how to proceed.";

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		exposure: "model-only",
		description: [
			"Ask the user only when missing information or an unresolved choice materially affects the outcome and cannot be resolved from the request, codebase, or available tools. Investigate first.",
			"For routine, low-risk, reversible decisions, choose a reasonable default and proceed. Do not use this as routine confirmation for work already requested or to ask for information you can discover yourself.",
			"Use normal conversation for brainstorming and open-ended discussion.",
			"Ask one focused question with enough context to decide. Provide 2–4 genuinely distinct choices with short labels and optional descriptions explaining relevant trade-offs. If there is only one sensible approach, state it and proceed; do not invent a filler alternative.",
			"When recommending an option, put it first and add (Recommended) to its label. Treat custom answers as user instructions, which may ask you to explain, change scope, or wait rather than proceed.",
			"The user can also choose Other and type their own answer. Do not include Other in the options.",
		].join(" "),
		parameters: Type.Object({
			question: Type.String({ minLength: 1, description: "The question to show the user" }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ minLength: 1, description: "A concise, single-line choice label" }),
					description: Type.Optional(Type.String({ description: "A short explanation of the choice or its trade-offs" })),
				}),
				{
					minItems: 2,
					maxItems: 4,
					description: "2–4 meaningful choices (do not include Other; it is added automatically)",
				},
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, { question, options }, signal, _onUpdate, ctx) {
			question = question.trim();
			if (options.length < 2 || options.length > 4) {
				throw new Error("Provide 2–4 meaningful choices. If there is only one sensible approach, state it and proceed; do not invent an alternative.");
			}
			const suggested = options.map((option) => ({ label: option.label.trim(), description: option.description?.trim() }));
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
				const selected = await selectChoice(ctx, question, suggested, signal);
				if (signal?.aborted || selected === undefined) break;
				if (selected !== "other") {
					answer = suggested[selected].label;
					break;
				}

				// Empty text is not an answer. Escape returns to the choices.
				while (!signal?.aborted) {
					const input = await ctx.ui.input(`${question}\n\nType your answer. Esc returns to the choices.`, "Type your answer...", { signal });
					if (signal?.aborted || input === undefined) break;
					if (input.trim()) {
						answer = input.trim();
						answerKind = "custom";
						break;
					}
					ctx.ui.notify("Please enter an answer, or press Esc to go back.", "warning");
				}
				if (answer !== undefined) break;
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
			return new Text(`${theme.fg("toolTitle", theme.bold("ask_user"))} ${theme.fg("muted", args.question)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			// Keep historical skipped results readable, although new calls no longer skip questions.
			const skipped = details.status === "skipped" || ("skipped" in details && details.skipped === true);
			return new Text(
				details.answer === null
					? theme.fg("warning", skipped ? "Skipped (questions cancelled)" : "Cancelled")
					: theme.fg("success", "✓ ") + theme.fg("accent", details.answer),
				0,
				0,
			);
		},
	});
}
