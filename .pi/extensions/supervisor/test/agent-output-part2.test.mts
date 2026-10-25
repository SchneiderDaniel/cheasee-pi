// ─── Tests: agent-output.ts — Phase 1: AgentOutput type + parseAgentOutput ──
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseAgentOutput,
	isRefused,
	isSuccess,
	getRefusalInfo,
	extractAgentCommentBody,
} from "../agent/output.ts";
import type { AgentOutput, FailedParse, ParseResult } from "../config/types.ts";

// ─── Helper ────────────────────────────────────────────────────────

function isFailedParse(r: ParseResult): r is FailedParse {
	return "error" in r && "rawOutput" in r;
}

function isAgentOutput(r: ParseResult): r is AgentOutput {
	return "action" in r && "agentName" in r;
}

// ─── Tests: stripAnsi ─────────────────────────────────────────────

// Split from agent-output.test.mts (issue #2035 Long File refactor).
describe("parseAgentOutput — refusal handling", () => {
	it("template-shaped success output parses as AgentOutput, not refusal (regression)", () => {
		// Regression (audit): the success example in agent/task.ts
		// JSON_OUTPUT_INSTRUCTION once carried a `refusal` placeholder. An agent
		// copying the example literally — or emitting `refusal: ""` alongside a
		// successful action — was classified as RefusedOutput and stopped the
		// pipeline. The example now omits `refusal`; this pins the parser
		// behavior for the documented success shape.
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			summary: "Implemented the feature",
			commentBody: "## Implementation\n\n[optional implementation notes]",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "template-shaped success output must be AgentOutput");
		assert.equal(isRefused(result), false);
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
		assert.equal(o.summary, "Implemented the feature");
		assert.equal(o.commentBody, "## Implementation\n\n[optional implementation notes]");
	});

	it("returns RefusedOutput (not FailedParse) when refusal field is present", () => {
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			summary: "tried",
			refusal: "I cannot complete this task due to safety concerns",
		});
		const result = parseAgentOutput(input);
		assert.ok(isRefused(result), "refusal must not be a FailedParse");
		assert.equal(result.refused, true);
		assert.equal(result.agentName, "developer");
		assert.equal(result.summary, "tried");
		assert.equal(result.refusal, "I cannot complete this task due to safety concerns");
	});

	it("treats an empty-string refusal as a refusal (presence-based detection)", () => {
		const input = JSON.stringify({ action: "COMPLETE", agentName: "developer", refusal: "" });
		const result = parseAgentOutput(input);
		assert.ok(isRefused(result));
		assert.equal(result.refusal, "");
	});

	it("coerces a non-string refusal via String()", () => {
		const input = JSON.stringify({ action: "COMPLETE", agentName: "developer", refusal: 42 });
		const result = parseAgentOutput(input);
		assert.ok(isRefused(result));
		assert.equal(result.refusal, "42");
	});

	it("accepts a refusal with minimal fields (no action/agentName)", () => {
		const input = JSON.stringify({ refusal: "out of scope" });
		const result = parseAgentOutput(input);
		assert.ok(isRefused(result));
		assert.equal(result.refusal, "out of scope");
		assert.equal(result.agentName, undefined);
	});

	it("preserves commentBody on a refusal", () => {
		const input = JSON.stringify({ refusal: "nope", commentBody: "## Why\n\nOut of scope." });
		const result = parseAgentOutput(input);
		assert.ok(isRefused(result));
		assert.equal(result.commentBody, "## Why\n\nOut of scope.");
	});

	it("refusal beats schema validation — invalid action + refusal → RefusedOutput", () => {
		// Refusal is evaluated BEFORE field validation (OpenAI structured-outputs
		// precedent): refusal prose must not be schema-validated, so an invalid
		// action alongside a refusal is still a refusal, never a schema FailedParse.
		const input = JSON.stringify({ action: "BOGUS", refusal: "x" });
		const result = parseAgentOutput(input);
		assert.ok(isRefused(result), "invalid action + refusal must be RefusedOutput, not FailedParse");
		assert.equal(result.refusal, "x");
	});

	it("normalizeEscapes applied to refusal and commentBody", () => {
		const input = JSON.stringify({
			refusal: "cannot complete\\nfor safety",
			commentBody: "## Why\\n\\nOut of scope.",
		});
		const result = parseAgentOutput(input);
		assert.ok(isRefused(result));
		assert.equal(result.refusal, "cannot complete\nfor safety");
		assert.equal(result.commentBody, "## Why\n\nOut of scope.");
	});

	it("isSuccess excludes RefusedOutput; isRefused(FailedParse) === false", () => {
		const refused = parseAgentOutput(JSON.stringify({ refusal: "no" }));
		assert.ok(isRefused(refused));
		assert.equal(isSuccess(refused), false, "RefusedOutput lacks `action` → not a success");

		const failed = parseAgentOutput("not json at all");
		assert.ok(isFailedParse(failed));
		assert.equal(isRefused(failed), false, "FailedParse must not classify as refused");
		assert.equal(isSuccess(failed), false, "FailedParse must not classify as success");
	});

	it("getRefusalInfo returns RefusedOutput for refusal output, null otherwise", () => {
		const refused = getRefusalInfo(JSON.stringify({ refusal: "cannot", agentName: "dev" }));
		assert.ok(refused !== null, "refusal output → RefusedOutput, not null");
		assert.equal(refused.refused, true);
		assert.equal(refused.refusal, "cannot");
		assert.equal(refused.agentName, "dev");

		const success = getRefusalInfo(JSON.stringify({ action: "COMPLETE", agentName: "dev" }));
		assert.equal(success, null, "success-shaped output → null");

		const failed = getRefusalInfo("not json at all");
		assert.equal(failed, null, "unparseable output → null (degrades to FailedParse inside)");
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

	it("returns the refusal commentBody for RefusedOutput", () => {
		const output = JSON.stringify({
			refusal: "out of scope",
			commentBody: "## Why\n\nOut of scope for this issue.",
		});
		assert.equal(extractAgentCommentBody(output), "## Why\n\nOut of scope for this issue.");
	});

	it("returns non-blank refusal commentBody verbatim (surrounding whitespace preserved)", () => {
		// Regression (audit fix): trim must be for blank detection only — the
		// agent's markdown (leading/trailing whitespace, indentation) survives.
		const body = "  ## Why\n\nDetails  ";
		const output = JSON.stringify({ refusal: "out of scope", commentBody: body });
		assert.equal(extractAgentCommentBody(output), body);
	});

	it("returns null for a refusal with a blank commentBody", () => {
		const output = JSON.stringify({ refusal: "out of scope", commentBody: "   " });
		assert.equal(extractAgentCommentBody(output), null);
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
