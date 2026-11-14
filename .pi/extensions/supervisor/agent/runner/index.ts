// ─── Agent runner orchestrator ────────────────────────────────────
// runAgent dispatcher + runAgentSubprocess orchestrator. Subprocess
// lifecycle lives in sibling modules (args/spawn/stream/budget/cleanup/
// presenter/ui); this module is the only one that imports all of them.
//
// This file is the COMPOSITION ROOT (issue #2106): the only place that
// knows the RunPresenter port plus its ctx.ui adapter; it injects that
// presenter into the use cases.

export * from "./args.ts";
export * from "./spawn.ts";
export * from "./stream.ts";
export * from "./budget.ts";
export * from "./deadline.ts";
export * from "./cleanup.ts";
export * from "./presenter.ts";
export * from "./event-loop.ts";
export * from "./spawned-run.ts";

import type { AgentRunOptions, AgentRunResult } from "../../config/types.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../config/config.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { createAgentRunState } from "../state-helpers.ts";
import { runAgentInProcess } from "../agent-session-runner.ts";
import { spawnAgentChild } from "./spawn.ts";
import { exhaustedBeforeSpawn, prepareSubprocessRun, runSpawnedProcess } from "./spawned-run.ts";
import { createRunPresenter } from "./ui.ts";

// ─── Dispatch window — one owner for the 1× rule ─────────────────
// `timeoutMs` omitted → the configured default; `null` → no deadline.
// Both entry points resolve their bound here, so the in-process attempt has
// the same absolute deadline as its subprocess fallback.

interface DispatchWindow {
	/** Configured timeout, kept for failure reporting (`null` = no deadline). */
	timeoutMs: number | null;
	/** Absolute enforcement bound (`null` = unbounded). */
	absoluteDeadlineMs: number | null;
}

function resolveDispatchWindow(opts: AgentRunOptions, startedAt: number): DispatchWindow {
	const configured = opts.timeoutMs;
	const timeoutMs = configured === undefined ? DEFAULT_AGENT_TIMEOUT_MS : configured;
	// Hard 1× rule: `timeoutMs` is the CONFIGURED value (reporting), the deadline
	// is the enforcement budget. A caller-supplied deadline preserves the
	// ORIGINAL window on the in-process → subprocess fallback, so that fallback
	// can never restart the clock (that was the 2× stall).
	const absoluteDeadlineMs = timeoutMs === null ? null : (opts.deadlineMs ?? startedAt + timeoutMs);
	return { timeoutMs, absoluteDeadlineMs };
}

// ─── runAgent — in-process first, subprocess fallback ────────────
// Dispatcher that tries the in-process SDK runner first.
// Falls back on a thrown error / an unsuccessful result — but never after
// the wall-clock deadline fired, so the configured bound is never silently
// doubled (hard 1× rule).

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
	const startedAt = Date.now();
	const { absoluteDeadlineMs } = resolveDispatchWindow(opts, startedAt);
	// Both runners receive the SAME options object carrying the resolved
	// absolute deadline — no positional re-listing, so no argument drift.
	const dispatchOpts: AgentRunOptions = { ...opts, deadlineMs: absoluteDeadlineMs };

	try {
		// The in-process runner derives its watchdog from this ABSOLUTE deadline
		// before setup, so model resolution / tool resolution / SDK load /
		// session creation all count against the configured window; a deadline
		// already expired before entry fails immediately.
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
	const log = getDebugLogger();
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	// Pass worktree path to worktree-sandbox extension for path confinement
	const sandboxEnv: Record<string, string> = cwd ? { WORKTREE_SANDBOX_PATH: cwd } : {};
	const agentName = agent.config.name;
	const widgetId = `agent-${agentName}`;
	const model = agent.config.model || "";
	const thinkingLevel = agent.config.thinking?.trim() || undefined;
	const startedAt = Date.now();
	// Preparation (arg assembly / task-spill / mkdtemp) also counts against the
	// configured window, so the watchdog arms with the REMAINDER — never the
	// full timeout. `timeoutMs` stays the configured value for reporting
	// (audit #3); the bound itself is resolved in one place.
	const { timeoutMs, absoluteDeadlineMs } = resolveDispatchWindow(opts, startedAt);

	// Run state + presentation are built here so the guards below (which may
	// abort before spawning) can report through the same presenter.
	const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget, thinkingLevel);
	const presenter = createRunPresenter({ ctx, widgetId, agentName, model, state });

	const prepared = prepareSubprocessRun({
		agent,
		task,
		model,
		presenter,
		effectiveCwd,
		sessionPath,
		timeoutMs,
		startedAt,
	});
	if (!prepared.ok) return prepared.result;
	const { args } = prepared;

	// Preparation may itself have consumed the whole configured window (the
	// merge-conflict path calls this directly using a resolved per-agent
	// timeout). Return a structured timeout failure instead of arming a fresh
	// full window — otherwise the effective bound is preparation + T.
	if (timeoutMs !== null && absoluteDeadlineMs !== null && absoluteDeadlineMs - Date.now() <= 0) {
		return exhaustedBeforeSpawn({ presenter, state, agentName, startedAt, timeoutMs });
	}
	const remainingMs =
		absoluteDeadlineMs === null ? null : Math.max(0, absoluteDeadlineMs - Date.now());

	return runSpawnedProcess({
		args,
		effectiveCwd,
		sandboxEnv,
		presenter,
		agentName,
		state,
		spawnChild: spawnAgentChild,
		pi,
		timeoutMs,
		remainingMs,
		killGraceSec,
		startedAt,
		log,
	});
}
