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
	/** Register a 'close' callback (fires only after stdio drains). */
	onClose(cb: (code: number | null, signal: string | null) => void): void;
	/** Register an 'error' callback (spawn failure: ENOENT, E2BIG, …). */
	onError(cb: (err: Error) => void): void;
}

export interface SpawnAgentChildOptions {
	args: string[];
	cwd: string;
	sandboxEnv: Record<string, string>;
	timeoutMs: number;
}

export function spawnAgentChild(opts: SpawnAgentChildOptions): ChildHandle {
	const child = spawn("/usr/bin/pi", opts.args, {
		cwd: opts.cwd,
		env: { ...process.env, PI_NO_COLOR: "1", ...opts.sandboxEnv },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: opts.timeoutMs,
	});

	let childExited = false;
	let killSent = false;

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
		onClose: (cb) => {
			child.on("close", cb);
		},
		onError: (cb) => {
			child.on("error", cb);
		},
	};
}
