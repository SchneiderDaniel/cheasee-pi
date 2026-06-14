// ─── Tests: github/comment.ts — issue comment posting + parsing ──
// Tests for postIssueComment, extractStructuredAuditOutput,
// extractAgentCommentBody.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	postIssueComment,
	extractStructuredAuditOutput,
	extractAgentCommentBody,
	filterIssueData,
} from "../../github/comment.ts";

// ─── Direct Export Coverage (TDD gate test-covers-symbols) ───────
// These assertions call exported functions directly inside assert()
// so the TDD gate can detect that comment.ts runtime exports are covered.

describe("comment.ts runtime exports — direct call in assertions", () => {
	it("filterIssueData directly callable in assert", () => {
		assert.deepEqual(
			filterIssueData({ author: { login: "u" }, body: "b", labels: [{ name: "bug" }] }, ["u"])
				.labels,
			["bug"],
		);
	});

	it("extractStructuredAuditOutput directly callable in assert", () => {
		assert.equal(extractStructuredAuditOutput("AUDIT_DECISION: APPROVED")?.decision, "APPROVED");
	});

	it("extractAgentCommentBody directly callable in assert", () => {
		assert.equal(extractAgentCommentBody("COMMENT_BODY: test\nCOMMENT_BODY_END"), "test");
	});

	it("postIssueComment is a function", () => {
		assert.equal(typeof postIssueComment, "function");
	});
});

// ─── Helpers ──────────────────────────────────────────────────────

function createMockPi(execResult: { code: number; stdout: string; stderr: string }): ExtensionAPI {
	return {
		exec: async () => execResult,
	} as unknown as ExtensionAPI;
}

// ─── Tests: postIssueComment() ────────────────────────────────────

describe("postIssueComment()", () => {
	it("calls gh issue comment with --body-file (not --body)", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const pi = {
			exec: ((cmd: string, args: string[]) => {
				calls.push({ cmd, args });
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}) as ExtensionAPI["exec"],
		} as unknown as ExtensionAPI;
		await postIssueComment(pi, 123, "owner/repo", "Comment body");
		assert.equal(calls.length, 1);
		// gh() may call via "bash" when GH_TOKEN env is available (gh-client.ts)
		assert.ok(
			calls[0].cmd === "gh" || calls[0].cmd === "bash",
			`expected "gh" or "bash", got "${calls[0].cmd}"`,
		);
		// Must use --body-file to avoid shell interpretation of special chars
		const bodyFileIdx = calls[0].args.indexOf("--body-file");
		assert.notEqual(bodyFileIdx, -1, "should use --body-file instead of --body");
		assert.equal(calls[0].args.indexOf("--body"), -1, "should NOT use --body");
		// Verify temp file path is in ignore/ folder
		const tempFilePath = calls[0].args[bodyFileIdx + 1];
		assert.ok(tempFilePath, "temp file path should exist");
		assert.ok(
			tempFilePath.startsWith("ignore/comment-body-123-"),
			`temp file should be in ignore/ folder: ${tempFilePath}`,
		);
		assert.ok(tempFilePath.endsWith(".md"), "temp file should end with .md");
	});
});

// ─── Tests: extractStructuredAuditOutput() ────────────────────────

describe("extractStructuredAuditOutput()", () => {
	it("extracts APPROVED decision from AUDIT_DECISION marker", () => {
		const output = "Some text\nAUDIT_DECISION: APPROVED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
	});

	it("extracts REJECTED decision from AUDIT_DECISION marker", () => {
		const output = "Some text\nAUDIT_DECISION: REJECTED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	it("returns null when no audit marker present", () => {
		const result = extractStructuredAuditOutput("Just some text");
		assert.equal(result, null);
	});

	it("last AUDIT_DECISION wins when multiple present", () => {
		const output = "AUDIT_DECISION: APPROVED\nAUDIT_DECISION: REJECTED";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	it("extracts PR_TITLE from output", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_TITLE: feat(#123): add feature";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prTitle, "feat(#123): add feature");
	});

	it("extracts PR_BODY from output", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_BODY: Description here";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "Description here");
	});

	it("extracts COMMENT_BODY from output", () => {
		const output = "AUDIT_DECISION: REJECTED\nCOMMENT_BODY: Need fixes";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.commentBody, "Need fixes");
	});

	it("handles standalone AUDIT_APPROVED fallback", () => {
		const output = "Some text\nAUDIT_APPROVED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
	});

	it("handles standalone AUDIT_REJECTED fallback", () => {
		const output = "Some text\nAUDIT_REJECTED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	// ── Bug fix: AUDIT_SCORE inside PR_BODY must not truncate ──

	it("PR_BODY with AUDIT_SCORE inside — captures full body including score", () => {
		// AUDIT_SCORE appears INSIDE PR_BODY in the auditor template.
		// The old regex would stop at AUDIT_SCORE: truncating the body.
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#123): add feature",
			"PR_BODY: ## PR Description",
			"",
			"Changes made:",
			"- Added new feature",
			"",
			"### Audit Score",
			"AUDIT_SCORE: 5/6",
			"",
			"COMMENT_BODY: ## Audit Approved",
			"Looks good!",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		assert.ok(result?.prBody, "PR_BODY should be captured");
		assert.ok(
			result?.prBody?.includes("AUDIT_SCORE: 5/6"),
			"PR_BODY should include AUDIT_SCORE: 5/6",
		);
		assert.ok(
			result?.prBody?.includes("### Audit Score"),
			"PR_BODY should include ### Audit Score",
		);
		assert.equal(result?.commentBody, "## Audit Approved\nLooks good!");
	});

	it("PR_BODY with AUDIT_SCORE followed by SUBMODULE_PR — captures correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#123): multi-repo",
			"PR_BODY: ## Changes",
			"AUDIT_SCORE: 6/6",
			"",
			"SUBMODULE_PR: submodule-repo main..feat-branch",
			"COMMENT_BODY: Done",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.ok(result?.prBody?.includes("AUDIT_SCORE: 6/6"));
		assert.ok(result?.prBody?.includes("## Changes"));
	});

	it("empty PR_BODY (no content before next marker) — prBody is empty string", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_TITLE: feat\nPR_BODY: \nCOMMENT_BODY: note";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "");
	});

	it("COMMENT_BODY with ALL_CAPS: content inside — not truncated", () => {
		const output = [
			"AUDIT_DECISION: REJECTED",
			"COMMENT_BODY: ## Audit Rejected",
			"- STATUS: needs work",
			"- REVIEW_RESULT: fail",
			"Please fix before next review.",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
		assert.ok(result?.commentBody, "COMMENT_BODY should be captured");
		assert.ok(
			result?.commentBody?.includes("STATUS: needs work"),
			"COMMENT_BODY should include STATUS: needs work",
		);
		assert.ok(
			result?.commentBody?.includes("REVIEW_RESULT: fail"),
			"COMMENT_BODY should include REVIEW_RESULT: fail",
		);
	});

	it("COMMENT_BODY followed by SUBMODULE_PR boundary — stops correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat",
			"PR_BODY: desc",
			"COMMENT_BODY: ## Approved",
			"All checks passed.",
			"SUBMODULE_PR: sub-repo main..feat",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.commentBody, "## Approved\nAll checks passed.");
	});

	it("full auditor template output — all sections captured correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#384): fix regex truncation bug",
			"PR_BODY: ## PR Description",
			"",
			"### Summary",
			"Fixed the extractStructuredAuditOutput regex bug that truncated PR_BODY",
			"at AUDIT_SCORE line.",
			"",
			"### Changes",
			"- Updated regex lookahead to use explicit section markers",
			"",
			"### Audit Score",
			"AUDIT_SCORE: 6/6",
			"",
			"COMMENT_BODY: ## Audit Approved",
			"",
			"### Summary",
			"Regex fix looks correct.",
			"",
			"### Review Findings",
			"- Architecture compliance: ✓",
			"- Code quality: ✓",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		assert.equal(result?.prTitle, "feat(#384): fix regex truncation bug");
		assert.ok(result?.prBody?.includes("AUDIT_SCORE: 6/6"), "PR_BODY must include AUDIT_SCORE");
		assert.ok(result?.prBody?.includes("### Audit Score"), "PR_BODY must include ### Audit Score");
		assert.ok(
			result?.prBody?.includes("### Changes"),
			"PR_BODY must include content after AUDIT_SCORE",
		);
		assert.ok(
			result?.commentBody?.includes("### Summary"),
			"COMMENT_BODY must include its content",
		);
		assert.ok(
			result?.commentBody?.includes("### Review Findings"),
			"COMMENT_BODY must have full content",
		);
		assert.ok(
			result?.commentBody?.includes("- Code quality: ✓"),
			"COMMENT_BODY must not be truncated",
		);
	});

	it("PR_BODY with only AUDIT_SCORE (no other content before next marker) — captures score", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat",
			"PR_BODY: AUDIT_SCORE: 4/6",
			"COMMENT_BODY: comment here",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "AUDIT_SCORE: 4/6");
	});
});

// ─── Tests: extractAgentCommentBody() ─────────────────────────────

describe("extractAgentCommentBody()", () => {
	it("extracts text after COMMENT_BODY marker", () => {
		const output = "Some text\nCOMMENT_BODY: This is the comment\nCOMMENT_BODY_END\nMore text";
		const result = extractAgentCommentBody(output);
		assert.equal(result, "This is the comment");
	});

	it("returns null when no marker found", () => {
		const result = extractAgentCommentBody("Just some text");
		assert.equal(result, null);
	});

	it("last COMMENT_BODY marker wins", () => {
		const output = "COMMENT_BODY: First\nCOMMENT_BODY_END\nCOMMENT_BODY: Second\nCOMMENT_BODY_END";
		const result = extractAgentCommentBody(output);
		assert.equal(result, "Second");
	});

	it("handles COMMENT_BODY without COMMENT_BODY_END — extracts to end", () => {
		const output = "COMMENT_BODY: Trailing text";
		const result = extractAgentCommentBody(output);
		assert.equal(result, "Trailing text");
	});

	it("extracts commentBody from AgentOutput JSON", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			commentBody: "## Architecture\nMy approach",
		});
		const result = extractAgentCommentBody(output);
		assert.equal(result, "## Architecture\nMy approach");
	});

	it("falls through to regex when JSON parse succeeds but commentBody missing", () => {
		const output =
			JSON.stringify({ action: "COMPLETE", agentName: "architect" }) +
			"\nCOMMENT_BODY: Fallback comment\nCOMMENT_BODY_END";
		const result = extractAgentCommentBody(output);
		assert.equal(result, "Fallback comment");
	});

	it("returns null from regex fallback when no COMMENT_BODY marker", () => {
		const output = JSON.stringify({ action: "COMPLETE", agentName: "architect" });
		const result = extractAgentCommentBody(output);
		assert.equal(result, null);
	});
});

// ─── Tests: extractStructuredAuditOutput — COMMENT_BODY_END stripping ──

describe("extractStructuredAuditOutput() — COMMENT_BODY_END stripping", () => {
	it("strips trailing COMMENT_BODY_END from comment body", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"COMMENT_BODY: ## Audit Approved",
			"All checks passed.",
			"COMMENT_BODY_END",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		assert.equal(result?.commentBody, "## Audit Approved\nAll checks passed.");
	});

	it("handles COMMENT_BODY without COMMENT_BODY_END (no stripping needed)", () => {
		const output = [
			"AUDIT_DECISION: REJECTED",
			"COMMENT_BODY: ## Audit Rejected",
			"Issues found.",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
		assert.equal(result?.commentBody, "## Audit Rejected\nIssues found.");
	});

	it("strips COMMENT_BODY_END and trailing content after it", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"COMMENT_BODY: ## Audit Approved",
			"Looks good.",
			"COMMENT_BODY_END",
			"some trailing text",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		// COMMENT_BODY_END and everything after it is stripped
		assert.equal(result?.commentBody, "## Audit Approved\nLooks good.");
	});
});

// ─── Tests: filterIssueData — labels passthrough ────────────────

describe("filterIssueData — labels passthrough", () => {
	it("preserves labels from RawIssueData in FilteredIssueData output", () => {
		const rawIssue = {
			author: { login: "user1" },
			body: "Issue body",
			labels: [{ name: "supervisor" }, { name: "bug" }],
		};
		const result = filterIssueData(rawIssue, ["user1"]);
		assert.deepEqual(result.labels, ["supervisor", "bug"]);
	});

	it("extracts label names from label objects", () => {
		const rawIssue = {
			author: { login: "user1" },
			body: "Body",
			labels: [{ name: "documentation" }, { name: "enhancement" }],
		};
		const result = filterIssueData(rawIssue, ["user1"]);
		assert.deepEqual(result.labels, ["documentation", "enhancement"]);
	});

	it("labels is undefined when no labels in raw data", () => {
		const rawIssue = {
			author: { login: "user1" },
			body: "Body",
		};
		const result = filterIssueData(rawIssue, ["user1"]);
		assert.strictEqual(result.labels, undefined);
	});

	it("labels is undefined when labels array is empty", () => {
		const rawIssue = {
			author: { login: "user1" },
			body: "Body",
			labels: [],
		};
		const result = filterIssueData(rawIssue, ["user1"]);
		assert.strictEqual(result.labels, undefined);
	});

	it("existing filterIssueData behavior with author filtering unchanged when labels present", () => {
		const rawIssue = {
			author: { login: "outsider" },
			body: "Secret body",
			labels: [{ name: "supervisor" }],
		};
		const result = filterIssueData(rawIssue, ["user1"]);
		// Author not trusted — body should be hidden
		assert.ok(result.body.startsWith("[Issue body hidden"));
		// But labels are still present (unfiltered, public metadata)
		assert.deepEqual(result.labels, ["supervisor"]);
	});

	it("returns empty comments array when no comments (existing behavior preserved)", () => {
		const rawIssue = {
			author: { login: "user1" },
			body: "Body",
			labels: [{ name: "supervisor" }],
		};
		const result = filterIssueData(rawIssue, ["user1"]);
		assert.deepEqual(result.comments, []);
		assert.deepEqual(result.labels, ["supervisor"]);
	});
});
