// ─── Tests: lib/port-adapters.ts — toExecFn ──────────────────────
// Verifies the single pi.exec → ExecFn binding forwards argv/opts verbatim,
// normalizes the result to the 3-field port shape, and never swallows a
// wrapped rejection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toExecFn, type ExecLike } from "./port-adapters.ts";

describe("toExecFn()", () => {
	it("forwards cmd, args and opts verbatim and normalizes a 4-field result", async () => {
		const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
		const base: ExecLike = async (cmd, args, opts) => {
			calls.push({ cmd, args, opts });
			// pi.exec also carries `killed`; the port must drop it.
			const r = { code: 0, stdout: "out", stderr: "err", killed: true };
			return r;
		};
		const ac = new AbortController();
		const result = await toExecFn(base)("gh", ["issue", "view"], {
			timeout: 5,
			signal: ac.signal,
			cwd: "/tmp",
		});

		assert.deepEqual(result, { code: 0, stdout: "out", stderr: "err" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "gh");
		assert.deepEqual(calls[0].args, ["issue", "view"]);
		assert.deepEqual(calls[0].opts, { timeout: 5, signal: ac.signal, cwd: "/tmp" });
	});

	it("forwards omitted opts as omitted and empty args as []", async () => {
		let seen: unknown = "unset";
		const base: ExecLike = async (_cmd, args, opts) => {
			seen = opts;
			assert.deepEqual(args, []);
			return { code: 1, stdout: "", stderr: "boom" };
		};
		const result = await toExecFn(base)("git", []);
		assert.equal(seen, undefined);
		assert.deepEqual(result, { code: 1, stdout: "", stderr: "boom" });
	});

	it("propagates a wrapped rejection unchanged", async () => {
		const boom = new Error("spawn failed");
		const base: ExecLike = async () => {
			throw boom;
		};
		await assert.rejects(
			() => toExecFn(base)("x", []),
			(err) => err === boom,
		);
	});
});
