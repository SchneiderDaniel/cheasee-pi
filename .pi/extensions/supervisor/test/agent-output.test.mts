// ─── Tests: agent-output.ts — Phase 1: AgentOutput type + parseAgentOutput ──
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput, stripAnsi } from "../agent/output.ts";
import type { AgentOutput, FailedParse } from "../config/types.ts";

// ─── Helper ────────────────────────────────────────────────────────

function isFailedParse(r: AgentOutput | FailedParse): r is FailedParse {
	return "error" in r && "rawOutput" in r;
}

function isAgentOutput(r: AgentOutput | FailedParse): r is AgentOutput {
	return "action" in r && "agentName" in r;
}

// ─── Tests: stripAnsi ─────────────────────────────────────────────

describe("stripAnsi()", () => {
	it("strips ANSI escape sequences", () => {
		const input = "\x1b[32mHello\x1b[0m World";
		assert.equal(stripAnsi(input), "Hello World");
	});

	it("returns empty string for empty input", () => {
		assert.equal(stripAnsi(""), "");
	});

	it("preserves text without ANSI", () => {
		const input = "Plain text";
		assert.equal(stripAnsi(input), "Plain text");
	});

	it("strips multiple ANSI sequences", () => {
		const input = "\x1b[1m\x1b[31mBold Red\x1b[0m \x1b[32mGreen\x1b[0m";
		assert.equal(stripAnsi(input), "Bold Red Green");
	});
});

// ─── Tests: parseAgentOutput — valid JSON ─────────────────────────

describe("parseAgentOutput — valid JSON", () => {
	it("parses valid JSON with minimal fields", () => {
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should be AgentOutput");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
	});

	it("parses JSON with all fields", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			summary: "All checks pass",
			commentBody: "## Audit Approved\nLooks good",
			prTitle: "feat(#123): test",
			prBody: "## PR Body\nDetails",
			auditScore: { passing: 5, total: 6 },
			findings: [
				{
					severity: "warning",
					dimension: "code-quality",
					symptom: "Code style inconsistency",
					consequence: "Harder to maintain",
					remedy: "Run formatter",
				},
			],
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		const o = result as AgentOutput;
		assert.equal(o.action, "APPROVED");
		assert.equal(o.agentName, "auditor");
		assert.equal(o.auditScore?.passing, 5);
		assert.equal(o.auditScore?.total, 6);
		assert.equal(o.findings?.length, 1);
		assert.equal(o.findings![0].severity, "warning");
	});

	it("parses REJECTED action", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			commentBody: "## Audit Rejected\nIssues found",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "REJECTED");
	});

	it("handles empty findings array", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [],
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.deepEqual((result as AgentOutput).findings, []);
	});
});

// ─── Tests: parseAgentOutput — malformed JSON ─────────────────────

describe("parseAgentOutput — malformed JSON", () => {
	it("rejects malformed JSON with descriptive error", () => {
		const input = "{ invalid json }";
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		const f = result as FailedParse;
		assert.ok(f.error.includes("Failed to parse"), `error should mention parsing: ${f.error}`);
		assert.equal(f.rawOutput, input);
	});

	it("rejects empty input", () => {
		const result = parseAgentOutput("");
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});

	it("rejects null input", () => {
		const result = parseAgentOutput(null as unknown as string);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});

	it("rejects undefined input", () => {
		const result = parseAgentOutput(undefined as unknown as string);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});

	it("rejects input that is only whitespace", () => {
		const result = parseAgentOutput("   \n  \t  ");
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});
});

// ─── Tests: parseAgentOutput — schema validation ──────────────────

describe("parseAgentOutput — schema validation", () => {
	it("rejects missing action field", () => {
		const input = JSON.stringify({ agentName: "developer" });
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("action"));
	});

	it("rejects missing agentName field", () => {
		const input = JSON.stringify({ action: "COMPLETE" });
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("agentname"));
	});

	it("rejects invalid action enum value", () => {
		const input = JSON.stringify({
			action: "INVALID_ACTION",
			agentName: "developer",
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("action"));
	});

	it("rejects non-string agentName", () => {
		const input = JSON.stringify({ action: "COMPLETE", agentName: 42 });
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("agentname"));
	});

	it("rejects auditScore without total field", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 5 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("auditscore"));
	});

	it("rejects auditScore with non-numeric fields", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: "5", total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("auditscore"));
	});

	it("rejects auditScore with negative passing", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: -1, total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
	});

	it("rejects auditScore where passing > total", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 7, total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("auditscore"));
	});

	it("accepts auditScore where passing == total", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 6, total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
	});

	it("rejects findings with invalid severity", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings: [
				{
					severity: "fatal",
					dimension: "code-quality",
					symptom: "Bad",
					consequence: "Bad",
					remedy: "Fix",
				},
			],
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("severity"));
	});

	it("rejects findings with missing required fields", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings: [{ severity: "critical" }],
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
	});

	it("rejects findings when findings is not an array", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings: "not an array",
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
	});
});

// ─── Tests: parseAgentOutput — JSON in code fences ────────────────

describe("parseAgentOutput — JSON in code fences", () => {
	it("extracts JSON from ```json … ``` code fence", () => {
		const input = [
			"Some text before",
			"```json",
			JSON.stringify({ action: "COMPLETE", agentName: "developer" }),
			"```",
			"Some text after",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("extracts JSON from ``` … ``` code fence (no language)", () => {
		const input = [
			"Some text",
			"```",
			JSON.stringify({ action: "APPROVED", agentName: "auditor" }),
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "APPROVED");
	});

	it("handles JSON in code fence with extra whitespace", () => {
		const input = [
			"```json",
			"  ",
			JSON.stringify({ action: "COMPLETE", agentName: "test-designer" }),
			"  ",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
	});
});

// ─── Tests: parseAgentOutput — extra surrounding text ─────────────

describe("parseAgentOutput — extra surrounding text", () => {
	it("extracts last JSON block from text with extra content", () => {
		const input =
			"Thinking about this...\nLet me output:\n" +
			JSON.stringify({ action: "COMPLETE", agentName: "developer" }) +
			"\nDone!";
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("prefers last JSON block when multiple JSON objects present", () => {
		const input =
			JSON.stringify({ action: "COMPLETE", agentName: "researcher" }) +
			"\nActually no, I changed my mind\n" +
			JSON.stringify({ action: "COMPLETE", agentName: "developer" });
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).agentName, "developer");
	});

	it("extracts only the outer JSON object, not nested ones", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "warning",
					dimension: "code-quality" as const,
					symptom: "Bad",
					consequence: "Bad",
					remedy: "Fix",
				},
			],
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
	});
});

// ─── Tests: parseAgentOutput — refusal handling ───────────────────

describe("parseAgentOutput — refusal handling", () => {
	it("returns FailedParse when refusal field is present", () => {
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			refusal: "I cannot complete this task due to safety concerns",
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		const f = result as FailedParse;
		assert.ok(f.error.includes("refused"), `error should mention refused: ${f.error}`);
	});
});

// ─── Tests: parseAgentOutput — ANSI stripping ─────────────────────

describe("parseAgentOutput — ANSI stripping", () => {
	it("strips ANSI escape sequences before parsing", () => {
		const input =
			"\x1b[32m" + JSON.stringify({ action: "COMPLETE", agentName: "developer" }) + "\x1b[0m";
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("strips ANSI around JSON code fences", () => {
		const input =
			"\x1b[1mHere is my output:\x1b[0m\n```json\n" +
			JSON.stringify({ action: "APPROVED", agentName: "auditor" }) +
			"\n```\n\x1b[32mDone\x1b[0m";
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "APPROVED");
	});
});

// ─── Tests: parseAgentOutput — edge cases ─────────────────────────

describe("parseAgentOutput — edge cases", () => {
	it("handles very long JSON in agent output", () => {
		const findings = Array.from({ length: 50 }, (_, i) => ({
			severity: "warning" as const,
			dimension: "code-quality" as const,
			symptom: "Issue " + i,
			consequence: "Bad",
			remedy: "Fix",
		}));
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings,
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).findings?.length, 50);
	});

	it("handles line break characters in string values", () => {
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			commentBody: "## Summary\nThis is a multi-line\ncomment body\nwith line breaks",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.ok((result as AgentOutput).commentBody?.includes("line breaks"));
	});

	it("handles literal newlines in JSON string values (agent-style output)", () => {
		// Agents often output JSON with actual \n characters instead of \\n escapes
		const input = `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\nMy approach"}`;
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should parse despite literal newline");
		const agentOut = result as AgentOutput;
		assert.ok(agentOut.commentBody?.includes("Architecture"));
		assert.ok(agentOut.commentBody?.includes("My approach"));
	});

	it("handles literal newline in JSON inside code fence", () => {
		const input = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "researcher",',
			'  "commentBody": "## Findings\nFound stuff"',
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should parse literal newline in code fence");
		assert.ok((result as AgentOutput).commentBody?.includes("Findings"));
	});

	it("strips ANSI codes from JSON extracted from code fences", () => {
		const input = [
			"```json",
			"\x1b[32m" + JSON.stringify({ action: "COMPLETE", agentName: "developer" }) + "\x1b[0m",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("extracts JSON with triple-backtick code blocks inside commentBody", () => {
		// Real agents (researcher, architect) include markdown code blocks
		// in their commentBody. The old fence regex stopped at the first ```
		// inside a JSON string value, truncating the JSON. Brace matching
		// (primary since the fix) correctly ignores ``` inside strings.
		const input = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "researcher",',
			'  "commentBody": "## Research Findings\\n\\n### Best Practices\\n- Use `structuredClone()` for deep copies\\n```ts\\nconst copy = structuredClone(obj);\\n```\\n- Source: https://example.com"',
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should extract JSON with triple backticks in commentBody");
		const agentOut = result as AgentOutput;
		assert.ok(agentOut.commentBody?.includes("structuredClone"));
		assert.ok(agentOut.commentBody?.includes("```ts"));
	});

	it("extracts JSON with unescaped double-quotes in commentBody (agent-style)", () => {
		// Agents commonly produce JSON with unescaped double-quotes inside
		// string values like commentBody. The old extractLastJson used naive
		// " toggling for string boundaries, which broke brace matching when
		// commentBody contained markdown quotes (e.g. the file "index.ts").
		// Smart quote detection (isStructuralQuote) fixes this.
		// Template literal used to embed unescaped " inside the JSON.
		const input = `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\\nWe use the file "index.ts" directly","summary":"Done"}`;
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should parse JSON with unescaped quotes in commentBody");
		const agentOut = result as AgentOutput;
		assert.equal(agentOut.action, "COMPLETE");
		assert.equal(agentOut.agentName, "architect");
		assert.ok(agentOut.commentBody?.includes("Architecture"));
		assert.equal(agentOut.summary, "Done");
	});

	it("extracts JSON with braces in commentBody alongside unescaped quotes", () => {
		// When commentBody contains both unescaped quotes AND curly braces
		// (e.g. markdown code blocks with function bodies), the old brace
		// matching would break completely. Smart quote detection keeps the
		// string boundary tracking correct even with both issues present.
		const input =
			'{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\\nCode: function foo() { return bar; } uses \"utils.ts\"","summary":"Done"}';
		const result = parseAgentOutput(input);
		assert.ok(
			isAgentOutput(result),
			"should parse JSON with braces AND unescaped quotes in commentBody",
		);
		const agentOut = result as AgentOutput;
		assert.equal(agentOut.action, "COMPLETE");
		assert.equal(agentOut.agentName, "architect");
		assert.ok(agentOut.commentBody?.includes("foo()"));
		assert.ok(agentOut.commentBody?.includes("utils.ts"));
		assert.equal(agentOut.summary, "Done");
	});
});

// ─── Characterization: current resolveNextStatus + extractStructuredAuditOutput ──
// These capture the current behavior to ensure backward compatibility.

describe("characterization — resolveNextStatus compatibility", () => {
	it("extracts AUDIT_DECISION: APPROVED → Done", () => {
		// This replaces the old resolveNextStatus + extractStructuredAuditOutput
		// behavior. The new parseAgentOutput should produce equivalent decisions.
		const output = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			summary: "Audit approved",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "APPROVED");
	});

	it("extracts AUDIT_DECISION: REJECTED → Implementation", () => {
		const output = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			commentBody: "## Audit Rejected\nIssues",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "REJECTED");
	});
});

describe("characterization — extractAuditScore compatibility", () => {
	it("extracts audit score from AgentOutput", () => {
		const output = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 5, total: 6 },
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		const o = result as AgentOutput;
		assert.equal(o.auditScore?.passing, 5);
		assert.equal(o.auditScore?.total, 6);
	});

	it("returns no audit score when absent", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		const o = result as AgentOutput;
		assert.equal(o.auditScore, undefined);
	});
});

describe("characterization — extractAgentCommentBody compatibility", () => {
	it("extracts commentBody from AgentOutput", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			commentBody: "## Architecture\nMy design approach",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).commentBody, "## Architecture\nMy design approach");
	});

	it("returns no commentBody when absent", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).commentBody, undefined);
	});
});

describe("characterization — extractSummaryLine compatibility", () => {
	it("extracts summary from AgentOutput", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			summary: "Implemented the feature",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).summary, "Implemented the feature");
	});

	it("returns no summary when absent", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).summary, undefined);
	});
});

describe("extractLastJson — string-boundary-aware brace matching", () => {
	it("extracts JSON from text with braces in tool args", () => {
		const fullLog = [
			'🔧 search_code {"pattern":"function.*{","path":"/src"}',
			"✓ search_code",
			'🔧 read_file {"path":"/src/{feature,x}.ts"}',
			"✓ read_file",
			"💭 I see the issue",
			"",
			'{"commentBody":"Architect review","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from text with tool arg braces");
		assert.equal((result as AgentOutput).commentBody, "Architect review");
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("extracts JSON when tool args have unbalanced braces", () => {
		const fullLog = [
			'🔧 search_code {"pattern":"if({{{","path":"/src"}',
			"✓ search_code",
			"💭 Found issue",
			"",
			'{"commentBody":"Fix nested brace","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON despite unbalanced braces in tool args");
		assert.equal((result as AgentOutput).commentBody, "Fix nested brace");
	});

	it("extracts JSON when commentBody contains braces", () => {
		const fullLog =
			'{"commentBody":"Fix {the off-by-one} in loop","action":"COMPLETE","agentName":"architect"}';
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON with braces in commentBody");
		assert.equal((result as AgentOutput).commentBody, "Fix {the off-by-one} in loop");
	});

	it("extracts JSON with mixed content (tool logs, thinking, JSON)", () => {
		const fullLog = [
			'🔧 read_file {"path":"/src/auth.ts"}',
			"✓ read_file",
			"💭 Need to check the auth flow",
			'🔧 search_code {"query":"function login"}',
			"✓ search_code",
			"",
			'{"commentBody":"Mixed content review","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from mixed content");
		assert.equal((result as AgentOutput).commentBody, "Mixed content review");
	});

	it("still extracts code-fenced JSON correctly", () => {
		const fullLog = [
			"Some text before",
			"",
			"\`\`\`json",
			'{"commentBody":"Code fenced","action":"COMPLETE","agentName":"researcher"}',
			"\`\`\`",
			"Some text after",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse code-fenced JSON");
		assert.equal((result as AgentOutput).commentBody, "Code fenced");
	});

	it("handles pure JSON (no surrounding text)", () => {
		const json = '{"commentBody":"Pure JSON","action":"COMPLETE","agentName":"architect"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse pure JSON");
		assert.equal((result as AgentOutput).commentBody, "Pure JSON");
	});

	it("extracts last JSON when multiple JSON objects present", () => {
		const fullLog = [
			'{"commentBody":"First JSON","action":"COMPLETE","agentName":"architect"}',
			"some text",
			'{"commentBody":"Last JSON","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must pick last JSON object");
		assert.equal((result as AgentOutput).commentBody, "Last JSON");
	});

	// ── Fence scanner regression tests ──
	// Session 6 regression: brace-first approach broke architect because
	// markdown template {…} after code fence was picked up as "last JSON".
	// Fence scanner must find code-fenced JSON even when non-JSON braces
	// appear after the fence.

	it("ignores non-JSON braces in markdown after code fence", () => {
		// Architect output: JSON in code fence, then markdown with template braces
		const fullLog = [
			"Here is my architecture analysis:",
			"",
			"```json",
			'{"commentBody":"Architect design","action":"COMPLETE","agentName":"architect"}',
			"```",
			"",
			"The implementation should use `{ key: value }` objects.",
			"You can also use `{ foo: bar }` for config.",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse code-fenced JSON, not markdown template braces");
		assert.equal((result as AgentOutput).commentBody, "Architect design");
	});

	it("handles triple-backtick code blocks with literal newlines in commentBody", () => {
		// Researcher output: commentBody contains literal newlines and triple backticks.
		// This happens when fullLog entries are joined with \n — the JSON string
		// value contains literal newline characters (not \\n escape sequences).
		// jsonrepair escapes literal newlines to \\n for valid JSON parsing.
		const fullLog = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "researcher",',
			`  "commentBody": "## Findings\n\n\`\`\`bash\ntest command\n\`\`\`\nDone"`,
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(
			isAgentOutput(result),
			"must parse JSON despite literal newlines + triple backticks in commentBody",
		);
		const agentOut = result as AgentOutput;
		assert.ok(agentOut.commentBody?.includes("test command"));
		assert.ok(agentOut.commentBody?.includes("```bash"));
	});

	it("picks last code fence when multiple fences exist", () => {
		// Agent may produce multiple code fences (e.g. showing example code
		// then the JSON output). Fence scanner must pick the LAST one.
		const fullLog = [
			"```json",
			'{"commentBody":"First JSON","action":"COMPLETE","agentName":"architect"}',
			"```",
			"Some text",
			"```json",
			'{"commentBody":"Final JSON","action":"COMPLETE","agentName":"architect"}',
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse last code-fenced JSON");
		assert.equal((result as AgentOutput).commentBody, "Final JSON");
	});

	it("handles code fence without 'json' language tag", () => {
		// Agent may use bare ``` without language tag
		const fullLog = [
			"```",
			'{"commentBody":"No lang tag","action":"COMPLETE","agentName":"architect"}',
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON in bare ``` fence");
		assert.equal((result as AgentOutput).commentBody, "No lang tag");
	});

	// ── Bug fix: `}` inside string values ──
	// Session 7 bug: brace counting without string-boundary tracking
	// truncated JSON when `}` appeared inside a JSON string value.
	// These tests verify the string-boundary-aware brace counting fix.

	it("extracts full JSON when `}` appears mid-string (the exact bug)", () => {
		// `}` in middle of string value — old code truncated at this position
		const json =
			'{"action":"COMPLETE","agentName":"researcher","commentBody":"Found issue: edge case } in config parsing","summary":"Research complete"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with } mid-string");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "researcher");
		assert.ok(o.commentBody?.includes("edge case } in config parsing"));
		assert.equal(o.summary, "Research complete");
	});

	it("extracts full JSON when `}` appears at start of string value", () => {
		// `}` right after opening quote — old code closed outer brace immediately
		const json =
			'{"action":"COMPLETE","agentName":"developer","commentBody":"} unexpected at start"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with } at start of string");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
		assert.ok(o.commentBody?.includes("} unexpected"));
	});

	it("extracts full JSON when `}` appears at end of string value", () => {
		// `}` at end of string value
		const json = '{"action":"COMPLETE","agentName":"developer","commentBody":"project}"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with } at end of string");
		const o = result as AgentOutput;
		assert.equal(o.commentBody, "project}");
	});

	it("extracts full JSON with multiple `}` in same string", () => {
		// Multiple `}` characters in the same string value
		const json =
			'{"action":"COMPLETE","agentName":"developer","commentBody":"Unexpected token } at line }"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with multiple } in string");
		const o = result as AgentOutput;
		assert.equal(o.commentBody, "Unexpected token } at line }");
	});

	it("extracts full JSON when `}` would drop trailing field", () => {
		// `}` mid-string before summary field — summary must be preserved
		const json =
			'{"action":"COMPLETE","agentName":"architect","commentBody":"Found } in code","summary":"Must be preserved"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with } before trailing field");
		const o = result as AgentOutput;
		assert.equal(o.commentBody, "Found } in code");
		assert.equal(o.summary, "Must be preserved");
	});

	it("extracts full JSON when string contains only `}`", () => {
		// Minimal edge case: string value is just a closing brace
		const json = '{"action":"COMPLETE","agentName":"developer","commentBody":"}"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with single } string value");
		const o = result as AgentOutput;
		assert.equal(o.commentBody, "}");
	});

	it("extracts full JSON with balanced braces inside string (regression)", () => {
		// Balanced {} inside string — both before and after the fix this should work
		const json =
			'{"commentBody":"Fix {the off-by-one} in loop","action":"COMPLETE","agentName":"architect"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with balanced braces in string");
		assert.equal((result as AgentOutput).commentBody, "Fix {the off-by-one} in loop");
	});

	it("extracts full JSON with } in string alongside unescaped quotes (regression)", () => {
		// Combined case: both unescaped quotes and } in string
		const json =
			'{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\\nFound } in \\"file.ts\\"","summary":"Done"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse JSON with } and unescaped quotes");
		const o = result as AgentOutput;
		assert.ok(o.commentBody?.includes("}"));
		assert.equal(o.summary, "Done");
	});

	it("still extracts code-fenced JSON with `}` in string values (regression)", () => {
		// Code fence path should be unaffected by Step 3 changes
		const fullLog = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "researcher",',
			'  "commentBody": "Found } in fence",',
			'  "summary": "Done"',
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse code-fenced JSON with } in string");
		const o = result as AgentOutput;
		assert.equal(o.commentBody, "Found } in fence");
		assert.equal(o.summary, "Done");
	});
});

// ─── Tests: thinking-prefix stripping — JSON in thinking blocks ────
// When agents use thinking:high, JSON output may be emitted inside
// thinking blocks. Event handlers push thinking lines to fullLog with
// "💭 " prefix per line. The prefix stripping inside extractLastJson
// removes these prefixes so parseAgentOutput can still extract valid JSON.

describe("parseAgentOutput — JSON in thinking blocks (💭 prefix)", () => {
	it("extracts JSON from thinking-prefixed lines (thinking:high scenario)", () => {
		// Simulates fullLog when thinking:high agent outputs JSON inside thinking blocks
		const fullLog = [
			"💭 I need to design the architecture for this feature",
			"💭 Let me consider the clean architecture approach",
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "## Architecture - My design approach",',
			'💭   "summary": "Proposed architecture"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON embedded in thinking blocks");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "architect");
		assert.equal(o.commentBody, "## Architecture - My design approach");
		assert.equal(o.summary, "Proposed architecture");
	});

	it("extracts JSON from mixed thinking+tool+text fullLog", () => {
		// Realistic fullLog: tool calls + thinking + JSON-in-thinking
		const fullLog = [
			'🔧 read_file {"path":"/src/module.ts"}',
			"✓ read_file",
			"💭 Analyzing code structure",
			'🔧 search_code {"pattern":"class.*Module"}',
			"✓ search_code",
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "Review complete"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from mixed log with 💭 prefix");
		assert.equal((result as AgentOutput).commentBody, "Review complete");
	});

	it("handles JSON entirely in thinking blocks (no text blocks)", () => {
		// JSON entirely within thinking blocks, no separate text output
		const fullLog = [
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "## Summary - Just thinking through this"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from pure thinking output");
		assert.ok((result as AgentOutput).commentBody?.includes("Summary"));
	});

	it("still handles normal (non-prefixed) JSON correctly", () => {
		// Regression: ensure non-prefixed JSON still works
		const json = '{"commentBody":"Normal text block","action":"COMPLETE","agentName":"architect"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must still parse normal JSON");
		assert.equal((result as AgentOutput).commentBody, "Normal text block");
	});

	it("handles JSON in code fence mixed with thinking prefix", () => {
		// JSON inside code fence but with some thinking lines before
		const fullLog = [
			"💭 Let me output the JSON",
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "architect",',
			'  "commentBody": "Code fenced approach"',
			"}",
			"```",
			"💭 And I'm done",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse code-fenced JSON with thinking lines");
		assert.equal((result as AgentOutput).commentBody, "Code fenced approach");
	});

	it("handles multi-line commentBody in thinking blocks", () => {
		// commentBody with embedded newline (\\n escape in JSON) inside thinking prefix
		const fullLog = [
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "## Summary\\nJust thinking through this"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(
			isAgentOutput(result),
			"must parse JSON with \\\\n in commentBody in thinking blocks",
		);
		// The \\n in the JSON text (from JavaScript string \\\\n) becomes \n after JSON.parse,
		// which is a literal backslash followed by n (not a real newline)
		assert.ok((result as AgentOutput).commentBody?.includes("Summary"));
		assert.ok(
			(result as AgentOutput).commentBody?.includes("\\n") ||
				(result as AgentOutput).commentBody?.includes("\n"),
		);
	});
});

// ─── Tests: new-format tool call line filtering ───────────────────
// Phase 3: extractLastJson must filter new-format tool lines before
// brace counting to prevent false brace matches.

describe("parseAgentOutput — new-format tool call filtering", () => {
	it("filters bash lines ($ cmd) with JSON-like braces", () => {
		const fullLog = [
			'$ echo {"x":1}',
			'$ echo {"y":2}',
			"",
			'{"commentBody":"After bash","action":"COMPLETE","agentName":"developer"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must filter $ prefixed lines with braces and extract JSON");
		assert.equal((result as AgentOutput).commentBody, "After bash");
	});

	it("filters read/write/edit/grep/ls/find lines between thinking and JSON", () => {
		const fullLog = [
			"💭 Let me check the file",
			"read /path/file.ts:10-30",
			"write /path/file.ts (5 lines)",
			"",
			'{"commentBody":"Between tool calls","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must filter new-format tool lines");
		assert.equal((result as AgentOutput).commentBody, "Between tool calls");
	});

	it("filters grep with pattern containing braces", () => {
		const fullLog = [
			"grep /function.*{/ in /src",
			"",
			'{"commentBody":"After grep","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must filter grep lines with braces in pattern");
		assert.equal((result as AgentOutput).commentBody, "After grep");
	});

	it("mixing old-format and new-format tool lines both get filtered", () => {
		const fullLog = [
			'🔧 read_file {"path":"/src/x.ts"}',
			"✓ read_file",
			"$ npm test",
			"grep /TODO/ in /src",
			"",
			'{"commentBody":"Mixed formats","action":"COMPLETE","agentName":"developer"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must filter both old and new format tool lines");
		assert.equal((result as AgentOutput).commentBody, "Mixed formats");
	});

	it("fallback format (web_search: {...}) lines are filtered", () => {
		const fullLog = [
			'web_search: {"query":"typescript"}',
			"",
			'{"commentBody":"After web search","action":"COMPLETE","agentName":"researcher"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must filter fallback format tool lines with braces");
		assert.equal((result as AgentOutput).commentBody, "After web search");
	});

	it("bash line without braces does not create false brace match", () => {
		const fullLog = [
			"$ npm test",
			"$ ls -la",
			"",
			'{"commentBody":"Clean test","action":"COMPLETE","agentName":"developer"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON despite non-brace bash lines");
		assert.equal((result as AgentOutput).commentBody, "Clean test");
	});

	it("bash with echo {} alone (no real JSON) fails parse gracefully", () => {
		const fullLog = ["$ echo {}", "$ echo more"].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isFailedParse(result), "must fail to parse when only {} from tool call");
	});

	it("pure JSON without any tool lines still extracts correctly (regression)", () => {
		const json = '{"commentBody":"Regression test","action":"COMPLETE","agentName":"developer"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must still parse pure JSON");
		assert.equal((result as AgentOutput).commentBody, "Regression test");
	});

	it("JSON in code fence still extracts alongside new-format tool lines (regression)", () => {
		const fullLog = [
			"$ npm test",
			"read /path/file.ts",
			"",
			"\`\`\`json",
			'{"commentBody":"Code fenced","action":"COMPLETE","agentName":"developer"}',
			"\`\`\`",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(
			isAgentOutput(result),
			"must extract JSON from code fence with new-format tool lines",
		);
		assert.equal((result as AgentOutput).commentBody, "Code fenced");
	});
});

// ─── Corpus: malformed JSON repair ────────────────────────────────
// Black-box corpus assertions: "this raw stream → this AgentOutput".
// jsonrepair owns repair correctness; these tests lock the invariant
// that the pipeline produces the expected AgentOutput from real-world
// malformed agent outputs.
//
// The corpus should grow as new malformed patterns are discovered in
// production. Add entries as { raw: string, expected: Partial<AgentOutput> }
// to this describe block.

describe("parseAgentOutput — malformed JSON corpus (repair invariant)", () => {
	it("repairs literal newlines in string values", () => {
		// Agents often output JSON with actual \n instead of \\n escapes
		const input = `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\nMy approach"}`;
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should repair literal newline in string");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "architect");
		assert.ok(o.commentBody?.includes("Architecture"));
		assert.ok(o.commentBody?.includes("My approach"));
	});

	it("repairs unescaped double-quotes in string values", () => {
		// Agents commonly produce JSON with unescaped " inside commentBody
		// (e.g. referring to a file like "index.ts" in markdown)
		const input = `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\\nWe use the file "index.ts" directly","summary":"Done"}`;
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should repair unescaped quotes in string");
		const o = result as AgentOutput;
		assert.equal(o.agentName, "architect");
		assert.ok(o.commentBody?.includes("index.ts"));
		assert.equal(o.summary, "Done");
	});

	it("yields FailedParse for unescaped quotes \"key\", pattern (quote followed by comma)", () => {
		// When unescaped content quote is followed by comma inside string,
		// jsonrepair cannot disambiguate from a real structural close.
		// The old heuristic (isStructuralClose) rescued this case (#892),
		// but the heuristic was removed in favor of jsonrepair. The
		// targeted fix adds complexity that goes against the replacement
		// goal; if this pattern surfaces in production, either tighten
		// the agent prompt or add a pre-repair step for "X", patterns.
		const input = `{"action":"COMPLETE","agentName":"developer","commentBody":"value: "key", is important"}`;
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result), "should yield FailedParse — jsonrepair cannot disambiguate this case from a real close");
	});

	it("repairs code-fenced JSON with literal newlines in strings", () => {
		// Real-world pattern: agent emits JSON in code fence with actual
		// newlines inside string values. jsonrepair escapes them.
		const fullLog = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "developer",',
			'  "commentBody": "## Summary\nLine two"',
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "should repair code-fenced JSON with literal newline");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
		assert.ok(o.commentBody?.includes("Summary"));
		assert.ok(o.commentBody?.includes("Line two"));
	});

	it("irreparable input returns FailedParse", () => {
		const input = "{this is complete garbage}";
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result), "should return FailedParse for irreparable input");
		const f = result as FailedParse;
		assert.ok(f.error.includes("Failed to parse") || f.error.includes("repair"),
			`error should mention parsing or repair: ${f.error}`);
	});
});

// ─── Verification: dead code removal ───────────────────────────────

describe("dead code — isFailure removed from exports", () => {
	it("isFailure is no longer exported", async () => {
		const mod = await import("../agent/output.ts");
		assert.equal("isFailure" in mod, false);
	});

	it("isSuccess is still exported (counterpart preserved)", async () => {
		const mod = await import("../agent/output.ts");
		assert.notEqual(mod.isSuccess, undefined);
		assert.equal(typeof mod.isSuccess, "function");
	});
});
