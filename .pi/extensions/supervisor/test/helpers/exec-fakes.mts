/**
 * exec-fakes.ts — Shared `ExecFn` fakes for OSV-scanner check tests.
 *
 * The osv-scanner suites used to carry byte-identical copies of these two
 * factories in every `-partN` file (issue #2105). They live here once.
 */

import type { ExecFn } from "../../checks/shared.ts";

/** One recorded `ExecFn` invocation (`.calls` on the mock). */
export interface ExecCall {
	cmd: string;
	args: string[];
	opts?: Record<string, unknown>;
}

/** A fake `ExecFn` that also exposes the invocation log as `.calls`. */
export type MockExecFn = ExecFn & { calls: ExecCall[] };

/**
 * Scripted `ExecFn`: returns `results` in call order, then an empty success
 * result. Every invocation is appended to `calls` (created when omitted).
 */
export function createMockExec(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): MockExecFn {
	const callLog = calls || [];
	let idx = 0;
	const fn: ExecFn = async (cmd, args, opts) => {
		callLog.push({ cmd, args: args || [], opts });
		const r = results[idx] || { code: 0, stdout: "", stderr: "" };
		idx++;
		return Promise.resolve(r);
	};
	(fn as unknown as { calls: ExecCall[] }).calls = callLog;
	return fn as MockExecFn;
}

/** `ExecFn` that always rejects with `error` (same value on every call). */
export function createRejectingExec(error: unknown): ExecFn {
	return async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
		throw error;
	};
}
