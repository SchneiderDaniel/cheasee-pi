// ─── Tests: checks/ci-gating.ts — pollCiChecks, attemptPushRecovery ──
// Tests for the extracted attemptPushRecovery helper and the call sites
// in pollCiChecks that use it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pollCiChecks } from "../../checks/ci-gating.ts";

// ─── Call Tracking ─────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	cwd?: string;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], cwd: opts?.cwd as string | undefined });
			const result = results[idx++];
			if (result === undefined) {
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}
			// pi.exec throws on non-zero exit code (matches try-catch pattern in ci-gating.ts)
			if (result.code !== 0) {
				return Promise.reject(new Error(result.stderr || `exit code ${result.code}`));
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
	} as unknown as ExtensionAPI;
}

// ─── Tests: pollCiChecks attemptPushRecovery extraction ────────────

describe("pollCiChecks — push recovery extraction (Bug 5)", () => {
	it("returns error with push-recovery-failure message when empty SHA and push fails", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // rev-parse → empty SHA
				{ code: 1, stdout: "", stderr: "push failed" }, // push fails
			],
			calls,
		);
		const result = await pollCiChecks(pi, "test-branch", "owner/repo", 10, "/worktrees/test");
		assert.equal(result.status, "error");
		assert.ok(
			result.message.includes("push recovery failed"),
			`expected push-recovery-failure message, got: ${result.message}`,
		);
	});

	it("returns error with not-found-on-remote message when rev-parse throws and push fails", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 128, stdout: "", stderr: "fatal: unknown revision" }, // rev-parse throws
				{ code: 1, stdout: "", stderr: "push failed" }, // push fails
			],
			calls,
		);
		const result = await pollCiChecks(pi, "test-branch", "owner/repo", 10, "/worktrees/test");
		assert.equal(result.status, "error");
		assert.ok(
			result.message.includes("push recovery failed"),
			`expected push-recovery-failure message, got: ${result.message}`,
		);
	});

	it("proceeds to poll when empty SHA, push succeeds, SHA resolved", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // rev-parse → empty SHA
				{ code: 0, stdout: "", stderr: "" }, // push succeeds
				{ code: 0, stdout: "abc123", stderr: "" }, // rev-parse returns SHA
				// gh api — check runs (needs to return something non-empty for the loop)
				{ code: 0, stdout: "", stderr: "" }, // empty = unconfigured
			],
			calls,
		);
		const result = await pollCiChecks(pi, "test-branch", "owner/repo", 10, "/worktrees/test");
		// Should proceed (not error out with recovery failure)
		assert.notEqual(result.status, "error", "should not return error status");
	});

	it("proceeds to poll when rev-parse throws, push succeeds, SHA resolved", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 128, stdout: "", stderr: "fatal: unknown revision" }, // rev-parse throws
				{ code: 0, stdout: "", stderr: "" }, // push succeeds
				{ code: 0, stdout: "abc123", stderr: "" }, // rev-parse returns SHA
				// gh api — check runs
				{ code: 0, stdout: "", stderr: "" }, // empty = unconfigured
			],
			calls,
		);
		const result = await pollCiChecks(pi, "test-branch", "owner/repo", 10, "/worktrees/test");
		assert.notEqual(result.status, "error", "should not return error status");
	});

	it("returns 'Could not resolve branch' error when empty SHA and no worktreePath", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // rev-parse → empty SHA
			],
			calls,
		);
		const result = await pollCiChecks(pi, "test-branch", "owner/repo", 10);
		assert.equal(result.status, "error");
		assert.ok(
			result.message.includes("Could not resolve branch"),
			`expected 'Could not resolve branch' message, got: ${result.message}`,
		);
	});

	it("returns 'not found or not pushed' error when rev-parse throws and no worktreePath", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 128, stdout: "", stderr: "fatal: unknown revision" }, // rev-parse throws
			],
			calls,
		);
		const result = await pollCiChecks(pi, "test-branch", "owner/repo", 10);
		assert.equal(result.status, "error");
		assert.ok(
			result.message.includes("not found or not pushed"),
			`expected 'not found or not pushed' message, got: ${result.message}`,
		);
	});

	it("calls git push and rev-parse in correct order during recovery", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // rev-parse → empty SHA
				{ code: 0, stdout: "", stderr: "" }, // push succeeds
				{ code: 0, stdout: "abc123", stderr: "" }, // rev-parse returns SHA
				{ code: 0, stdout: "", stderr: "" }, // gh api
			],
			calls,
		);
		await pollCiChecks(pi, "test-branch", "owner/repo", 10, "/worktrees/test");
		// Verify the correct sequence: rev-parse → push → rev-parse → gh api
		assert.ok(calls.length >= 3, `expected at least 3 calls, got ${calls.length}`);
		assert.equal(calls[0].cmd, "git", "first call should be git");
		assert.equal(calls[0].args[0], "rev-parse", "first call should be rev-parse");
		assert.equal(calls[1].cmd, "git", "second call should be git");
		assert.equal(calls[1].args[0], "push", "second call should be push");
		assert.equal(calls[1].cwd, "/worktrees/test", "push should use worktreePath as cwd");
		assert.equal(calls[2].cmd, "git", "third call should be git");
		assert.equal(calls[2].args[0], "rev-parse", "third call should be rev-parse");
	});
});
