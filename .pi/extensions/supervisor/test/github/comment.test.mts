// ─── Tests: github/comment.ts — issue comment posting + parsing ──
// Tests for postIssueComment, extractStructuredAuditOutput,
// extractAgentCommentBody.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "../../pipeline/helpers.ts";
import {
	postIssueComment,
	extractStructuredAuditOutput,
	extractAgentCommentBody,
	filterIssueData,
} from "../../github/comment.ts";
import { isToolCallLine } from "../../lib/formatting.ts";

// ─── Direct Export Coverage (TDD gate test-covers-symbols) ───────
// These assertions call exported functions directly inside assert()
// so the TDD gate can detect that comment.ts runtime exports are covered.

describe("comment.ts runtime exports — direct call in assertions", () => {
	it("filterIssueData directly callable in assert", () => {
		assert.strictEqual(filterIssueData({ author: { login: "u" }, body: "b" }, ["u"]).body, "b");
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

function createMockExec(execResult: { code: number; stdout: string; stderr: string }): ExecFn {
	return async () => ({ ...execResult, killed: false });
}

// ─── Tests: postIssueComment() ────────────────────────────────────

describe("postIssueComment()", () => {
	it("calls gh issue comment with --body-file (not --body)", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "", stderr: "", killed: false };
		};
		await postIssueComment(exec, 123, "owner/repo", "Comment body");
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

// ─── Tests: extractAgentCommentBody — new-format tool line filtering (Phase 7) ──
// stripNoise inside extractAgentCommentBody must filter new-format tool call lines.

describe("extractAgentCommentBody — new-format tool line filtering", () => {
	it("filters $ command lines from comment body (sufficient content to pass >=50 char guard)", () => {
		// stripNoise has a >=50 char guard — content must be long enough after stripping
		const output = [
			"COMMENT_BODY:",
			"## Architecture",
			"$ npm test",
			"$ echo hello",
			"$ ls -la",
			"",
			"The architecture uses a clean layered design with clear separation of concerns.",
			"Each layer has well-defined boundaries making the system maintainable.",
			"Core components include event system, agent runners, and pipeline stages.",
			"COMMENT_BODY_END",
		].join("\n");
		const result = extractAgentCommentBody(output);
		assert.ok(result, "should extract comment body");
		assert.ok(result!.includes("## Architecture"), "section heading preserved");
		assert.ok(result!.includes("clean layered design"), "content preserved");
		assert.ok(!result!.includes("$ npm test"), "$ command line filtered");
		assert.ok(!result!.includes("$ echo hello"), "$ echo line filtered");
		assert.ok(!result!.includes("$ ls -la"), "$ ls line filtered");
	});

	it("filters read/write/edit/grep/ls/find tool lines from comment body", () => {
		const output = [
			"COMMENT_BODY:",
			"## Analysis",
			"read /path/file.ts:10-30",
			"write /path/file.ts (5 lines)",
			"grep /pattern/ in /src",
			"ls /home",
			"",
			"The analysis reveals several important findings across the codebase.",
			"Each finding has been verified with concrete evidence and reproduction.",
			"COMMENT_BODY_END",
		].join("\n");
		const result = extractAgentCommentBody(output);
		assert.ok(result, "should extract comment body");
		assert.ok(result!.includes("## Analysis"), "section heading preserved");
		assert.ok(result!.includes("analysis reveals several important findings"), "content preserved");
		assert.ok(!result!.includes("read /path/file.ts"), "read line filtered");
		assert.ok(!result!.includes("write /path/file.ts"), "write line filtered");
		assert.ok(!result!.includes("grep /pattern/"), "grep line filtered");
		assert.ok(!result!.includes("ls /home"), "ls line filtered");
	});

	it("filters fallback format (web_search: ...) lines from comment body", () => {
		const output = [
			"COMMENT_BODY:",
			'web_search: {"query":"typescript"}',
			'ripgrep_search: {"pattern":"TODO"}',
			"",
			"Research results show that TypeScript interfaces are the preferred pattern.",
			"Multiple codebases confirm this best practice across the ecosystem.",
			"COMMENT_BODY_END",
		].join("\n");
		const result = extractAgentCommentBody(output);
		assert.ok(result, "should extract comment body");
		assert.ok(result!.includes("Research results show"), "content preserved");
		assert.ok(!result!.includes("web_search:"), "fallback format line filtered");
		assert.ok(!result!.includes("ripgrep_search:"), "ripgrep fallback line filtered");
	});

	it("filters old-format 🔧 lines (backward compat)", () => {
		const output = [
			"COMMENT_BODY:",
			'🔧 read_file {"path":"/x"}',
			"🔧 bash: npm test",
			'🔧 search_code {"query":"foo"}',
			"",
			"The project has several important findings across the codebase.",
			"Each finding has been verified with concrete evidence for accuracy.",
			"COMMENT_BODY_END",
		].join("\n");
		const result = extractAgentCommentBody(output);
		assert.ok(result, "should extract comment body");
		assert.ok(result!.includes("important findings"), "content preserved");
		assert.ok(!result!.includes("🔧 read_file"), "old-format read_file line filtered");
		assert.ok(!result!.includes("🔧 bash"), "old-format bash line filtered");
		assert.ok(!result!.includes("🔧 search_code"), "old-format search_code line filtered");
	});

	it("preserves regular non-tool content", () => {
		const output = [
			"COMMENT_BODY:",
			"## Architecture",
			"",
			"This is the actual design document with multiple paragraphs describing the system.",
			"It contains the full architecture description for the entire project structure.",
			"",
			"### Key Decisions",
			"- Decision 1: Use TypeScript for type safety across all modules",
			"- Decision 2: Node.js built-in test runner for deterministic testing",
			"COMMENT_BODY_END",
		].join("\n");
		const result = extractAgentCommentBody(output);
		assert.ok(result, "should extract comment body");
		assert.ok(result!.includes("## Architecture"), "heading preserved");
		assert.ok(result!.includes("actual design document"), "paragraph preserved");
		assert.ok(result!.includes("- Decision 1"), "bullet point preserved");
	});

	it("handles $ as bare dollar sign (no space) — isToolCallLine returns true for bare $", () => {
		// bare "$" is a tool call line and should be filtered
		assert.equal(isToolCallLine("$"), true);
	});

	it("extractAgentCommentBody is a function", () => {
		assert.equal(typeof extractAgentCommentBody, "function");
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

// ─── Tests: stripTrailingMetadata extracted helper ─────────────────

describe("stripTrailingMetadata — extracted helper", () => {
	it("heading section followed by JSON block → commentBody truncated before JSON", async () => {
		const { stripTrailingMetadata } = await import("../../github/comment.ts");
		const heading = "## Audit Approved";
		// Add enough content to pass the minHeadingLen + 20 boundary guard (36 chars from start)
		// JSON keys on separate lines (matches agent output format)
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		const jsonBlock = '\n"auditScore": {\n  "passing": 3,\n  "total": 5\n}';
		const slice = heading + "\n\n" + content + "\n\n" + jsonBlock;
		const result = stripTrailingMetadata(slice, heading.length);
		assert.ok(!result.includes("auditScore"), "should not include JSON block");
		assert.ok(result.includes(content), "should keep heading section text");
	});

	it("heading section followed by 💭 thinking → commentBody truncated before thinking", async () => {
		const { stripTrailingMetadata } = await import("../../github/comment.ts");
		const heading = "## Audit Approved";
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		const slice = heading + "\n\n" + content + "\n💭 The agent is thinking about something\n";
		const result = stripTrailingMetadata(slice, heading.length);
		assert.ok(result.includes(content), "should keep heading section text");
		assert.ok(!result.includes("The agent is thinking"), "should exclude thinking content");
	});

	it("heading section followed by 📊 instrumentation → commentBody truncated before instrumentation", async () => {
		const { stripTrailingMetadata } = await import("../../github/comment.ts");
		const heading = "## Audit Approved";
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		const slice = heading + "\n\n" + content + "\n📊 Some instrumentation data\n";
		const result = stripTrailingMetadata(slice, heading.length);
		assert.ok(result.includes(content), "should keep heading section text");
		assert.ok(!result.includes("instrumentation"), "should exclude instrumentation content");
	});

	it("heading section with all three trailing patterns → earliest match wins (shortest truncation)", async () => {
		const { stripTrailingMetadata } = await import("../../github/comment.ts");
		const heading = "## Audit Approved";
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		// JSON (keys on separate lines) appears first, then thinking, then instrumentation
		const jsonBlock = '\n"auditScore": {\n  "passing": 3,\n  "total": 5\n}';
		const slice =
			heading + "\n\n" + content + "\n" + jsonBlock + "\n💭 thinking\n📊 instrumentation";
		const result = stripTrailingMetadata(slice, heading.length);
		// Should be truncated at JSON (earliest match)
		assert.ok(!result.includes("auditScore"), "should truncate at JSON (earliest match)");
		assert.ok(result.includes(content), "should keep heading section text");
	});

	it("heading section with no trailing metadata → content unchanged", async () => {
		const { stripTrailingMetadata } = await import("../../github/comment.ts");
		const heading = "## Audit Approved";
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		const slice = heading + "\n\n" + content + "\n";
		const result = stripTrailingMetadata(slice, heading.length);
		assert.equal(result, slice, "content should remain unchanged");
	});

	it("trailing metadata within 20 chars of heading length → not truncated (boundary guard)", async () => {
		const { stripTrailingMetadata } = await import("../../github/comment.ts");
		const heading = "## A";
		// Metadata (key on separate line) appears very close to heading (within 20 chars) — should not truncate
		const slice = heading + "\n\n" + '\n"auditScore": 1';
		const result = stripTrailingMetadata(slice, heading.length);
		// The minHeadingLen + 20 guard should prevent truncation since the JSON is too close
		assert.equal(result, slice, "should not truncate when metadata is too close to heading");
	});
});
