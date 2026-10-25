import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { ExecFn } from "../../../lib/port-types.ts";

import { extractStructuredAuditOutput, extractAgentCommentBody } from "../../agent/output.ts";

function createMockExec(execResult: { code: number; stdout: string; stderr: string }): ExecFn {
	return async () => ({ ...execResult, killed: false });
}

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

	it("filters extension tool lines (web_search, ripgrep_search) via session-state toolNames", () => {
		const output = [
			"COMMENT_BODY:",
			'web_search: {"query":"typescript"}',
			'ripgrep_search: {"pattern":"TODO"}',
			"",
			"Research results show that TypeScript interfaces are the preferred pattern.",
			"Multiple codebases confirm this best practice across the ecosystem.",
			"COMMENT_BODY_END",
		].join("\n");
		const toolNames = new Set([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"web_search",
			"ripgrep_search",
		]);
		const result = extractAgentCommentBody(output, toolNames);
		assert.ok(result, "should extract comment body");
		assert.ok(result!.includes("Research results show"), "content preserved");
		assert.ok(!result!.includes("web_search:"), "fallback format line filtered via toolNames");
		assert.ok(!result!.includes("ripgrep_search:"), "ripgrep fallback line filtered via toolNames");
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

	it("extractAgentCommentBody is a function", () => {
		assert.equal(typeof extractAgentCommentBody, "function");
	});
});
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
describe("stripTrailingMetadata — extracted helper", () => {
	it("heading section followed by JSON block → commentBody truncated before JSON", async () => {
		const { stripTrailingMetadata } = await import("../../agent/output.ts");
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
		const { stripTrailingMetadata } = await import("../../agent/output.ts");
		const heading = "## Audit Approved";
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		const slice = heading + "\n\n" + content + "\n💭 The agent is thinking about something\n";
		const result = stripTrailingMetadata(slice, heading.length);
		assert.ok(result.includes(content), "should keep heading section text");
		assert.ok(!result.includes("The agent is thinking"), "should exclude thinking content");
	});

	it("heading section followed by 📊 instrumentation → commentBody truncated before instrumentation", async () => {
		const { stripTrailingMetadata } = await import("../../agent/output.ts");
		const heading = "## Audit Approved";
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		const slice = heading + "\n\n" + content + "\n📊 Some instrumentation data\n";
		const result = stripTrailingMetadata(slice, heading.length);
		assert.ok(result.includes(content), "should keep heading section text");
		assert.ok(!result.includes("instrumentation"), "should exclude instrumentation content");
	});

	it("heading section with all three trailing patterns → earliest match wins (shortest truncation)", async () => {
		const { stripTrailingMetadata } = await import("../../agent/output.ts");
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
		const { stripTrailingMetadata } = await import("../../agent/output.ts");
		const heading = "## Audit Approved";
		const content = "This review finds the implementation acceptable with minor formatting nits.";
		const slice = heading + "\n\n" + content + "\n";
		const result = stripTrailingMetadata(slice, heading.length);
		assert.equal(result, slice, "content should remain unchanged");
	});

	it("trailing metadata within 20 chars of heading length → not truncated (boundary guard)", async () => {
		const { stripTrailingMetadata } = await import("../../agent/output.ts");
		const heading = "## A";
		// Metadata (key on separate line) appears very close to heading (within 20 chars) — should not truncate
		const slice = heading + "\n\n" + '\n"auditScore": 1';
		const result = stripTrailingMetadata(slice, heading.length);
		// The minHeadingLen + 20 guard should prevent truncation since the JSON is too close
		assert.equal(result, slice, "should not truncate when metadata is too close to heading");
	});
});
