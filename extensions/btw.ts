import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type Message } from "@earendil-works/pi-ai";

const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
const BTW_REX_TYPE = "btw-rex-thread";
const BTW_SEED_TYPE = "btw-seed-end";

const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"Be direct and practical.",
].join(" ");

const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";

type BtwDetails = {
	question: string;
	answer: string;
};

type BtwThread = {
	sessionFile: string;
	seedEntryId: string;
	ownerSessionId?: string;
	rexSession?: string;
	blockId?: string;
	layerId?: string;
};

type SideMessage = Parameters<SessionManager["appendMessage"]>[0];

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function getPiInvocation(): string[] {
	const script = process.argv[1];
	if (script && existsSync(script)) return [process.execPath, script];
	return /^(node|bun)(\.exe)?$/i.test(basename(process.execPath)) ? ["pi"] : [process.execPath];
}

function extractText(content: AssistantMessage["content"]): string {
	return content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}

function readSideMessages(thread: BtwThread): SideMessage[] {
	if (!existsSync(thread.sessionFile)) {
		throw new Error("The saved BTW session is missing. Choose Start fresh to create a new thread.");
	}
	const branch = SessionManager.open(thread.sessionFile).getBranch();
	const seedIndex = branch.findIndex((entry) => entry.id === thread.seedEntryId);
	if (seedIndex < 0) {
		throw new Error("The BTW context boundary is missing. Choose Start fresh to create a new thread.");
	}
	return convertToLlm(branch.slice(seedIndex + 1).flatMap((entry) => entry.type === "message" ? [entry.message] : []))
		.filter((message) => message.role !== "system");
}

function formatSideMessages(messages: SideMessage[]): string {
	// Do not summarize the inherited main chat, tool output, or private reasoning.
	return serializeConversation(convertToLlm(messages.filter((message) => message.role === "user" || message.role === "assistant"))
		.flatMap<Message>((message) => {
			if (message.role === "user") return [message];
			if (message.role !== "assistant") return [];
			const answer = extractText(message.content);
			return answer ? [{ ...message, content: [{ type: "text" as const, text: answer }] }] : [];
		}));
}

export default function (pi: ExtensionAPI) {
	let thread: BtwThread | null = null;
	let legacyThread: BtwDetails[] = [];
	let busy = false;
	let generation = 0;

	async function rex(args: string[]): Promise<string> {
		const result = await pi.exec("rex", args, { timeout: 15_000 });
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || "Rex command failed.");
		}
		return result.stdout;
	}

	async function rexApi<T>(session: string, method: string, args: Record<string, unknown>): Promise<T> {
		return JSON.parse(await rex(["api", "call", "-s", session, method, JSON.stringify(args)])) as T;
	}

	function persist(): void {
		pi.appendEntry(BTW_REX_TYPE, thread ? { ...thread } : null);
	}

	async function paneIsOpen(current: BtwThread): Promise<boolean> {
		if (!current.rexSession || !current.blockId) return false;
		let output: string;
		try {
			output = await rex(["block", "ls", "-s", current.rexSession, "--json"]);
		} catch (error) {
			// Only a confirmed missing session means the pane is closed. Other Rex
			// failures must stay visible rather than silently orphaning a live pane.
			const result = JSON.parse(await rex(["ls", "--json"])) as {
				sessions: { session_id: string }[];
			};
			if (!result.sessions.some((session) => session.session_id === current.rexSession)) return false;
			throw error;
		}
		const result = JSON.parse(output) as { blocks: { block_id: string }[] };
		return result.blocks.some((block) => block.block_id === current.blockId);
	}

	async function closePane(current: BtwThread | null): Promise<void> {
		if (!current?.rexSession || !current.blockId) return;
		if (await paneIsOpen(current)) {
			// Close only our terminal, not any other blocks the user added to its layer.
			await rex(["block", "close", "-s", current.rexSession, current.blockId]);
		}
		clearPane(current);
	}

	function clearPane(current: BtwThread): void {
		delete current.blockId;
		delete current.layerId;
		delete current.rexSession;
	}

	async function restoreThread(_event: unknown, ctx: ExtensionContext): Promise<void> {
		generation++;
		try {
			await closePane(thread);
		} catch (error) {
			ctx.ui.notify(`Could not close the previous BTW pane: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		thread = null;
		legacyThread = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === BTW_RESET_TYPE) {
				thread = null;
				legacyThread = [];
			} else if (entry.customType === BTW_REX_TYPE) {
				const saved = entry.data as BtwThread | null;
				thread = saved?.sessionFile && saved.seedEntryId ? { ...saved } : null;
				// Forks inherit the transcript, not control of the original pane.
				// Old entries without ownership metadata are detached conservatively.
				if (thread && thread.ownerSessionId !== ctx.sessionManager.getSessionId()) clearPane(thread);
				legacyThread = [];
			} else if (entry.customType === BTW_ENTRY_TYPE) {
				const details = entry.data as BtwDetails | undefined;
				if (details?.question && details.answer) legacyThread.push(details);
			}
		}
	}

	function createThread(ctx: ExtensionCommandContext, previous: SideMessage[], legacy: BtwDetails[]): BtwThread {
		const sessionDir = join(ctx.sessionManager.getSessionDir(), "btw");
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		// In-memory first: write the complete seed once, including when the main chat is empty.
		const seed = SessionManager.inMemory(ctx.cwd, {
			parentSession: ctx.sessionManager.getSessionFile(),
		});
		const messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
		for (const message of convertToLlm(messages)) {
			// The child declares its own prompt and tools; don't replay the parent's declarations.
			if (message.role !== "system") seed.appendMessage(message);
		}
		const seedEntryId = seed.appendCustomEntry(BTW_SEED_TYPE);
		for (const message of previous) seed.appendMessage(message);
		for (const item of legacy) {
			seed.appendMessage({ role: "user", content: `User: ${item.question}\nAssistant: ${item.answer}`, timestamp: Date.now() });
		}
		seed.appendSessionInfo("BTW side chat");
		const sessionFile = join(sessionDir, `${seed.getSessionId()}.jsonl`);
		writeFileSync(sessionFile, [seed.getHeader(), ...seed.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
			mode: 0o600,
			flag: "wx",
		});
		return { sessionFile, seedEntryId, ownerSessionId: ctx.sessionManager.getSessionId() };
	}

	async function openPane(ctx: ExtensionCommandContext, question: string, fresh: boolean): Promise<void> {
		const session = process.env.REX_SESSION;
		const anchor = process.env.REX_BLOCK;
		if (!session || !anchor) throw new Error("/btw must run inside Rex (REX_SESSION and REX_BLOCK are required).");
		if (!ctx.model) throw new Error("No active model selected.");
		const currentGeneration = generation;
		const current = thread;

		if (!fresh && current && await paneIsOpen(current)) {
			if (generation !== currentGeneration) return;
			if (current.layerId) await rexApi(current.rexSession!, "session.raise_layer", { layer_id: current.layerId });
			await rex(["focus", "-s", current.rexSession!, current.blockId!]);
			if (question) {
				await rex(["send", "-s", current.rexSession!, "-b", current.blockId!, `Side question: ${question}`]);
				await rex(["send-key", "-s", current.rexSession!, "-b", current.blockId!, "enter"]);
			}
			return;
		}

		const location = JSON.parse(await rex(["block", "inspect", "-s", session, anchor, "--json"])) as {
			block: { window_id?: string };
		};
		if (!location.block.window_id) throw new Error("The current Rex pane is not in a window.");
		if (generation !== currentGeneration) return;
		await closePane(current);
		if (generation !== currentGeneration) return;
		const previous = !fresh && current ? readSideMessages(current) : [];
		const next = createThread(ctx, previous, fresh ? [] : legacyThread);
		const promptFile = `${next.sessionFile}.prompt.md`;
		writeFileSync(promptFile, stripDynamicSystemPromptFooter(ctx.getSystemPrompt()) + "\n\n" + BTW_SYSTEM_PROMPT, { mode: 0o600, flag: "wx" });
		const command = [
			...getPiInvocation(), "--session", next.sessionFile,
			"--provider", ctx.model.provider, "--model", ctx.model.id,
			"--thinking", pi.getThinkingLevel(),
			"--tools", "read,bash,edit,write",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
			"--system-prompt", promptFile,
		];
		if (question) command.push("--", `Side question: ${question}`);
		const created = await rexApi<{ block_ids: string[]; layer_id: string }>(session, "session.new_layer", {
			window_id: location.block.window_id,
			bounds: [0.225, 0.125, 0.55, 0.75],
			focus: true,
			layout: {
				block: {
					flavor: "com.superlogical.terminal.shell",
					label: "BTW",
					options: { command, cwd: ctx.cwd },
				},
			},
		});
		next.rexSession = session;
		next.blockId = created.block_ids[0];
		next.layerId = created.layer_id;
		if (!next.blockId || !next.layerId) throw new Error("Rex did not return the floating pane IDs.");
		if (generation !== currentGeneration) {
			await closePane(next);
			return;
		}
		thread = next;
		legacyThread = [];
		persist();
	}

	async function injectSummary(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.model) throw new Error("No active model selected.");
		const currentGeneration = generation;
		const current = thread;
		await closePane(current);
		if (generation !== currentGeneration) return;
		if (current) persist();
		const transcript = current ? formatSideMessages(readSideMessages(current))
			: legacyThread.map((item) => `User: ${item.question}\nAssistant: ${item.answer}`).join("\n\n");
		if (!transcript.trim()) {
			ctx.ui.notify("No BTW thread to summarize.", "warning");
			return;
		}
		const response = await ctx.modelRegistry.complete(ctx.model, {
			systemPrompt: BTW_SUMMARY_PROMPT,
			messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
		}, { signal: ctx.signal });
		if (generation !== currentGeneration) return;
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || "BTW summary failed or was aborted.");
		}
		const summary = extractText(response.content);
		if (!summary) throw new Error("Summary finished without a text response.");
		pi.sendUserMessage(`Summary of my BTW side conversation:\n\n${summary}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		thread = null;
		legacyThread = [];
		pi.appendEntry(BTW_RESET_TYPE, { timestamp: Date.now() });
	}

	pi.registerCommand("btw", {
		description: "Open a floating Rex side chat. /btw <text> asks immediately; /btw offers continue, reset, or summary injection.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (busy) {
				ctx.ui.notify("A BTW command is already in progress.", "warning");
				return;
			}
			busy = true;
			try {
				const currentGeneration = generation;
				const question = args.trim();
				if (question) {
					await openPane(ctx, question, false);
					return;
				}
				if (thread || legacyThread.length > 0) {
					const choice = await ctx.ui.select("BTW side chat:", [
						"Continue previous conversation",
						"Start fresh",
						"Inject summary into main chat",
					]);
					if (generation !== currentGeneration) return;
					if (choice === "Continue previous conversation") await openPane(ctx, "", false);
					else if (choice === "Start fresh") await openPane(ctx, "", true);
					else if (choice === "Inject summary into main chat") await injectSummary(ctx);
				} else {
					await openPane(ctx, "", true);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				busy = false;
			}
		},
	});

	pi.on("session_start", restoreThread);
	pi.on("session_tree", restoreThread);
	pi.on("session_shutdown", async () => {
		generation++;
		await closePane(thread);
	});
}
