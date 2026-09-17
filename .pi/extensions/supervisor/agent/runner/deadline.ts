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
	/**
	 * Non-ESRCH group-kill failure from the escalation ladder (e.g. EPERM),
	 * formatted as `<SIG> failed: <code>`. Null when every kill was delivered
	 * or the process group was already gone. Surfaced in the timeout result so
	 * a failed cleanup is a visible terminal error, not a silent clean timeout
	 * (audit finding #2).
	 */
	readonly killError: string | null;
	/**
	 * Resolves once the escalation ladder has issued SIGKILL (or immediately
	 * when no deadline was armed / the deadline never fired). A resolver that
	 * observes `timedOut` MUST await this before calling `dispose()`, so the
	 * leader's 'close' cannot cancel the SIGKILL that reaches a descendant
	 * which ignored SIGTERM (audit finding #1: group outlives its leader).
	 */
	readonly escalationSettled: Promise<void>;
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
		return {
			timedOut: false,
			killError: null,
			escalationSettled: Promise.resolve(),
			dispose: () => {},
		};
	}
	let timedOut = false;
	let disposed = false;
	let killError: string | null = null;
	let escalationSettledFlag = false;
	let resolveEscalation!: () => void;
	const escalationSettled = new Promise<void>((r) => {
		resolveEscalation = r;
	});
	const settleEscalation = (): void => {
		if (escalationSettledFlag) return;
		escalationSettledFlag = true;
		resolveEscalation();
	};
	let termTimer: NodeJS.Timeout | null = null;
	let killTimer: NodeJS.Timeout | null = null;
	let forceTimer: NodeJS.Timeout | null = null;

	const dispose = (): void => {
		disposed = true;
		if (termTimer) clearTimeout(termTimer);
		if (killTimer) clearTimeout(killTimer);
		if (forceTimer) clearTimeout(forceTimer);
		termTimer = killTimer = forceTimer = null;
		// Safety valve: never leave an awaiter hanging if dispose wins the race.
		settleEscalation();
	};

	/** Record a non-ESRCH group-kill failure (first one wins). */
	const noteKillError = (sig: NodeJS.Signals, err: NodeJS.ErrnoException | null): void => {
		if (!err || killError) return;
		killError = `${sig} failed: ${err.code ?? err.message}`;
	};

	termTimer = setTimeout(() => {
		if (disposed) {
			settleEscalation();
			return;
		}
		timedOut = true;
		noteKillError("SIGTERM", target.killGroup("SIGTERM"));
		killTimer = setTimeout(() => {
			if (disposed) {
				settleEscalation();
				return;
			}
			noteKillError("SIGKILL", target.killGroup("SIGKILL"));
			// SIGKILL is the terminal step — a resolver may now safely dispose.
			settleEscalation();
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
		get killError() {
			return killError;
		},
		escalationSettled,
		dispose,
	};
}