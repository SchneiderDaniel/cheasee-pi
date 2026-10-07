// ─── Tests: worktree remote reconciliation (issue #1866) ───────────
// Replaces the former comment-presence / byte-identical / git-diff source
// guards with behavior: reconcileToRemoteBranch surfaces fetch/reset
// failures through its Result instead of swallowing them.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileToRemoteBranch } from "../../pipeline/worktree.ts";

function makePi(
	handle: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string },
): { pi: any; calls: Array<{ cmd: string; args: string[] }> } {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const pi = {
		exec: async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			const r = handle(cmd, args);
			return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", killed: false };
		},
	};
	return { pi, calls };
}

const notify = { info: () => {}, error: () => {}, warn: () => {} } as any;

describe("reconcileToRemoteBranch — failures surface through Result", () => {
	it("empty ls-remote (branch gone) → ok, fetch never attempted", async () => {
		const { pi, calls } = makePi(() => ({ code: 0, stdout: "" }));
		const result = await reconcileToRemoteBranch(pi, "/cwd", "/wt", "b", "origin", notify);
		assert.equal(result.ok, true);
		assert.ok(!calls.some((c) => c.args[0] === "fetch"), "no fetch when the branch is gone");
	});

	it("fetch failure → Result error names the failing command", async () => {
		const { pi } = makePi((_cmd, args) =>
			args[0] === "ls-remote"
				? { code: 0, stdout: "abc\trefs/heads/b\n" }
				: { code: 1, stderr: "boom" },
		);
		const result = await reconcileToRemoteBranch(pi, "/cwd", "/wt", "b", "origin", notify);
		assert.equal(result.ok, false);
		assert.match((result as any).error, /git fetch origin b failed: boom/);
	});

	it("reset failure → Result error names the failing command", async () => {
		const { pi } = makePi((_cmd, args) => {
			if (args[0] === "ls-remote") return { code: 0, stdout: "abc\trefs/heads/b\n" };
			if (args[0] === "fetch") return { code: 0 };
			return { code: 1, stderr: "bad" };
		});
		const result = await reconcileToRemoteBranch(pi, "/cwd", "/wt", "b", "origin", notify);
		assert.equal(result.ok, false);
		assert.match((result as any).error, /git reset --hard origin\/b failed: bad/);
	});
});
