// ─── Result<T> Type ──────────────────────────────────────────────
// Discriminated union for modeling errors as values.
// withNotify wraps an async function, calls notify.error() on failure,
// and returns a Result<T> so callers must check .ok.

import type { NotifyFn } from "./helpers.ts";

/**
 * Result<T, E> — discriminated union representing success or failure.
 *
 * - `{ ok: true; value: T }` — operation succeeded
 * - `{ ok: false; error: E; source: string }` — operation failed
 *
 * TypeScript narrows the union based on the `ok` discriminant:
 * ```
 * const r: Result<number> = ...;
 * if (r.ok) {
 *   // r is { ok: true; value: number }
 *   console.log(r.value);
 * } else {
 *   // r is { ok: false; error: string; source: string }
 *   console.error(r.error);
 * }
 * ```
 */
export type Result<T, E = string> =
	| { ok: true; value: T }
	| { ok: false; error: E; source: string };

/**
 * Wraps an async function with a try-catch that converts thrown errors
 * into a Result<T>. On failure, calls `notify.error()` for real-time
 * visibility, then returns `{ ok: false, error, source }` so the caller
 * can batch-render via ErrorCollector.
 *
 * @param fn - Async function whose thrown errors are caught
 * @param notify - Notification callbacks for real-time error visibility
 * @param source - Source identifier for the error (e.g. "worktree", "git")
 * @returns Promise<Result<T>> — ok=true with value, or ok=false with error
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
