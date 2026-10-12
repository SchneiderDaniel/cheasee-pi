// ─── ExecFn adapter: per-child environment ────────────────────────
// pi.exec's ExecOptions has no `env` field, so a caller that must scope a
// secret to one child (GH_TOKEN for `gh`) would have to write it to
// `process.env` — where every concurrently spawned process inherits it.
// This adapter spawns directly when `opts.env` is set (the variables reach
// only that child), and delegates every other call to the injected exec.

import { spawn } from "node:child_process";
import type { ExecFn } from "./port-types.ts";

export function withPerChildEnv(base: ExecFn): ExecFn {
	return (cmd, args, opts) => {
		if (!opts?.env) return base(cmd, args, opts);
		return new Promise((resolve) => {
			const child = spawn(cmd, args, {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env },
				stdio: ["ignore", "pipe", "pipe"],
			});
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
