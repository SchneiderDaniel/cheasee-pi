/**
 * port-types.ts — Canonical cross-extension port types.
 *
 * Single home for structural types shared by multiple extensions:
 *  - ExecResult / ExecFn   (subprocess execution, unified 3-field return)
 *  - OnUpdateCallback      (progress-report callback)
 *
 * Every extension that needs one of these shapes should import from here
 * instead of defining a local copy.  The one exception is an extension
 * whose type has deliberately diverged — keep the local copy and add
 * a `// Diverges from lib/port-types.ExecFn: <reason>` comment so the
 * next dedup attempt doesn't re-investigate.
 *
 * Layer: domain — zero pi dependencies.  Pure types only.
 */

/** 3-field subprocess result (code / stdout / stderr). */
export type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

/**
 * Subprocess exec function (no killed/signal fields — those are divergence-only).
 *
 * opts.cwd is the only addition over the narrowest (web-search/ensureVenv) shape
 * and is what supervisor/checks callers already pass.
 */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number; signal?: AbortSignal; cwd?: string },
) => Promise<ExecResult>;

/** Structured progress callback. */
export type OnUpdateCallback = (
	u: { content: Array<{ type: "text"; text: string }>; details: unknown },
) => void;
