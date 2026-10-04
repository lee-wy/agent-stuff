import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface AskUserDetails {
	question: string;
	answer: string | null;
	custom: boolean;
}

export default function (pi: ExtensionAPI) {
	// Subagents run in detached tmux sessions; questions must be handled by the parent.
	if (process.env.PI_TMUX_SUBAGENT_CHILD === "1") return;

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: [
			"Ask the user only when missing information or an unresolved choice materially affects the outcome and cannot be resolved from the request, codebase, or available tools. Investigate first.",
			"For routine, low-risk, reversible decisions, choose a reasonable default and proceed. Do not use this as routine confirmation for work already requested or to ask for information you can discover yourself.",
			"Use normal conversation for brainstorming and open-ended discussion.",
			"Ask a focused question with enough context to decide. Provide a few short, distinct suggested answers with relevant trade-offs, and state your recommendation when appropriate.",
			"The user can also choose Other and type their own answer. Do not include Other in the options.",
		].join(" "),
		parameters: Type.Object({
			question: Type.String({ description: "The question to show the user" }),
			options: Type.Array(Type.String(), {
				minItems: 1,
				description: "Suggested answers (do not include Other; it is added automatically)",
			}),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, { question, options }, signal, _onUpdate, ctx) {
			if (!question.trim() || options.some((option) => !option.trim())) {
				throw new Error("Provide a non-empty question and non-empty suggested answers.");
			}
			const labels = options.map((option) => option.trim());
			if (labels.some((label) => label.toLowerCase() === "other") || new Set(labels).size !== labels.length) {
				throw new Error("Suggested answers must be distinct and must not include Other.");
			}
			if (!ctx.hasUI) {
				throw new Error("ask_user requires an interactive UI.");
			}

			let answer: string | undefined;
			let custom = false;
			while (!signal?.aborted) {
				const selected = await ctx.ui.select(question, [...options, "Other"], { signal });
				if (signal?.aborted || selected === undefined) break;
				if (selected !== "Other") {
					answer = selected;
					break;
				}

				// Empty text is not an answer. Escape returns to the choices.
				while (!signal?.aborted) {
					const input = await ctx.ui.input(question, "Type your answer... (Esc to go back)", { signal });
					if (signal?.aborted || input === undefined) break;
					if (input.trim()) {
						answer = input.trim();
						custom = true;
						break;
					}
					ctx.ui.notify("Please enter an answer, or press Esc to go back.", "warning");
				}
				if (answer !== undefined) break;
			}

			const details: AskUserDetails = { question, answer: answer ?? null, custom };
			return {
				content: [{ type: "text", text: answer ?? "User cancelled the question without answering." }],
				details,
				// On cancellation, request no follow-up (all tools in the batch must agree).
				terminate: answer === undefined,
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
			return new Text(
				details.answer === null
					? theme.fg("warning", "Cancelled")
					: theme.fg("success", "✓ ") + theme.fg("accent", details.answer),
				0,
				0,
			);
		},
	});
}
