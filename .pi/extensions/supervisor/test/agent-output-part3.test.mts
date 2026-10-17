// ─── Tests: agent-output.ts — Phase 1: AgentOutput type + parseAgentOutput ──
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput } from "../agent/output.ts";
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
		// sanitizeJsonStrings later escapes them to \\n for valid JSON parsing.
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
// "💭 " prefix per line. extractLastJson strips these prefixes via
// THINKING_PREFIX_RE so parseAgentOutput can still extract valid JSON.

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
