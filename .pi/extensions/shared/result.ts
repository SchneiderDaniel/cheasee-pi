// ─── Result<T> + exec helpers (shared) ────────────────────────────
// Extracted from supervisor/pipeline/result.ts (issue #2138) so the goal-loop
// extension and the Supervisor share ONE error-as-value contract. The
// Supervisor module re-exports this file, so every existing import path keeps
// working while there is exactly one definition.
//
// `NotifyFn` moved here too: `withNotify` needs it, and importing it from
// Supervisor's helpers.ts would make this shared module depend on a concrete
// extension. Supervisor's helpers.ts re-exports it instead.

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

/**
 * Minimal notification port. Supervisor's `NotifyFn` is this type; the
 * goal-loop builds one from `ctx.ui.notify`.
 */
export interface NotifyFn {
	info: (msg: string) => void;
	error: (msg: string) => void;
}

/**
 * Structural shape `toNotifyFn` needs: a UI-bearing context satisfies it
 * without importing any pi type.
 */
export interface NotifyTarget {
	hasUI: boolean;
	notify: (msg: string, level: "info" | "error") => void;
}

/**
 * Result<T, E> — discriminated union representing success or failure.
 *
 * - `{ ok: true; value: T }` — operation succeeded
 * - `{ ok: false; error: E; source: string }` — operation failed
 */
export type Result<T, E = string> =
	{ ok: true; value: T } | { ok: false; error: E; source: string };

/** A NotifyFn whose calls are deliberately dropped (no UI / rejected work). */
export function nullNotify(): NotifyFn {
	return { info: () => {}, error: () => {} };
}

/**
 * Adapt a UI-bearing context to the NotifyFn port. The `hasUI` gate mirrors
 * `ctx.ui.notify`'s fire-and-forget behaviour, which silently drops without a
 * UI.
 */
export function toNotifyFn(target: NotifyTarget): NotifyFn {
	return {
		info: (msg) => {
			if (target.hasUI) target.notify(msg, "info");
		},
		error: (msg) => {
			if (target.hasUI) target.notify(msg, "error");
		},
	};
}

/** Build a `Result` failure with a single spelling. */
export function failure<T>(error: string, source: string): Result<T> {
	return { ok: false, error, source };
}

/**
 * Normalize the pi.exec contract: it resolves `{code}` even on a non-zero
 * exit — it never rejects. Some mocks/tests reject instead. Normalize both
 * contracts so callers can check `.code` unconditionally; a silent success
 * lets a failed command pass as ok.
 */
export async function execChecked(
	pi: { exec: (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult> },
	cmd: string,
	args: string[],
	opts?: ExecOptions,
): Promise<ExecResult> {
	try {
		return await pi.exec(cmd, args, opts);
	} catch (err: unknown) {
		return {
			code: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			killed: false,
		};
	}
}

/**
 * Wraps an async function with a try-catch that converts thrown errors into a
 * Result<T>. On failure, calls `notify.error()` for real-time visibility, then
 * returns `{ ok: false, error, source }`.
 */
export async function withNotify<T>(
	fn: () => Promise<T>,
	notify: NotifyFn,
	source: string,
): Promise<Result<T>> {
	try {
		const value = await fn();
		return { ok: true, value };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		notify.error(`[${source}] ${msg}`);
		return { ok: false, error: msg, source };
	}
}
