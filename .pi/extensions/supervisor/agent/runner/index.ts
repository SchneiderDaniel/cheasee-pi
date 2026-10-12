// ─── Agent runner orchestrator ────────────────────────────────────
// runAgent dispatcher + runAgentSubprocess orchestrator. Subprocess
// lifecycle lives in sibling modules (args/spawn/stream/budget/cleanup/
// ui) — dependency direction is index → sub-modules only; no sub-module
// imports another.

export * from "./args.ts";
export * from "./spawn.ts";
export * from "./stream.ts";
export * from "./budget.ts";
export * from "./deadline.ts";
export * from "./cleanup.ts";
export * from "./ui.ts";
export * from "./event-loop.ts";
export * from "./spawned-run.ts";

import type { AgentRunOptions, AgentRunResult } from "../../config/types.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../config/config.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { runAgentInProcess } from "../agent-session-runner.ts";
import { exhaustedBeforeSpawn, prepareSubprocessRun, runSpawnedProcess } from "./spawned-run.ts";

// ─── runAgent — in-process first, subprocess fallback ────────────
// Dispatcher that tries the in-process SDK runner first.
// Falls back to subprocess on exception or unsuccessful result — except
// when the wall-clock deadline already fired, so the configured bound is
// never silently doubled by the fallback (hard 1× rule).

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
	const startedAt = Date.now();
	const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_AGENT_TIMEOUT_MS : opts.timeoutMs;
	// Hard 1× bound: both the in-process attempt and the subprocess fallback
	// share ONE absolute deadline. `timeoutMs` is the CONFIGURED timeout (kept
	// for reporting); the deadline is the enforcement budget, so the fallback
	// can never restart the clock (that was the 2× stall).
	const absoluteDeadlineMs = timeoutMs === null ? null : (opts.deadlineMs ?? startedAt + timeoutMs);
	// Both runners receive the SAME options object (with the resolved absolute
	// deadline) — no positional re-listing, so no silent argument drift.
	const dispatchOpts: AgentRunOptions = { ...opts, deadlineMs: absoluteDeadlineMs };

	try {
		// The in-process runner derives its watchdog from this ABSOLUTE deadline
		// and arms it before setup, so model resolution / tool resolution / SDK
		// load / session creation all count against the configured window, and a
		// deadline already expired before entry fails immediately.
		const result = await runAgentInProcess(dispatchOpts);
		// Timeout is terminal: the wall-clock bound already fired in-process.
		// Returning the timeout result WITHOUT falling back keeps the bound at 1×.
		if (result.timedOut) {
			return result;
		}
		// Fall back on unsuccessful result too
		if (!result.success) {
			console.warn(
				"[supervisor] In-process runner failed (result.success=false), falling back to subprocess",
			);
			return runAgentSubprocess(dispatchOpts);
		}
		return result;
	} catch (err: unknown) {
		console.warn("[supervisor] In-process runner threw, falling back to subprocess");
		// The deadline can legitimately be exhausted here (throw at/after the
		// bound): runAgentSubprocess returns the structured timeout failure
		// instead of arming a fresh window — still a single dispatch.
		return runAgentSubprocess(dispatchOpts);
	}
}

// ─── runAgentSubprocess (Fallback) ─────────────────────────────────

export async function runAgentSubprocess(opts: AgentRunOptions): Promise<AgentRunResult> {
	const { agent, task, ctx, cwd, maxToolCalls, agentTokenBudget, sessionPath, pi, killGraceSec } =
		opts;
	// timeoutMs: omitted → configured default; null → no deadline.
	const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_AGENT_TIMEOUT_MS : opts.timeoutMs;
	const deadlineMs = opts.deadlineMs;
	const log = getDebugLogger();
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	// Pass worktree path to worktree-sandbox extension for path confinement
	const sandboxEnv: Record<string, string> = cwd ? { WORKTREE_SANDBOX_PATH: cwd } : {};
	const agentName = agent.config.name;
	const widgetId = `agent-${agentName}`;
	const startedAt = Date.now();
	// Absolute dispatch deadline: preparation (arg assembly / task-spill /
	// mkdtemp) also counts against the configured window, so the watchdog
	// arms with the REMAINDER, not the full timeout. A caller-supplied deadline
	// preserves the ORIGINAL window when this runs as the in-process fallback;
	// `timeoutMs` stays the configured value for failure reporting (audit #3).
	const absoluteDeadlineMs = timeoutMs === null ? null : (deadlineMs ?? startedAt + timeoutMs);

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

	// Preparation may itself have consumed the whole configured window (the
	// merge-conflict path calls this directly with a resolved per-agent
	// timeout). Return a structured timeout failure instead of arming a fresh
	// full window — otherwise the effective bound is preparation + T.
	if (timeoutMs !== null && absoluteDeadlineMs !== null && absoluteDeadlineMs - Date.now() <= 0) {
		return exhaustedBeforeSpawn({ ctx, widgetId, state, agentName, startedAt, timeoutMs });
	}
	const remainingMs =
		absoluteDeadlineMs === null ? null : Math.max(0, absoluteDeadlineMs - Date.now());

	return runSpawnedProcess({
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
	});
}
