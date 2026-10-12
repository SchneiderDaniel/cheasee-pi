/**
 * port-adapters.ts — Adapters that normalize a vendor exec surface to the
 * canonical `ExecFn` port.
 *
 * Layer: adapter — owns the only `pi.exec`-shaped binding; `port-types.ts`
 * stays pure types. `withPerChildEnv` (lib/exec-env.ts) composes on top when
 * a caller needs per-child env vars.
 */

import type { ExecFn } from "./port-types.ts";

/** Vendor exec surface (`pi.exec`-shaped). Extra result fields are ignored. */
export type ExecLike = (
	cmd: string,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Bind any exec surface to the canonical 3-field `ExecFn` port. */
export function toExecFn(exec: ExecLike): ExecFn {
	return async (cmd, args, opts) => {
		const result = await exec(cmd, args, opts);
		// Normalize to exactly the 3-field port result (`pi.exec` also carries
		// `killed`, which no supervisor caller reads).
		return { code: result.code, stdout: result.stdout, stderr: result.stderr };
	};
}
