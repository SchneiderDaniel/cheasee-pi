// ─── ExecFn adapter: per-child environment ────────────────────────
// pi.exec's ExecOptions has no `env` field, so a caller that must scope a
// secret to one child (GH_TOKEN for `gh`) would have to write it to
// `process.env` — where every concurrently spawned process inherits it.
// This adapter owns the per-child env merge and nothing else: the child is
// created through `spawnArgv`, so argv validity, `shell:false` and the env
// execution-channel policy are enforced once, in lib/safe-argv.ts, instead of
// being re-decided by every adapter that spawns its own child.

import { type ChildProcess, spawn } from "node:child_process";
import { spawnArgv } from "./safe-argv.ts";
import type { ExecFn } from "./port-types.ts";

export function withPerChildEnv(base: ExecFn): ExecFn {
	return (cmd, args, opts) => {
		if (!opts?.env) return base(cmd, args, opts);
		return new Promise((resolve) => {
			let child: ChildProcess;
			try {
				child = spawnArgv(
					spawn as (program: string, args: readonly string[], options?: object) => unknown,
					cmd,
					args,
					{
						cwd: opts.cwd,
						env: { ...process.env, ...opts.env },
						stdio: ["ignore", "pipe", "pipe"],
					},
				) as ChildProcess;
			} catch (err) {
				// ExecFn resolves a result; it never throws. A policy rejection is
				// reported like a child failure, with the policy's own message.
				resolve({
					code: 1,
					stdout: "",
					stderr: err instanceof Error ? err.message : String(err),
				});
				return;
			}
			let stdout = "";
			let stderr = "";
			let done = false;
			const finish = (code: number, extra = "") => {
				if (done) return;
				done = true;
				if (timer) clearTimeout(timer);
				opts.signal?.removeEventListener("abort", onAbort);
				resolve({ code, stdout, stderr: stderr + extra });
			};
			const onAbort = () => child.kill("SIGTERM");
			const timer = opts.timeout ? setTimeout(onAbort, opts.timeout) : undefined;
			if (opts.signal?.aborted) onAbort();
			else opts.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout!.on("data", (d) => {
				stdout += d.toString();
			});
			child.stderr!.on("data", (d) => {
				stderr += d.toString();
			});
			child.on("error", (err) => finish(1, err.message));
			child.on("close", (code) => finish(code ?? 1));
		});
	};
}
