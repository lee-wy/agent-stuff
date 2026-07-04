import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_KEY = "usage";
const AUTH_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 15_000;
const LIVE_REFRESH_INTERVAL_MS = 60_000;
const ERROR_RETRY_COOLDOWN_MS = 2 * 60_000;

interface AuthEntry {
  access?: string;
  accountId?: string;
}

interface RawWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

interface RawRateLimit {
  primary_window?: RawWindow | null;
  secondary_window?: RawWindow | null;
}

interface RawUsageResponse {
  rate_limit?: RawRateLimit | null;
}

interface UsageWindow {
  label: string;
  usedPercent: number;
  resetAt: number;
}

interface UsageSnapshot {
  fetchedAt: number;
  windows: UsageWindow[];
}

interface ViewState {
  snapshot?: UsageSnapshot;
  error?: string;
  stale: boolean;
  lastAttemptAt: number;
}

interface RefreshOptions {
  force?: boolean;
}

function getAuthPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "auth.json");
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return "<1m";

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

function secondsUntilReset(window: UsageWindow, now = Date.now()): number {
  return Math.max(0, Math.ceil(window.resetAt - now / 1000));
}

function labelWindow(limitWindowSeconds: number, fallback: string): string {
  if (limitWindowSeconds === 18_000) return "5h";
  if (limitWindowSeconds === 604_800) return "7d";
  if (limitWindowSeconds % 86_400 === 0) return `${limitWindowSeconds / 86_400}d`;
  if (limitWindowSeconds % 3_600 === 0) return `${limitWindowSeconds / 3_600}h`;
  return fallback;
}

function toWindow(raw: RawWindow | null | undefined, fallback: string): UsageWindow | null {
  if (!raw) return null;

  const usedPercent = typeof raw.used_percent === "number" ? clampPercent(raw.used_percent) : undefined;
  const resetAt = typeof raw.reset_at === "number" ? raw.reset_at : undefined;
  const limitWindowSeconds = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : undefined;

  if (usedPercent === undefined || resetAt === undefined || limitWindowSeconds === undefined) {
    return null;
  }

  return {
    label: labelWindow(limitWindowSeconds, fallback),
    usedPercent,
    resetAt,
  };
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

function buildStatusSummary(state: ViewState): { text?: string; level: "dim" | "warning" } {
  if (!state.snapshot && !state.error) {
    return { text: undefined, level: "dim" };
  }

  if (!state.snapshot && state.error) {
    return { text: `usage unavailable: ${state.error}`, level: "warning" };
  }

  const text =
    state.snapshot!.windows
      .map((window) => `${window.label} ${window.usedPercent}% used/${formatDuration(secondsUntilReset(window))}`)
      .join(" • ") || "unavailable";
  if (state.stale) {
    return { text: `${text} (stale)`, level: "warning" };
  }
  return { text, level: "dim" };
}

function renderStatus(ctx: ExtensionContext, state: ViewState): void {
  if (!ctx.hasUI) return;

  const summary = buildStatusSummary(state);
  if (!summary.text) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(summary.level, summary.text));
}

async function readAuth(): Promise<AuthEntry> {
  const raw = await readFile(getAuthPath(), "utf8");
  const parsed = JSON.parse(raw) as Record<string, AuthEntry | undefined>;
  const auth = parsed[AUTH_PROVIDER];

  if (!auth?.access) {
    throw new Error(`No ${AUTH_PROVIDER} login found in ${getAuthPath()}. Run /login and choose Codex.`);
  }

  return auth;
}

async function fetchUsage(signal?: AbortSignal): Promise<UsageSnapshot> {
  const auth = await readAuth();
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      Accept: "application/json",
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
    },
    signal: fetchSignal,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Auth expired (${response.status}). Run /login and re-authenticate Codex.`);
    }
    throw new Error(`Usage endpoint returned ${response.status} ${response.statusText}`.trim());
  }

  const raw = (await response.json()) as RawUsageResponse;
  const rateLimit = raw.rate_limit ?? {};
  const windows = [
    toWindow(rateLimit.primary_window, "primary"),
    toWindow(rateLimit.secondary_window, "secondary"),
  ].filter((window): window is UsageWindow => window !== null);

  if (windows.length === 0) {
    throw new Error("No usage windows returned.");
  }

  return {
    fetchedAt: Date.now(),
    windows,
  };
}

export default function usageExtension(pi: ExtensionAPI): void {
  let state: ViewState = { stale: false, lastAttemptAt: 0 };
  let active = false;
  let generation = 0;
  let refreshRunId = 0;
  let currentContext: ExtensionContext | null = null;
  let refreshPromise: Promise<void> | null = null;
  let refreshController: AbortController | null = null;
  let liveTimer: ReturnType<typeof setInterval> | null = null;

  function stopLiveTimer(): void {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  function startLiveTimer(ctx: ExtensionContext): void {
    if (!active || !ctx.hasUI || liveTimer) return;

    liveTimer = setInterval(() => {
      if (!active || !currentContext) {
        stopLiveTimer();
        return;
      }
      renderStatus(currentContext, state);
      refreshInBackground(currentContext);
    }, LIVE_REFRESH_INTERVAL_MS);
    if (typeof liveTimer === "object" && "unref" in liveTimer && typeof liveTimer.unref === "function") {
      liveTimer.unref();
    }
  }

  function applyUI(ctx: ExtensionContext): void {
    if (!active) return;

    renderStatus(ctx, state);
  }

  async function refresh(ctx: ExtensionContext, options: RefreshOptions = {}): Promise<void> {
    if (!active) return;

    currentContext = ctx;

    if (refreshPromise) {
      await refreshPromise;
      return;
    }

    if (!options.force && state.error !== undefined && Date.now() - state.lastAttemptAt < ERROR_RETRY_COOLDOWN_MS) {
      applyUI(ctx);
      return;
    }

    const controller = new AbortController();
    const refreshGeneration = generation;
    const runId = ++refreshRunId;
    refreshController = controller;

    const promise = (async () => {
      await Promise.resolve();
      try {
        if (!active || refreshGeneration !== generation) return;

        state = { ...state, lastAttemptAt: Date.now() };
        applyUI(ctx);

        let nextState: ViewState;
        try {
          nextState = {
            snapshot: await fetchUsage(controller.signal),
            stale: false,
            error: undefined,
            lastAttemptAt: Date.now(),
          };
        } catch (error) {
          nextState = {
            ...state,
            error: normalizeError(error),
            stale: state.snapshot !== undefined,
            lastAttemptAt: Date.now(),
          };
        }

        if (!active || !currentContext || refreshGeneration !== generation) return;

        state = nextState;
        applyUI(currentContext);
      } finally {
        if (refreshRunId === runId) refreshPromise = null;
        if (refreshController === controller) refreshController = null;
      }
    })();

    refreshPromise = promise;
    await promise;
  }

  function refreshInBackground(ctx: ExtensionContext, options: RefreshOptions = {}): void {
    void refresh(ctx, options).catch((error) => {
      if (!active || !ctx.hasUI) return;
      try {
        ctx.ui.notify(`Usage refresh failed: ${normalizeError(error)}`, "warning");
      } catch {
        // Ignore UI errors from background refreshes.
      }
    });
  }

  pi.registerCommand("usage", {
    description: "Refresh Codex usage",
    handler: async (_args, ctx) => {
      currentContext = ctx;
      await refresh(ctx, { force: true });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    active = true;
    generation++;
    currentContext = ctx;
    if (!ctx.hasUI) return;
    applyUI(ctx);
    startLiveTimer(ctx);
    refreshInBackground(ctx, { force: true });
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentContext = ctx;
    refreshInBackground(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    generation++;
    refreshRunId++;
    currentContext = null;
    refreshPromise = null;
    refreshController?.abort();
    refreshController = null;
    stopLiveTimer();
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
