// ─── Tests: github/pr.ts — PR conflict detection + creation ──────
// Tests for checkPrConflicts and createPullRequest.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "../../pipeline/helpers.ts";
import { checkPrConflicts, createPullRequest } from "../../github/pr.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockExec(execResult: { code: number; stdout: string; stderr: string }): ExecFn {
	return async () => ({ ...execResult, killed: false });
}

// ─── Tests: checkPrConflicts() ────────────────────────────────────

describe("checkPrConflicts()", () => {
	it("returns PR info when PR exists and has no conflicts", async () => {
		const ghOutput = JSON.stringify([
			{
				number: 42,
				mergeable: "MERGEABLE",
				mergeStateStatus: "CLEAN",
				headRefName: "feature-branch",
				baseRefName: "main",
			},
		]);
		const exec = createMockExec({ code: 0, stdout: ghOutput, stderr: "" });
		const result = await checkPrConflicts(exec, "feature-branch", "owner/repo");
		assert.ok(result !== null);
		assert.equal(result.number, 42);
		assert.equal(result.hasConflict, false);
		assert.equal(result.mergeable, "MERGEABLE");
	});

	it("reports conflict when mergeable is CONFLICTING", async () => {
		const ghOutput = JSON.stringify([
			{
				number: 42,
				mergeable: "CONFLICTING",
				mergeStateStatus: "DIRTY",
				headRefName: "feature",
				baseRefName: "main",
			},
		]);
		const exec = createMockExec({ code: 0, stdout: ghOutput, stderr: "" });
		const result = await checkPrConflicts(exec, "feature", "owner/repo");
		assert.ok(result !== null);
		assert.equal(result.hasConflict, true);
	});

	it("returns null when no PR exists for branch", async () => {
		const exec = createMockExec({ code: 0, stdout: "[]", stderr: "" });
		const result = await checkPrConflicts(exec, "nonexistent-branch", "owner/repo");
		assert.equal(result, null);
	});

	it("throws on gh error (auth/network failure)", async () => {
		const exec = createMockExec({ code: 1, stdout: "", stderr: "network error" });
		await assert.rejects(
			() => checkPrConflicts(exec, "feature", "owner/repo"),
			/gh pr failed: network error/,
		);
	});
});

// ─── Tests: createPullRequest() ───────────────────────────────────

describe("createPullRequest()", () => {
	it("parses PR number from URL output", async () => {
		const exec = createMockExec({
			code: 0,
			stdout: "https://github.com/owner/repo/pull/123",
			stderr: "",
		});
		const result = await createPullRequest(exec, "owner/repo", "main", "feature", "PR title");
		assert.equal(result.number, 123);
	});

	it("parses PR number from numeric output", async () => {
		const exec = createMockExec({ code: 0, stdout: "42", stderr: "" });
		const result = await createPullRequest(exec, "owner/repo", "main", "feature", "PR title");
		assert.equal(result.number, 42);
	});

	it("throws when PR number cannot be parsed", async () => {
		const exec = createMockExec({ code: 0, stdout: "unexpected output", stderr: "" });
		await assert.rejects(
			() => createPullRequest(exec, "owner/repo", "main", "feature", "PR title"),
			/gh pr create failed to parse PR number/,
		);
	});

	it("uses body-file when provided", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "https://github.com/o/r/pull/1", stderr: "", killed: false };
		};
		await createPullRequest(exec, "owner/repo", "main", "feature", "PR title", "/tmp/body.md");
		const callArgs = calls[0].args;
		assert.ok(callArgs.includes("--body-file"));
		assert.ok(callArgs.includes("/tmp/body.md"));
	});

	it("parses PR number from URL output (gh pr create default format)", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return {
				code: 0,
				stdout: "https://github.com/owner/repo/pull/456",
				stderr: "",
				killed: false,
			};
		};
		const result = await createPullRequest(exec, "owner/repo", "main", "feature", "PR title");
		assert.equal(result.number, 456, "should parse PR number from URL");
		// Verify --json is NOT passed (gh pr create does not support it)
		const args = calls[0].args;
		assert.equal(args.includes("--json"), false, "should NOT include --json flag");
	});

	it("throws when gh output has no parseable PR number", async () => {
		const exec = createMockExec({
			code: 0,
			stdout: "unexpected output without number",
			stderr: "",
		});
		await assert.rejects(
			() => createPullRequest(exec, "owner/repo", "main", "feature", "PR title"),
			/failed to parse PR number/,
		);
	});
});
