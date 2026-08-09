// ─── Tests: merge.ts — tryAutoMerge unit tests ─────────────────
// Tests git operation outcomes with mocked pi.exec.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tryAutoMerge } from "../config/merge.ts";

// ─── Mock Helpers ──────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

// ─── Tests: tryAutoMerge() ────────────────────────────────────────

describe("tryAutoMerge() (Phase 2)", () => {
	const worktreePath = "/worktrees/feature-branch";
	const branch = "feature-branch";
	const defaultBranch = "main";
	const remote = "origin";

	it("git fetch succeeds + git merge succeeds → {success: true, conflictFiles: []}", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
			],
			calls,
		);

		const result = await tryAutoMerge(worktreePath, branch, defaultBranch, remote, pi);

		assert.equal(result.success, true);
		assert.deepEqual(result.conflictFiles, []);
		assert.ok(result.message);
	});

	it("git fetch fails → {success: false} with error message containing 'git fetch failed'", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{
					code: 128,
					stdout: "",
					stderr: "fatal: could not read Username for 'https://github.com'",
				},
			],
			calls,
		);

		const result = await tryAutoMerge(worktreePath, branch, defaultBranch, remote, pi);

		assert.equal(result.success, false);
		assert.ok(
			result.message.includes("git fetch failed"),
			`message should mention 'git fetch failed': ${result.message}`,
		);
	});

	it("git merge fails with conflicts → {success: false, conflictFiles: ['file1.ts', 'file2.ts']}", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "merge failed", stderr: "CONFLICT" },
				{ code: 0, stdout: "file1.ts\nfile2.ts\n", stderr: "" },
				// git merge --abort
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);

		const result = await tryAutoMerge(worktreePath, branch, defaultBranch, remote, pi);

		assert.equal(result.success, false);
		assert.ok(Array.isArray(result.conflictFiles));
		assert.equal(result.conflictFiles.length, 2);
		assert.ok(result.conflictFiles.includes("file1.ts"));
		assert.ok(result.conflictFiles.includes("file2.ts"));
	});

	it("git merge fails but no conflicts (empty diff) → {success: false, message: 'Merge failed: ...'}", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "Merge failed: already up to date?" },
				{ code: 0, stdout: "", stderr: "" }, // git diff --name-only returns empty
			],
			calls,
		);

		const result = await tryAutoMerge(worktreePath, branch, defaultBranch, remote, pi);

		assert.equal(result.success, false);
		assert.ok(
			result.message.includes("Merge failed"),
			`message should contain 'Merge failed': ${result.message}`,
		);
		assert.deepEqual(result.conflictFiles, []);
	});

	it("git merge throws unexpected error → caught, returns {success: false} with error message", async () => {
		const calls: ExecCall[] = [];
		// First exec succeeds (fetch), second exec (merge) throws
		const pi = createMockPi([{ code: 0, stdout: "fetch ok", stderr: "" }], calls);
		// Override the second exec to throw a non-git error
		let callCount = 0;
		const throwingPi: ExtensionAPI = {
			exec: async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
				callCount++;
				calls.push({ cmd, args: args || [], opts: opts || {} });
				if (callCount === 1) {
					return { code: 0, stdout: "fetch ok", stderr: "" };
				}
				throw new Error("Unexpected error during merge");
			},
		} as ExtensionAPI;

		const result = await tryAutoMerge(worktreePath, branch, defaultBranch, remote, throwingPi);

		assert.equal(result.success, false);
		assert.ok(
			result.message.includes("Unexpected error"),
			`message should contain error: ${result.message}`,
		);
	});

	it("handles empty conflictFiles edge case (diff returns whitespace)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "CONFLICT" },
				{ code: 0, stdout: "  \n\n  \n", stderr: "" }, // whitespace-only diff
				// git merge --abort
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);

		const result = await tryAutoMerge(worktreePath, branch, defaultBranch, remote, pi);

		assert.equal(result.success, false);
		assert.ok(Array.isArray(result.conflictFiles));
		// Whitespace-only lines should be filtered out
		assert.equal(result.conflictFiles.length, 0);
	});
});
