// ─── Spawned-run subprocess machinery ─────────────────────────────
// Split out of runner/index.ts (issue #2005 Long File refactor). Owns the
// child-process wiring: pre-spawn setup/guards, the spawn + stdio line
// stream, the wall-clock watchdog and the close/error resolvers.
// runner/index.ts keeps runAgent (in-process-first decision) and
// runAgentSubprocess (thin orchestrator) and star-re-exports this module.

import { existsSync } from "node:fs";
import type { AgentRunResult, AgentRunState, ParsedAgent } from "../../config/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { jsonLineToNormalizedEvent, createForwardChatState } from "../../event/adapter.ts";
import { createAgentRunState } from "../state-helpers.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { getErrorCollector } from "../../pipeline/error-collector.ts";
import { handleNormalizedEvent } from "./event-loop.ts";
import { buildSubprocessArgs, warnIfArgsLarge } from "./args.ts";
import { spawnAgentChild, type ChildHandle } from "./spawn.ts";
import { createLineStream, type StreamProcessor } from "./stream.ts";
import { maybeKillOnBudgetExceeded } from "./budget.ts";
import { armDeadlineWatchdog, DEFAULT_KILL_GRACE_MS, type DeadlineWatchdog } from "./deadline.ts";
import { assembleResult, failResult, finalizeState } from "./cleanup.ts";
import { createWidgetFlusher, type WidgetFlusher } from "./ui.ts";

// ─── Spawned-run wiring ───────────────────────────────────────────
// Spawns the child, wires stdio → line handler, arms the wall-clock
// watchdog against the REMAINING dispatch budget, and resolves through
// createResolver. Extracted so runAgentSubprocess stays a flat, short
// orchestrator (size guard: span < 100).

export function runSpawnedProcess(opts: {
	args: string[];
	effectiveCwd: string;
	sandboxEnv: Record<string, string>;
	ctx: ExtensionCommandContext;
	widgetId: string;
	agentName: string;
	model: string;
	state: AgentRunState;
	pi?: Pick<ExtensionAPI, "sendMessage">;
	timeoutMs: number | null;
	remainingMs: number | null;
	killGraceSec: number | undefined;
	startedAt: number;
	log: ReturnType<typeof getDebugLogger>;
}): Promise<AgentRunResult> {
	const {
		args,
		effectiveCwd,
		sandboxEnv,
		ctx,
		widgetId,
		agentName,
		model,
		state,
		pi,
		timeoutMs,
		remainingMs,
		killGraceSec,
		startedAt,
		log,
	} = opts;

	return new Promise((resolve) => {
		const handle = spawnAgentChild({ args, cwd: effectiveCwd, sandboxEnv });

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

		// The wall-clock watchdog owns kills now (spawn's own `timeout` was
		// removed — it only SIGTERMs the direct child, orphaning grandchildren).
		// killGraceSec default = agentKillGraceSec (10s), passed by the pipeline.
		let watchdog: DeadlineWatchdog | null = null;
		const graceMs = killGraceSec === undefined ? DEFAULT_KILL_GRACE_MS : killGraceSec * 1000;

		const doResolve = createResolver({
			stream,
			widget,
			state,
			agentName,
			startedAt,
			ctx,
			widgetId,
			resolve,
			timedOutProvider: () => watchdog?.timedOut ?? false,
			killErrorProvider: () => watchdog?.killError ?? null,
			configuredTimeoutMs: timeoutMs ?? undefined,
			awaitEscalation: () => watchdog?.escalationSettled ?? Promise.resolve(),
			onCleanup: () => watchdog?.dispose(),
		});

		handle.onClose((code, signal) => doResolve(code, signal));
		handle.onError(
			createSpawnErrorHandler({
				log,
				agentName,
				widget,
				ctx,
				widgetId,
				startedAt,
				resolve,
				onCleanup: () => watchdog?.dispose(),
			}),
		);

		watchdog = armDeadlineWatchdog({
			timeoutMs: remainingMs,
			graceMs,
			target: handle,
			onForceResolve: () => doResolve(null, "SIGTERM"),
		});
	});
}

// ─── Pre-spawn setup + guards ─────────────────────────────────────
// Builds args (may throw from resolvers/mkdtempSync), warns on large
// args, creates state, and validates effectiveCwd. Returns a failure
// AgentRunResult for either guard, or the prepared run bundle.

/**
 * The configured window was fully consumed by preparation (audit finding
 * #3): return the structured timeout failure — same shape as a watchdog
 * timeout, so publisher/retry logic sees one bound — instead of spawning a
 * process that would get a fresh full window.
 */
export function exhaustedBeforeSpawn(opts: {
	ctx: ExtensionCommandContext;
	widgetId: string;
	state: AgentRunState;
	agentName: string;
	startedAt: number;
	timeoutMs: number;
}): AgentRunResult {
	opts.ctx.ui.setWidget(opts.widgetId, undefined);
	opts.ctx.ui.setWorkingMessage(undefined);
	opts.ctx.ui.setStatus("supervisor", undefined);
	return assembleResult({
		state: opts.state,
		agentName: opts.agentName,
		startedAt: opts.startedAt,
		rawStdout: "",
		stderr: "",
		code: null,
		signal: null,
		timedOut: true,
		configuredTimeoutMs: opts.timeoutMs,
	});
}

interface PreparedRun {
	ok: true;
	args: string[];
	tools: string;
	skillPaths: string[];
	model: string;
	state: AgentRunState;
}

export function prepareSubprocessRun(opts: {
	agent: ParsedAgent;
	task: string;
	ctx: ExtensionCommandContext;
	effectiveCwd: string;
	sessionPath?: string;
	timeoutMs: number | null;
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
			handleNormalizedEvent(normalized, {
				state,
				effectiveCwd,
				agentName,
				pi,
				pending,
				scheduleFlush: widget.scheduleFlush,
				ctx,
			});
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
	/** Live watchdog state — true when the wall-clock deadline fired. */
	timedOutProvider: () => boolean;
	/**
	 * Non-ESRCH group-kill failure recorded by the watchdog (audit finding #2).
	 * Read after the escalation ladder settles so a failed SIGTERM/SIGKILL is
	 * surfaced in the timeout result rather than silently reported as a clean
	 * timeout over a still-live process.
	 */
	killErrorProvider: () => string | null;
	/** Configured per-agent timeout in ms (null when "no timeout"). */
	configuredTimeoutMs: number | undefined;
	/**
	 * Resolves once the watchdog's SIGKILL escalation has been issued. Awaited
	 * (when timedOut) before teardown so the leader's 'close' cannot cancel the
	 * SIGKILL that must reach a descendant ignoring SIGTERM (audit finding #1).
	 */
	awaitEscalation: () => Promise<void>;
	/** Runs once, before the first resolve — watchdog timer teardown. */
	onCleanup: () => void;
}

function createResolver(deps: ResolverDeps): (code: number | null, signal: string | null) => void {
	const { stream, widget, state, agentName, startedAt, ctx, widgetId, resolve } = deps;
	let resolved = false;
	return (code: number | null, signal: string | null) => {
		if (resolved) return;
		resolved = true;
		const timedOut = deps.timedOutProvider();

		const finish = (): void => {
			deps.onCleanup();
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
					timedOut,
					configuredTimeoutMs: deps.configuredTimeoutMs,
					killError: deps.killErrorProvider(),
				}),
			);
		};

		// A timed-out leader's 'close' must NOT cancel the escalation ladder
		// before SIGKILL lands: the process group outlives its leader, so the
		// SIGKILL step is the only thing that reaches a descendant which ignored
		// SIGTERM and closed its inherited stdio. Wait for SIGKILL, then tear
		// the timers down (audit finding #1).
		if (timedOut) {
			void deps.awaitEscalation().then(finish);
			return;
		}
		finish();
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
	/** Watchdog teardown (armed after this handler is created). */
	onCleanup: () => void;
}): (err: Error) => void {
	const { log, agentName, widget, ctx, widgetId, startedAt, resolve } = opts;
	return (err: Error) => {
		const spawnError = `Subprocess spawn error: ${err.message}`;
		log.error("agent-runner", spawnError, { agentName });
		opts.onCleanup();
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
