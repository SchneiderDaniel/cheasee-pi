// ─── Subprocess spawn + stdio wiring ──────────────────────────────
// The ONLY module in runner/ that imports node:child_process — the
// test harness intercepts `spawn` at module load via mock.module, so
// this import must stay exclusive to this file.

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface ChildHandle {
	/** Typed for stdio: ["ignore", "pipe", "pipe"] — stdout/stderr are non-null. */
	child: ChildProcessByStdio<null, Readable, Readable>;
	/** Set once 'exit' or 'close' fires — guards budget/timeout kill. */
	readonly childExited: boolean;
	/** Idempotent kill — sends the signal at most once per handle. */
	kill(sig: NodeJS.Signals): void;
	/**
	 * Kill the whole process group (detached session leader + descendants).
	 * NOT gated on childExited: on Linux the process group outlives its
	 * leader, so kill(-pid) must still reach descendants after the leader
	 * exited (a SIGTERM'd pi whose opencode-go descendant ignores SIGTERM
	 * must still get the SIGKILL escalation — audit finding #1). Idempotent
	 * per signal: a repeated signal is a no-op, so the watchdog's SIGTERM →
	 * grace → SIGKILL escalation ladder can step through signals.
	 */
	killGroup(sig: NodeJS.Signals): void;
	/** Register a 'close' callback (fires only after stdio drains). */
	onClose(cb: (code: number | null, signal: string | null) => void): void;
	/** Register an 'error' callback (spawn failure: ENOENT, E2BIG, …). */
	onError(cb: (err: Error) => void): void;
}

export interface SpawnAgentChildOptions {
	args: string[];
	cwd: string;
	sandboxEnv: Record<string, string>;
}

export function spawnAgentChild(opts: SpawnAgentChildOptions): ChildHandle {
	// detached: true makes /usr/bin/pi a session/process-group leader on
	// Linux, so the timeout watchdog can kill the WHOLE group via
	// process.kill(-pid). Killing only the direct child (spawn's own
	// `timeout` option does exactly that) orphans opencode-go/provider
	// grandchildren, and a grandchild holding the piped stdout keeps
	// 'close' from ever firing — the "stuck run" symptom this timeout
	// feature exists to bound. Trade-off: the detached child survives an
	// unchecked parent crash; the container dies as a unit anyway.
	const child = spawn("/usr/bin/pi", opts.args, {
		cwd: opts.cwd,
		env: { ...process.env, PI_NO_COLOR: "1", ...opts.sandboxEnv },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	let childExited = false;
	let killSent = false;
	let lastGroupSignal: NodeJS.Signals | null = null;

	// ── Bug 3 fix: Proper child reaping ──
	// 'exit' reaps the process table entry (zombie prevention) but does
	// NOT resolve — stdio streams may still be open when 'exit' fires,
	// and a trailing unterminated JSON line would be dropped. Resolution
	// happens on 'close', which fires only after stdio drains.
	child.on("exit", () => {
		childExited = true;
	});

	child.on("close", () => {
		childExited = true;
	});

	return {
		child,
		get childExited() {
			return childExited;
		},
		kill: (sig) => {
			if (killSent || childExited) return;
			killSent = true;
			child.kill(sig);
		},
		killGroup: (sig) => {
			// Deliberately NOT gated on childExited: the leader's exit does not
			// dissolve the process group — remaining members keep the pgid, so
			// kill(-pid) still reaches them. Decoupling escalation from leader
			// reaping is what bounds the "leader exits, descendant ignores
			// SIGTERM" orphan case: the watchdog's SIGKILL step must still fire.
			if (sig === lastGroupSignal) return; // idempotent per signal
			lastGroupSignal = sig;
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, sig);
			} catch (err: unknown) {
				// ESRCH: the WHOLE group exited (leader AND descendants) —
				// nothing left to signal.
				if ((err as NodeJS.ErrnoException).code === "ESRCH") childExited = true;
			}
		},
		onClose: (cb) => {
			child.on("close", cb);
		},
		onError: (cb) => {
			child.on("error", cb);
		},
	};
}
