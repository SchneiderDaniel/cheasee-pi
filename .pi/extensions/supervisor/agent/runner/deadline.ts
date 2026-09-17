// ─── Wall-clock deadline watchdog ─────────────────────────────────
// Per-run watchdog: arms a single deadline per dispatch, escalates
// SIGTERM → grace → SIGKILL against the CHILD PROCESS GROUP (killGroup),
// and bounds the escape window with a force-resolve timer. Mirrors the
// budget.ts module shape: kill policy lives in the runner, no pipeline
// imports. Kill syscalls stay behind spawn.ts (module-mock intercept).

import type { ChildHandle } from "./spawn.ts";

/** Default SIGTERM → SIGKILL grace (agentKillGraceSec default 10s). */
export const DEFAULT_KILL_GRACE_MS = 10_000;

export interface DeadlineWatchdog {
	/** Whether the deadline fired (terminal — result classifies "timeout"). */
	readonly timedOut: boolean;
	/** Cancel all pending timers — call when the child closes. Idempotent. */
	dispose(): void;
}

/**
 * Arm the per-run wall-clock watchdog. When `timeoutMs` (the remaining
 * budget from the dispatch deadline) elapses: killGroup("SIGTERM"), then
 * killGroup("SIGKILL") after `graceMs` (K8s-style escalation), then
 * `onForceResolve()` after a further `graceMs` — the force step converts
 * an unkillable grandchild-held pipe (setsid escape) into a bounded
 * timeout failure instead of an infinite hang.
 *
 * `timeoutMs = null` → no watchdog (configured "0 = no timeout"): no
 * timers, no kills ever.
 */
export function armDeadlineWatchdog(opts: {
	timeoutMs: number | null;
	graceMs: number;
	target: Pick<ChildHandle, "killGroup">;
	onForceResolve: () => void;
}): DeadlineWatchdog {
	const { timeoutMs, graceMs, target, onForceResolve } = opts;
	if (timeoutMs === null) {
		return { timedOut: false, dispose: () => {} };
	}
	let timedOut = false;
	let disposed = false;
	let termTimer: NodeJS.Timeout | null = null;
	let killTimer: NodeJS.Timeout | null = null;
	let forceTimer: NodeJS.Timeout | null = null;

	const dispose = (): void => {
		disposed = true;
		if (termTimer) clearTimeout(termTimer);
		if (killTimer) clearTimeout(killTimer);
		if (forceTimer) clearTimeout(forceTimer);
		termTimer = killTimer = forceTimer = null;
	};

	termTimer = setTimeout(() => {
		if (disposed) return;
		timedOut = true;
		target.killGroup("SIGTERM");
		killTimer = setTimeout(() => {
			if (disposed) return;
			target.killGroup("SIGKILL");
			forceTimer = setTimeout(() => {
				if (disposed) return;
				onForceResolve();
			}, graceMs);
		}, graceMs);
	}, timeoutMs);

	return {
		get timedOut() {
			return timedOut;
		},
		dispose,
	};
}