// ─── Tests: empty-worktree-policy — EmptyWorktreeAction classifier ─
// Covers the 3-way classification for empty worktree situations.
//
// Phase 1: classifyEmptyWorktree — 3 cases + edge cases
// Phase 2: buildResolvedByComment — close comment builder
// Phase 3: buildLeaveOpenForPrComment — leave-open comment builder
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/empty-worktree-policy.test.mts

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	classifyEmptyWorktree,
	buildResolvedByComment,
	buildLeaveOpenForPrComment,
} from "../../pipeline/empty-worktree-policy.ts";
import type { EmptyWorktreeSignals } from "../../pipeline/empty-worktree-policy.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: classifyEmptyWorktree — 3 cases + edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("classifyEmptyWorktree — case 1 (loop)", () => {
	it("no commits, no changes on main, no open PRs → loop", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: false,
			openPrs: [],
		};
		const result = classifyEmptyWorktree(signals);
		assert.ok(result, "should return an action");
		assert.equal(result.kind, "loop");
		if (result.kind === "loop") {
			assert.ok(result.reason.length > 0, "should have a reason");
		}
	});

	it("loop action reason describes the situation", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: false,
			openPrs: [],
		};
		const result = classifyEmptyWorktree(signals);
		if (result && result.kind === "loop") {
			assert.ok(result.reason.includes("No commits"), "reason should mention no commits");
			assert.ok(
				result.reason.includes("looping"),
				"reason should mention looping back",
			);
		}
	});
});

describe("classifyEmptyWorktree — case 2 (close)", () => {
	it("no commits, changes on main, no open PRs → close", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: true,
			openPrs: [],
		};
		const result = classifyEmptyWorktree(signals);
		assert.ok(result, "should return an action");
		assert.equal(result.kind, "close");
		if (result.kind === "close") {
			assert.ok(result.resolvedBy, "should have resolvedBy");
			assert.ok(typeof result.resolvedBy.sha === "string", "sha should be a string");
		}
	});

	it("close action has resolvedBy with sha, prNumber, source", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: true,
			openPrs: [],
		};
		const result = classifyEmptyWorktree(signals);
		if (result && result.kind === "close") {
			assert.equal(typeof result.resolvedBy.sha, "string");
			assert.equal(typeof result.resolvedBy.prNumber, "number");
			assert.equal(typeof result.resolvedBy.source, "string");
		}
	});
});

describe("classifyEmptyWorktree — case 3 (leave open for PR)", () => {
	it("no commits, changes on main, open PR exists → leaveOpenForPr", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: true,
			openPrs: [{ number: 42, sha: "abc123", source: "closing-keyword", branch: "fix-branch" }],
		};
		const result = classifyEmptyWorktree(signals);
		assert.ok(result, "should return an action");
		assert.equal(result.kind, "leaveOpenForPr");
		if (result.kind === "leaveOpenForPr") {
			assert.equal(result.prNumber, 42);
			assert.equal(result.branch, "fix-branch");
		}
	});

	it("no commits, no changes on main, open PR exists → leaveOpenForPr (PR takes precedence)", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: false,
			openPrs: [{ number: 99, sha: "def456", source: "branch-head", branch: "other-branch" }],
		};
		const result = classifyEmptyWorktree(signals);
		assert.ok(result, "should return an action");
		assert.equal(result.kind, "leaveOpenForPr");
		if (result.kind === "leaveOpenForPr") {
			assert.equal(result.prNumber, 99);
			assert.equal(result.branch, "other-branch");
		}
	});

	it("uses first open PR when multiple PRs exist", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: false,
			openPrs: [
				{ number: 1, sha: "aaa", source: "closing-keyword", branch: "pr1" },
				{ number: 2, sha: "bbb", source: "branch-head", branch: "pr2" },
			],
		};
		const result = classifyEmptyWorktree(signals);
		if (result && result.kind === "leaveOpenForPr") {
			assert.equal(result.prNumber, 1, "should use the first PR");
			assert.equal(result.branch, "pr1");
		}
	});

	it("closing-keyword source PR is correctly preserved", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: false,
			changeOnMain: true,
			openPrs: [{
				number: 1342,
				sha: "8078920",
				source: "closing-keyword",
				branch: "fix-1289-delete-gh-superseded-modules",
			}],
		};
		const result = classifyEmptyWorktree(signals);
		if (result && result.kind === "leaveOpenForPr") {
			assert.equal(result.prNumber, 1342);
			assert.equal(result.branch, "fix-1289-delete-gh-superseded-modules");
		}
	});
});

describe("classifyEmptyWorktree — edge cases", () => {
	it("hasCommits is true → returns null (classifier not applicable)", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: true,
			changeOnMain: false,
			openPrs: [],
		};
		const result = classifyEmptyWorktree(signals);
		assert.equal(result, null, "should return null when hasCommits is true");
	});

	it("hasCommits true, changeOnMain true, open PRs → returns null", () => {
		const signals: EmptyWorktreeSignals = {
			hasCommits: true,
			changeOnMain: true,
			openPrs: [{ number: 1, sha: "a", source: "closing-keyword", branch: "b" }],
		};
		const result = classifyEmptyWorktree(signals);
		assert.equal(result, null, "should return null when hasCommits is true");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: buildResolvedByComment — close comment builder
// ═══════════════════════════════════════════════════════════════════════

describe("buildResolvedByComment", () => {
	it("includes commit SHA and PR number when prNumber > 0", () => {
		const body = buildResolvedByComment({
			sha: "8078920",
			prNumber: 1341,
			source: "main-branch",
		});
		assert.ok(body.includes("8078920"), "should include commit SHA");
		assert.ok(body.includes("#1341"), "should include PR number");
		assert.ok(body.includes("Already Resolved"), "should have heading");
	});

	it("uses generic message when prNumber is 0 and source is main-branch", () => {
		const body = buildResolvedByComment({
			sha: "main",
			prNumber: 0,
			source: "main-branch",
		});
		assert.ok(body.includes("main"), "should mention main branch");
		assert.ok(body.includes("Already Resolved"), "should have heading");
	});

	it("includes source description when source is not main-branch", () => {
		const body = buildResolvedByComment({
			sha: "abc123",
			prNumber: 0,
			source: "branch-head",
		});
		assert.ok(body.includes("branch-head"), "should include source");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: buildLeaveOpenForPrComment — leave-open comment builder
// ═══════════════════════════════════════════════════════════════════════

describe("buildLeaveOpenForPrComment", () => {
	it("includes PR number and branch name", () => {
		const body = buildLeaveOpenForPrComment(1342, "fix-1289-delete-gh-superseded-modules");
		assert.ok(body.includes("#1342"), "should include PR number");
		assert.ok(body.includes("fix-1289-delete-gh-superseded-modules"), "should include branch name");
		assert.ok(body.includes("Open PR"), "should mention open PR");
	});

	it("does not indicate issue closure", () => {
		const body = buildLeaveOpenForPrComment(42, "feature");
		assert.ok(!body.includes("Closing"), "should not say closing");
		assert.ok(!body.includes("Closed"), "should not say closed");
	});
});
