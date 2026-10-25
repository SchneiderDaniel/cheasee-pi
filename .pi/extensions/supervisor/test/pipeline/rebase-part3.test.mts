import { describe, it, mock, afterEach } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { tryRebaseOntoBase } from "../../pipeline/rebase.ts";

import type { RebaseOptions } from "../../config/types.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
	options?: { resolveOnError?: boolean },
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++];
			if (!result || (result.code !== 0 && !options?.resolveOnError)) {
				const errMsg = result?.stderr || result?.stdout || `Command failed: ${cmd}`;
				return Promise.reject(new Error(errMsg));
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

const WORKTREE_PATH = "/worktrees/wt-42";

const DEFAULT_BRANCH = "main";

const REMOTE = "origin";

const ISSUE_COLLISION_STDERR = `error: The following untracked working tree files would be overwritten by checkout:
\treport/jscpd-report.json
Please move or remove them before you switch branches.
Aborting
error: could not detach HEAD`;

afterEach(() => {
	mock.restoreAll();
});

describe("tryRebaseOntoBase()", () => {
	it("mergeFallback:false + untracked-collision → Phase 2.5 scoped-clean + retry still applies", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: ISSUE_COLLISION_STDERR },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "report/jscpd-report.json\n", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
			{ resolveOnError: true },
		);

		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, {
			mergeFallback: false,
		});

		assert.ok(result.success, "scoped-clean + retry must still apply with mergeFallback:false");
		assert.deepEqual(result.conflictFiles, []);
		assert.deepEqual(
			execCalls.map((c) => c.args[0]),
			["fetch", "rebase", "ls-files", "ls-tree", "clean", "rebase"],
			"option only gates the post-conflict merge, never the collision recovery",
		);
		assert.deepEqual(execCalls[4].args, ["clean", "-fd", "--", "report/jscpd-report.json"]);
	});
	it("tryRebaseOntoBase accepts optional RebaseOptions as 5th argument (type-level contract)", async () => {
		const execCalls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "rebase ok", stderr: "" },
			],
			execCalls,
		);
		// Compile-time contract: { mergeFallback: boolean } accepted; unknown keys rejected.
		const opts: RebaseOptions = { mergeFallback: false };
		const result = await tryRebaseOntoBase(WORKTREE_PATH, DEFAULT_BRANCH, REMOTE, pi, opts);
		assert.ok(result.success);
		const emptyOpts: RebaseOptions = {};
		assert.equal(emptyOpts.mergeFallback, undefined, "mergeFallback is optional");
	});
});
