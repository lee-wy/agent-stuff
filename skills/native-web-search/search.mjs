#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

function parseArgs(argv) {
	const out = {
		provider: undefined,
		model: undefined,
		purpose: "general research support",
		timeoutMs: 120000,
		json: false,
		help: false,
		query: "",
	};

	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = true;
			continue;
		}
		if (arg === "--json") {
			out.json = true;
			continue;
		}
		if (arg === "--provider") {
			out.provider = argv[++i];
			continue;
		}
		if (arg.startsWith("--provider=")) {
			out.provider = arg.slice("--provider=".length);
			continue;
		}
		if (arg === "--model") {
			out.model = argv[++i];
			continue;
		}
		if (arg.startsWith("--model=")) {
			out.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--purpose") {
			out.purpose = argv[++i] || out.purpose;
			continue;
		}
		if (arg.startsWith("--purpose=")) {
			out.purpose = arg.slice("--purpose=".length) || out.purpose;
			continue;
		}
		if (arg === "--timeout") {
			out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs));
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs));
			continue;
		}
		positional.push(arg);
	}

	out.query = positional.join(" ").trim();
	return out;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider openai-codex|openai|anthropic] [--model <id>] [--json]

Examples:
  node search.mjs "latest python release" --purpose "update dependency notes"
  node search.mjs "HTTP/3 browser support 2026" --provider openai-codex
  node search.mjs "vite 7 breaking changes" --json`;
}

function readJson(path, fallback = {}) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

function normalizeProvider(provider) {
	if (!provider) return undefined;
	const p = String(provider).toLowerCase().trim();
	if (p === "anthropic" || p === "claude") return "anthropic";
	if (p === "openai-codex" || p === "codex") return "openai-codex";
	if (p === "openai") return "openai";
	return undefined;
}

function pickProvider(argProvider, settings, auth, env = process.env) {
	if (argProvider !== undefined) {
		const forced = normalizeProvider(argProvider);
		if (!forced) throw new Error(`Unsupported provider '${argProvider}'. Use openai-codex, openai, or anthropic.`);
		return forced;
	}

	const fromSession = normalizeProvider(env.PI_PROVIDER);
	if (fromSession) return fromSession;

	const fromSettings = normalizeProvider(settings?.defaultProvider);
	if (fromSettings) return fromSettings;

	if (auth?.["openai-codex"]) return "openai-codex";
	if (auth?.openai || env.OPENAI_API_KEY) return "openai";
	if (auth?.anthropic || env.ANTHROPIC_API_KEY || env.ANTHROPIC_OAUTH_TOKEN) return "anthropic";

	throw new Error("Could not determine provider. Pass --provider openai-codex|openai|anthropic");
}

function findPiExecutable() {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const first = result.stdout
		.split(/\r?\n/)
		.map((x) => x.trim())
		.find(Boolean);
	return first || undefined;
}

function collectModuleCandidates() {
	const candidates = new Set();

	const add = (p) => {
		if (!p) return;
		const abs = isAbsolute(p) ? p : resolve(p);
		candidates.add(abs);
	};

	const addManagedInstall = (root) => {
		if (!root) return;
		try {
			const version = readFileSync(join(root, "current-version"), "utf8").trim();
			if (!version || version === "." || version === ".." || !/^[0-9A-Za-z._+-]+$/.test(version)) return;
			add(join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
		} catch {
			// Not a managed installation, or its version marker is unavailable.
		}
	};

	add(process.env.PI_CODING_AGENT_MODULE_PATH);

	// Prefer the running Pi installation over potentially stale project dependencies.
	addManagedInstall(process.env.PI_MANAGED_INSTALL_ROOT);
	const piExec = findPiExecutable();
	if (piExec) {
		try {
			const piDir = dirname(realpathSync(piExec));
			addManagedInstall(join(piDir, "..", "install")); // managed bin/pi launcher
			add(join(piDir, "..", "index.js")); // dist/bundle/cli.js
			add(join(piDir, "index.js")); // dist/cli.js
		} catch {
			// ignore
		}
	}

	const cwd = process.cwd();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	for (const start of [cwd, scriptDir]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			add(join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
			add(join(dir, "packages", "coding-agent", "dist", "index.js"));
			add(join(dir, "coding-agent", "dist", "index.js"));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	add(join(homedir(), "Development", "pi-mono", "packages", "coding-agent", "dist", "index.js"));

	return Array.from(candidates);
}

async function loadPiRuntime(agentDir) {
	const tried = [];
	const candidates = collectModuleCandidates().filter(existsSync).map((p) => pathToFileURL(p).href);
	candidates.push("@earendil-works/pi-coding-agent");

	for (const candidate of candidates) {
		try {
			const { ModelRuntime } = await import(candidate);
			if (typeof ModelRuntime?.create !== "function") throw new Error("missing ModelRuntime.create");
			const runtime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				refreshOnCreate: false,
			});
			return runtime;
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	throw new Error(
		`Could not load a current Pi ModelRuntime. Set PI_CODING_AGENT_MODULE_PATH to pi-coding-agent's dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
	);
}

function pickFastModel(provider, requestedModel, runtime) {
	const id = requestedModel || (provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna");
	return runtime.getModel(provider, id) || { id, provider, baseUrl: runtime.getProvider(provider)?.baseUrl };
}

function buildUserPrompt(query, purpose) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
	return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function decodeJwtAccountId(token) {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api") {
	const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

async function runCodexSearch(options) {
	const accountId = decodeJwtAccountId(options.apiKey);
	if (!accountId) throw new Error("Could not determine ChatGPT account ID for openai-codex token.");
	const headers = new Headers(options.headers);
	headers.set("chatgpt-account-id", accountId);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("originator", "pi-native-web-search-skill");
	return runOpenAISearch({
		...options,
		endpoint: resolveCodexUrl(options.baseUrl),
		headers: Object.fromEntries(headers),
		label: "Codex",
	});
}

function resolveOpenAIUrl(baseUrl = "https://api.openai.com/v1") {
	const normalized = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
	if (normalized.endsWith("/responses")) return normalized;
	return `${normalized}/responses`;
}

function extractEventData(chunk) {
	const payload = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!payload || payload === "[DONE]") return null;
	return payload;
}

async function runOpenAISearch({ model, apiKey, query, purpose, timeoutMs, baseUrl, headers, endpoint = resolveOpenAIUrl(baseUrl), label = "OpenAI" }) {
	const body = {
		model,
		store: false,
		stream: true,
		instructions: buildSystemPrompt(),
		input: [{ role: "user", content: [{ type: "input_text", text: buildUserPrompt(query, purpose) }] }],
		tools: [{ type: "web_search" }],
		tool_choice: "required",
	};
	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			accept: "text/event-stream",
			...headers,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const detail = await res.text();
		throw new Error(`${label} request failed (${res.status}): ${detail}`);
	}
	if (!res.body) {
		throw new Error(`${label} response had no body`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let fallbackText = "";
	let searchCompleted = false;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let boundary = buffer.match(/\r?\n\r?\n/);
		while (boundary) {
			const chunk = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary[0].length);
			boundary = buffer.match(/\r?\n\r?\n/);

			const data = extractEventData(chunk);
			if (!data) continue;

			let event;
			try {
				event = JSON.parse(data);
			} catch {
				continue;
			}

			if (event.type === "response.web_search_call.completed" ||
				(event.type === "response.output_item.done" && event.item?.type === "web_search_call" && event.item.status === "completed")) {
				searchCompleted = true;
			}

			if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
				text += event.delta;
			}

			if (event.type === "response.output_item.done" && event.item?.type === "message") {
				const parts = Array.isArray(event.item?.content) ? event.item.content : [];
				const full = parts
					.filter((p) => p.type === "output_text" && typeof p.text === "string")
					.map((p) => p.text)
					.join("\n");
				if (full) fallbackText = full;
			}

			if (event.type === "error") {
				throw new Error(event.message || `${label} stream failed`);
			}

			if (event.type === "response.failed" || event.type === "response.incomplete") {
				throw new Error(event.response?.error?.message || `${label} response ${event.type.slice("response.".length)}`);
			}
		}
	}

	const finalText = (text || fallbackText || "").trim();
	if (!finalText) {
		throw new Error(`${label} returned an empty response`);
	}
	if (!searchCompleted) throw new Error(`${label} did not complete a web search.`);
	return finalText;
}

function buildAnthropicHeaders(apiKey) {
	const oauthToken = typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
	if (oauthToken) {
		return {
			authorization: `Bearer ${apiKey}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05",
			"content-type": "application/json",
			accept: "application/json",
			"x-app": "cli",
			"user-agent": "claude-cli/1.0.72 (external, cli)",
		};
	}
	return {
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "web-search-2025-03-05",
		"content-type": "application/json",
		accept: "application/json",
	};
}

async function runAnthropicSearch({ model, apiKey, query, purpose, timeoutMs, baseUrl, headers }) {
	const body = {
		model,
		max_tokens: 1800,
		system: buildSystemPrompt(),
		tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
		messages: [{ role: "user", content: buildUserPrompt(query, purpose) }],
	};

	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

	const res = await fetch(`${String(baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`, {
		method: "POST",
		headers: { ...buildAnthropicHeaders(apiKey), ...headers },
		body: JSON.stringify(body),
		signal,
	});

	const payload = await res.text();
	if (!res.ok) {
		throw new Error(`Anthropic request failed (${res.status}): ${payload}`);
	}

	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error("Anthropic returned non-JSON response");
	}

	const text = (parsed.content || [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n\n")
		.trim();

	if (!text) {
		throw new Error("Anthropic returned no text content");
	}

	return text;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const settingsPath = join(agentDir, "settings.json");
	const auth = readJson(authPath, {});
	const settings = readJson(settingsPath, {});

	const provider = pickProvider(args.provider, settings, auth);
	const runtime = await loadPiRuntime(agentDir);
	if (!runtime.getProvider(provider)) throw new Error(`Pi does not support provider '${provider}'. Update Pi.`);
	const model = pickFastModel(provider, args.model, runtime);
	const resolved = await runtime.getAuth(model, { signal: AbortSignal.timeout(args.timeoutMs) });
	const { apiKey, baseUrl = model.baseUrl, headers: authHeaders } = resolved?.auth || {};
	if (!apiKey) {
		throw new Error(`No credentials for provider '${provider}'. Run /login ${provider} or configure its API key.`);
	}
	const headers = Object.fromEntries(Object.entries(authHeaders || {}).filter(([, value]) => value !== null));

	const search = { "openai-codex": runCodexSearch, openai: runOpenAISearch, anthropic: runAnthropicSearch }[provider];
	const text = await search({
		model: model.id,
		apiKey,
		query: args.query,
		purpose: args.purpose,
		timeoutMs: args.timeoutMs,
		baseUrl,
		headers,
	});

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					provider,
					model: model.id,
					query: args.query,
					purpose: args.purpose,
					result: text,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(`Model: ${model.id}`);
	console.log("");
	console.log(text);
}

main().catch((err) => {
	console.error(`Error: ${err?.message || err}`);
	process.exit(1);
});
