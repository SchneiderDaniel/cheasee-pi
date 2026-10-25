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
		// Pass toolNames including web_search so isToolLine can filter it
		const result = parseAgentOutput(
			fullLog,
			new Set(["web_search", "read", "bash", "edit", "write", "grep", "find", "ls", "rg"]),
		);
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

// ─── Tests: isStructuralClose false-positive fix ─────────────────
// Regression tests for the bug where isStructuralQuote false-positives
// on unescaped double-quotes inside JSON string values that happen to
// be followed by `,`, `}`, `]`, or `:`. The fix replaces the unidirectional
// lookahead with a bidirectional check (isStructuralClose) and adds a
// conservative fallback pass for content quotes followed by `,` or `:`.

describe("parseAgentOutput — false-positive unescaped quotes (isStructuralClose fix)", () => {
	it('handles content quote followed by comma ("key", pattern)', () => {
		// Input: unescaped " after `key` is followed by `,`
		// Before fix: isStructuralQuote returned TRUE → string truncated → invalid JSON
		const input = `{"action":"COMPLETE","agentName":"developer","commentBody":"value: \"key\", is important"}`;
		const inputEscaped = `{"action":"COMPLETE","agentName":"developer","commentBody":"value: "key", is important"}`;
		const result = parseAgentOutput(inputEscaped);
		assert.ok(isAgentOutput(result), "should parse JSON with content quote followed by comma");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
		assert.equal(o.commentBody, 'value: "key", is important');
	});

	it('handles content quote followed by colon ("value": pattern)', () => {
		// Input: unescaped " after `value` is followed by `:`
		const input = `{"action":"COMPLETE","agentName":"architect","commentBody":"check: \"value\": more"}`;
		const inputEscaped = `{"action":"COMPLETE","agentName":"architect","commentBody":"check: "value": more"}`;
		const result = parseAgentOutput(inputEscaped);
		assert.ok(isAgentOutput(result), "should parse JSON with content quote followed by colon");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "architect");
		assert.equal(o.commentBody, 'check: "value": more');
	});

	it('handles content quote followed by closing brace ("value"} pattern)', () => {
		// Input: unescaped " after `value` is followed by `}`
		// This case uses auto-recovery (trailing content truncation) as fallback.
		const inputEscaped = `{"action":"COMPLETE","agentName":"developer","commentBody":"check: "value"} more"}`;
		const result = parseAgentOutput(inputEscaped);
		assert.ok(isAgentOutput(result), "should parse JSON with content quote followed by brace");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
	});

	it("preserves existing unescaped-quotes behavior (regression)", () => {
		// Existing test from the suite — must still pass
		const input = `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\\nWe use the file \"index.ts\" directly","summary":"Done"}`;
		// unescaped " inside string value (followed by letter, not delimiter)
		const unescapedInput = `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\\nWe use the file "index.ts" directly","summary":"Done"}`;
		const result = parseAgentOutput(unescapedInput);
		assert.ok(isAgentOutput(result), "should parse JSON with unescaped quotes (letter after)");
		const o = result as AgentOutput;
		assert.equal(o.agentName, "architect");
		assert.ok(o.commentBody?.includes("index.ts"));
		assert.equal(o.summary, "Done");
	});

	it("handles content quote inside code fence with false-positive pattern", () => {
		// Dual code path: fence scanner must correctly track string boundaries
		// when content quote is followed by `,` or `:`
		const fullLog = [
			"Here is the output:",
			"",
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "developer",',
			'  "commentBody": "value: \"key\", is important"',
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "should parse code-fenced JSON with false-positive pattern");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
		assert.equal(o.commentBody, 'value: "key", is important');
	});

	it("fast path: normal JSON parses on first pass without retry", () => {
		// When there's no false-positive, the standard sanitization should
		// succeed directly (conservative retry is not triggered).
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			commentBody: "Normal text without unescaped quotes",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "normal JSON should parse on first pass");
		assert.equal((result as AgentOutput).commentBody, "Normal text without unescaped quotes");
	});

	it("both passes fail: returns FailedParse with original error", () => {
		// Input that is truly malformed and neither pass can fix should
		// return a FailedParse (not silently swallowed).
		const input = "{this is complete garbage}";
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result), "should return FailedParse when both passes fail");
		const f = result as FailedParse;
		assert.ok(f.error.includes("Failed to parse"), `error should mention parsing: ${f.error}`);
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
