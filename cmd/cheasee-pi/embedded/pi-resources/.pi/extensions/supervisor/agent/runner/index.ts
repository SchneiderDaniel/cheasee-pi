// ─── Agent runner orchestrator ────────────────────────────────────
// runAgent dispatcher + runAgentSubprocess orchestrator. Subprocess
// lifecycle lives in sibling modules (args/spawn/stream/budget/cleanup/
// ui) — dependency direction is index → sub-modules only; no sub-module
// imports another.

export * from "./args.ts";
export * from "./spawn.ts";
export * from "./stream.ts";
export * from "./budget.ts";
export * from "./cleanup.ts";
export * from "./ui.ts";

import { existsSync } from "node:fs";
import type { AgentRunResult, AgentRunState, ParsedAgent } from "../../config/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../config/config.ts";
import {
	jsonLineToNormalizedEvent,
	processNormalizedEvent,
	forwardNormalizedEventToChat,
	createForwardChatState,
} from "../../event/adapter.ts";
import { createAgentRunState } from "../state-helpers.ts";
import { getWorkingMessage } from "../../session/widget.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { getErrorCollector } from "../../pipeline/error-collector.ts";
import { runAgentInProcess } from "../agent-session-runner.ts";
import { buildSubprocessArgs, warnIfArgsLarge } from "./args.ts";
import { spawnAgentChild, type ChildHandle } from "./spawn.ts";
import { createLineStream, type StreamProcessor } from "./stream.ts";
import { maybeKillOnBudgetExceeded } from "./budget.ts";
import { assembleResult, failResult, finalizeState } from "./cleanup.ts";
import { createWidgetFlusher, type WidgetFlusher } from "./ui.ts";

// ─── runAgent — in-process first, subprocess fallback ────────────
// Dispatcher that tries the in-process SDK runner first.
// Falls back to subprocess on exception or unsuccessful result.

export async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	sessionPath?: string,
	pi?: Pick<ExtensionAPI, "sendMessage">,
): Promise<AgentRunResult> {
	try {
		const result = await runAgentInProcess(
			agent,
			task,
			ctx,
			timeoutMs,
			cwd,
			maxToolCalls,
			agentTokenBudget,
			sessionPath,
			pi,
		);
		// Fall back on unsuccessful result too
		if (!result.success) {
			console.warn(
				"[supervisor] In-process runner failed (result.success=false), falling back to subprocess",
			);
			return runAgentSubprocess(
				agent,
				task,
				ctx,
				timeoutMs,
				cwd,
				maxToolCalls,
				agentTokenBudget,
				sessionPath,
				pi,
			);
		}
		return result;
	} catch (err: unknown) {
		console.warn("[supervisor] In-process runner threw, falling back to subprocess");
		return runAgentSubprocess(
			agent,
			task,
			ctx,
			timeoutMs,
			cwd,
			maxToolCalls,
			agentTokenBudget,
			sessionPath,
			pi,
		);
	}
}

// ─── runAgentSubprocess (Fallback) ─────────────────────────────────

export async function runAgentSubprocess(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	sessionPath?: string,
	pi?: Pick<ExtensionAPI, "sendMessage">,
): Promise<AgentRunResult> {
	const log = getDebugLogger();
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	// Pass worktree path to worktree-sandbox extension for path confinement
	const sandboxEnv: Record<string, string> = cwd ? { WORKTREE_SANDBOX_PATH: cwd } : {};
	const agentName = agent.config.name;
	const widgetId = `agent-${agentName}`;
	const startedAt = Date.now();

	const prepared = prepareSubprocessRun({
		agent,
		task,
		ctx,
		effectiveCwd,
		sessionPath,
		timeoutMs,
		maxToolCalls,
		agentTokenBudget,
		startedAt,
	});
	if (!prepared.ok) return prepared.result;
	const { args, tools, skillPaths, model, state } = prepared;

	return new Promise((resolve) => {
		const handle = spawnAgentChild({ args, cwd: effectiveCwd, sandboxEnv, timeoutMs });

		log.info("agent-runner", `Subprocess spawned: ${agentName}`, { childPid: handle.child.pid });

		const widget = createWidgetFlusher({ ctx, widgetId, agentName, model, state });
		const handleLine = createLineHandler({
			state,
			effectiveCwd,
			agentName,
			pi,
			handle,
			widget,
			ctx,
		});
		const stream = createLineStream({ onLine: handleLine });

		handle.child.stdout.on("data", stream.handleStdout);
		handle.child.stderr.on("data", stream.handleStderr);

		const doResolve = createResolver({
			stream,
			widget,
			state,
			agentName,
			startedAt,
			ctx,
			widgetId,
			resolve,
		});

		handle.onClose((code, signal) => doResolve(code, signal));
		handle.onError(
			createSpawnErrorHandler({ log, agentName, widget, ctx, widgetId, startedAt, resolve }),
		);
	});
}

// ─── Pre-spawn setup + guards ─────────────────────────────────────
// Builds args (may throw from resolvers/mkdtempSync), warns on large
// args, creates state, and validates effectiveCwd. Returns a failure
// AgentRunResult for either guard, or the prepared run bundle.

interface PreparedRun {
	ok: true;
	args: string[];
	tools: string;
	skillPaths: string[];
	model: string;
	state: AgentRunState;
}

function prepareSubprocessRun(opts: {
	agent: ParsedAgent;
	task: string;
	ctx: ExtensionCommandContext;
	effectiveCwd: string;
	sessionPath?: string;
	timeoutMs: number;
	maxToolCalls?: number;
	agentTokenBudget?: number;
	startedAt: number;
}): PreparedRun | { ok: false; result: AgentRunResult } {
	const {
		agent,
		task,
		ctx,
		effectiveCwd,
		sessionPath,
		timeoutMs,
		maxToolCalls,
		agentTokenBudget,
		startedAt,
	} = opts;
	const log = getDebugLogger();
	const agentName = agent.config.name;
	const widgetId = `agent-${agentName}`;

	// ── Guard: build subprocess args (may throw from resolvers/mkdtempSync) ──
	let buildResult: { args: string[]; tools: string; skillPaths: string[]; toolSpillDir?: string };
	try {
		buildResult = buildSubprocessArgs(agent, task, effectiveCwd, sessionPath);
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		log.error("agent-runner", `Subprocess setup failed: ${errMsg}`, { agentName });
		return {
			ok: false,
			result: failWithUiCleanup(ctx, widgetId, {
				agentName,
				startedAt,
				errorMessage: errMsg,
				output: errMsg,
				summaryLine: `Subprocess setup failed: ${errMsg}`,
			}),
		};
	}

	const { args, tools, skillPaths } = buildResult;
	const model = agent.config.model || "";

	// Warn if task is large enough to risk ARG_MAX (Linux default: 2MB)
	const argChars = warnIfArgsLarge(args, agentName);

	log.info("agent-runner", `runAgentSubprocess: ${agentName}`, {
		effectiveCwd,
		model,
		timeoutMs,
		tools,
		skillCount: skillPaths.length,
		taskLen: task.length,
		argChars,
	});

	ctx.ui.notify(`Running agent: ${agentName}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

	const thinkingLevel = agent.config.thinking?.trim() || undefined;
	const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget, thinkingLevel);

	log.info("agent-runner", `Subprocess spawn: ${agentName}`, {
		pid: process.pid,
		startedAt,
	});

	// Guard: validate effectiveCwd exists before spawn.
	// Node's spawn returns misleading ENOENT when cwd doesn't exist
	// (same error code as missing binary). Check explicitly.
	if (!existsSync(effectiveCwd)) {
		const spawnError = `cwd does not exist: ${effectiveCwd}`;
		log.error("agent-runner", spawnError, { agentName });
		return {
			ok: false,
			result: failWithUiCleanup(ctx, widgetId, {
				agentName,
				startedAt,
				errorMessage: spawnError,
				output: spawnError,
				summaryLine: `Worktree missing: ${effectiveCwd}`,
			}),
		};
	}

	return { ok: true, args, tools, skillPaths, model, state };
}

/** Shared guard-failure path: clear UI, then assemble the failure result. */
function failWithUiCleanup(
	ctx: ExtensionCommandContext,
	widgetId: string,
	opts: {
		agentName: string;
		startedAt: number;
		errorMessage: string;
		summaryLine: string;
		output: string;
	},
): AgentRunResult {
	ctx.ui.setWidget(widgetId, undefined);
	ctx.ui.setWorkingMessage(undefined);
	ctx.ui.setStatus("supervisor", undefined);
	return failResult(opts);
}

// ─── Event line handler factory ───────────────────────────────────
// Per-run closure: parse → normalize → process → forward → budget-kill.
// Try-catch prevents uncaught exceptions from breaking the JSON stream
// processing.

interface LineHandlerDeps {
	state: AgentRunState;
	effectiveCwd: string;
	agentName: string;
	pi?: Pick<ExtensionAPI, "sendMessage">;
	handle: ChildHandle;
	widget: WidgetFlusher;
	ctx: ExtensionCommandContext;
}

function createLineHandler(deps: LineHandlerDeps): (line: string) => void {
	const { state, effectiveCwd, agentName, pi, handle, widget, ctx } = deps;
	const pending = createForwardChatState();
	return (line: string) => {
		try {
			if (!line.trim()) return;
			const normalized = jsonLineToNormalizedEvent(line);
			if (!normalized) return;
			// ponytail: capture pre-processing state for events that mutate it.
			// processNormalizedEvent clears state.liveThinking on thinking_end,
			// so we save it before forwarding below.
			const preThinkingText = normalized.kind === "thinking_end" ? state.liveThinking.trim() : "";
			const result = processNormalizedEvent(normalized, state, effectiveCwd);
			if (result.workingChange) {
				widget.scheduleFlush();
				const wm = getWorkingMessage(state, agentName);
				ctx.ui.setWorkingMessage(wm ?? undefined);
			}
			// Forward key events as supervisor chat messages
			if (pi) {
				forwardNormalizedEventToChat(
					normalized,
					state,
					pi,
					agentName,
					pending,
					preThinkingText,
					effectiveCwd,
				);
			}
			// Budget exceeded — kill subprocess to prevent further turns
			maybeKillOnBudgetExceeded(state, handle);
		} catch (parseErr: unknown) {
			const preview = line.length > 200 ? line.slice(0, 200) + "…" : line;
			const errMsg = String(parseErr).slice(0, 200);
			getDebugLogger().warn("agent-stream", `JSON parse error: ${errMsg}`, { preview });
			if (line.trim()) {
				getErrorCollector().push("stream", "warn", `JSON parse error: ${errMsg}`);
			}
		}
	};
}

// ─── Close resolver factory ───────────────────────────────────────
// 'exit' reaps the process table entry (prevents zombie, childExited=
// true); 'close' fires after stdio drains — resolve here with the
// actual code/signal. resolved flag prevents double-resolve (both
// 'close' and a late 'error' can surface).

interface ResolverDeps {
	stream: StreamProcessor;
	widget: WidgetFlusher;
	state: AgentRunState;
	agentName: string;
	startedAt: number;
	ctx: ExtensionCommandContext;
	widgetId: string;
	resolve: (result: AgentRunResult) => void;
}

function createResolver(deps: ResolverDeps): (code: number | null, signal: string | null) => void {
	const { stream, widget, state, agentName, startedAt, ctx, widgetId, resolve } = deps;
	let resolved = false;
	return (code: number | null, signal: string | null) => {
		if (resolved) return;
		resolved = true;

		stream.flush();
		widget.dispose();
		finalizeState(state);

		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", undefined);

		resolve(
			assembleResult({
				state,
				agentName,
				startedAt,
				rawStdout: stream.rawStdout,
				stderr: stream.stderr,
				code,
				signal,
			}),
		);
	};
}

// ─── Spawn error handler factory ──────────────────────────────────
// Spawn failures (ENOENT, E2BIG, …) surface via 'error'; the widget is
// torn down and the promise resolves with a failure result.

function createSpawnErrorHandler(opts: {
	log: ReturnType<typeof getDebugLogger>;
	agentName: string;
	widget: WidgetFlusher;
	ctx: ExtensionCommandContext;
	widgetId: string;
	startedAt: number;
	resolve: (result: AgentRunResult) => void;
}): (err: Error) => void {
	const { log, agentName, widget, ctx, widgetId, startedAt, resolve } = opts;
	return (err: Error) => {
		const spawnError = `Subprocess spawn error: ${err.message}`;
		log.error("agent-runner", spawnError, { agentName });
		widget.dispose();
		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", undefined);
		resolve(
			failResult({
				agentName,
				startedAt,
				errorMessage: err.message,
				output: `Failed to start pi: ${err.message}`,
				summaryLine: `Failed to start: ${err.message}`,
			}),
		);
	};
}
