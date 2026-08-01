// ─── Tests: pipeline/handler/shared.ts — fetchResolvedByInfo (issue #1395) ──
// Characterization of the moved stateless helper: git-log SHA resolution,
// closing-PR fallback chain, and the documented fail-soft contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchResolvedByInfo } from "../../pipeline/handler/shared.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import type { ClosingPrRef } from "../../github/ports.ts";

type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const WT = "/worktree/repo";
const ISSUE = 42;
const REPO = "owner/repo";

function makeExec(result: { code: number; stdout: string; stderr: string } | Error): ExecFn {
	return async () => {
		if (result instanceof Error) throw result;
		return result;
	};
}

const gitLogOk = makeExec({ code: 0, stdout: `${SHA}\n`, stderr: "" });
const gitLogEmpty = makeExec({ code: 0, stdout: "", stderr: "" });
const gitLogThrows = makeExec(new Error("git log failed"));

describe("fetchResolvedByInfo — git log SHA resolution", () => {
	it("returns sha from trimmed stdout when git log succeeds", async () => {
		const port = createMockGitHubPort();
		const info = await fetchResolvedByInfo(gitLogOk, WT, "main", port, ISSUE, REPO);
		assert.equal(info.sha, SHA);
		assert.equal(info.prNumber, 0);
		assert.equal(info.source, "main-branch");
	});

	it("git log throw fails soft — falls back to 'main' sha with no refs", async () => {
		const port = createMockGitHubPort();
		const info = await fetchResolvedByInfo(gitLogThrows, WT, "main", port, ISSUE, REPO);
		assert.equal(info.sha, "main");
		assert.equal(info.prNumber, 0);
		assert.equal(info.source, "main-branch");
	});

	it("empty sha after all sources → 'main'", async () => {
		const port = createMockGitHubPort();
		const info = await fetchResolvedByInfo(gitLogEmpty, WT, "main", port, ISSUE, REPO);
		assert.equal(info.sha, "main");
	});
});

describe("fetchResolvedByInfo — closing-PR reference resolution", () => {
	const closingRef: ClosingPrRef = {
		number: 99,
		sha: "refsha99",
		source: "closing-keyword",
		branch: "fix-42",
		state: "merged",
	};
	const branchRef: ClosingPrRef = {
		number: 7,
		sha: "refsha7",
		source: "branch-head",
		branch: "worktree-git-issue-42",
		state: "open",
	};

	it("closing-keyword ref present → prNumber+source set, sha overridden by ref sha", async () => {
		const port = createMockGitHubPort({
			getClosingPrsForIssue: async () => [branchRef, closingRef],
		});
		const info = await fetchResolvedByInfo(gitLogOk, WT, "main", port, ISSUE, REPO);
		assert.equal(info.prNumber, 99);
		assert.equal(info.source, "closing-keyword");
		assert.equal(info.sha, "refsha99");
	});

	it("only non-closing refs → first-ref fallback", async () => {
		const port = createMockGitHubPort({
			getClosingPrsForIssue: async () => [branchRef],
		});
		const info = await fetchResolvedByInfo(gitLogOk, WT, "main", port, ISSUE, REPO);
		assert.equal(info.prNumber, 7);
		assert.equal(info.source, "branch-head");
		assert.equal(info.sha, "refsha7");
	});

	it("no refs → prNumber 0, source 'main-branch', git-log sha kept", async () => {
		const port = createMockGitHubPort();
		const info = await fetchResolvedByInfo(gitLogOk, WT, "main", port, ISSUE, REPO);
		assert.equal(info.prNumber, 0);
		assert.equal(info.source, "main-branch");
		assert.equal(info.sha, SHA);
	});

	it("port.getClosingPrsForIssue throws → fail-soft, commit sha only", async () => {
		const port = createMockGitHubPort({
			getClosingPrsForIssue: async () => {
				throw new Error("api down");
			},
		});
		const info = await fetchResolvedByInfo(gitLogOk, WT, "main", port, ISSUE, REPO);
		assert.equal(info.prNumber, 0);
		assert.equal(info.source, "main-branch");
		assert.equal(info.sha, SHA);
	});
});
