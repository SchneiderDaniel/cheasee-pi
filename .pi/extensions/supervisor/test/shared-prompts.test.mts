// ─── Tests: shared-prompts.ts — Tool discipline prompts ────────────
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	TOOL_DISCIPLINE_SNIPPET,
	ERROR_HANDLING_PRINCIPLES,
	buildAgentSystemPrompt,
} from "../lib/shared-prompts.ts";

// ─── Tests: TOOL_DISCIPLINE_SNIPPET ───────────────────────────────

describe("TOOL_DISCIPLINE_SNIPPET", () => {
	it("contains the read discipline rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("read(path, offset?, limit?)"));
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("NOT `bash cat`"));
	});

	it("contains the search discipline rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("ripgrep_search"));
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("NOT `bash | grep`"));
	});

	it("contains the error rethink rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("Error means rethink"));
	});

	it("contains the batch same-tool rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("Batch same-tool calls"));
	});

	it("contains the read-once rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("Read once"));
	});

	it("contains the find symbols rule (now uses ripgrep_search or structural_search)", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("ripgrep_search"));
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("structural_search"));
	});

	it("contains the edit files rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("edit"));
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("bash sed"));
	});

	it("starts with a tool discipline header", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.startsWith("🛠 Tool Discipline"));
	});
});

// ─── Tests: ERROR_HANDLING_PRINCIPLES ────────────────────────────

describe("ERROR_HANDLING_PRINCIPLES", () => {
	it("is a non-empty string", () => {
		assert.ok(typeof ERROR_HANDLING_PRINCIPLES === "string");
		assert.ok(ERROR_HANDLING_PRINCIPLES.length > 0);
	});

	it("starts with the Error Handling Principles header", () => {
		assert.ok(
			ERROR_HANDLING_PRINCIPLES.startsWith(
				"## Error Handling Principles \u2014 Apply to ALL code you write",
			),
		);
	});

	it("contains all 6 principle numbers (1-6)", () => {
		for (let i = 1; i <= 6; i++) {
			assert.ok(ERROR_HANDLING_PRINCIPLES.includes(`${i}.`), `Missing principle number ${i}`);
		}
	});

	it("contains principle 1: Every error path user-visible", () => {
		assert.ok(ERROR_HANDLING_PRINCIPLES.includes("Every error path user-visible"));
	});

	it("contains principle 2: Never empty catch/except/recover", () => {
		assert.ok(ERROR_HANDLING_PRINCIPLES.includes("Never empty catch/except/recover"));
	});

	it("contains principle 3: Check every return code", () => {
		assert.ok(ERROR_HANDLING_PRINCIPLES.includes("Check every return code"));
	});

	it("contains principle 4: Clean up in finally/defer", () => {
		assert.ok(ERROR_HANDLING_PRINCIPLES.includes("Clean up in finally/defer"));
	});

	it("contains principle 5: Fail closed", () => {
		assert.ok(ERROR_HANDLING_PRINCIPLES.includes("Fail closed"));
	});

	it("contains principle 6: Never return partial success", () => {
		assert.ok(ERROR_HANDLING_PRINCIPLES.includes("Never return partial success"));
	});

	it("is under 500 bytes (token budget compliance)", () => {
		assert.ok(Buffer.byteLength(ERROR_HANDLING_PRINCIPLES, "utf8") < 500);
	});
});

// ─── Tests: buildAgentSystemPrompt ────────────────────────────────

describe("buildAgentSystemPrompt", () => {
	it("prepends tool discipline to existing system prompt", () => {
		const result = buildAgentSystemPrompt(
			"## Your Role\nYou are the Developer agent.",
			"developer",
		);
		assert.ok(result.startsWith("🛠 Tool Discipline"));
		assert.ok(result.includes("## Your Role\nYou are the Developer agent."));
	});

	it("includes error handling principles after tool discipline and before per-agent overrides", () => {
		const result = buildAgentSystemPrompt("Some prompt", "developer");
		const discIndex = result.indexOf("🛠 Tool Discipline");
		const principlesIndex = result.indexOf("## Error Handling Principles");
		const overridesIndex = result.indexOf("structural_search for code");
		const baseIndex = result.indexOf("Some prompt");
		assert.ok(discIndex >= 0, "Tool discipline section missing");
		assert.ok(principlesIndex >= 0, "Error handling principles section missing");
		assert.ok(overridesIndex >= 0, "Per-agent overrides section missing");
		assert.ok(
			discIndex < principlesIndex && principlesIndex < overridesIndex && overridesIndex < baseIndex,
			`Expected order: discipline (${discIndex}) < principles (${principlesIndex}) < overrides (${overridesIndex}) < base (${baseIndex})`,
		);
	});

	it("includes developer-specific overrides for developer agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "developer");
		assert.ok(result.includes("structural_search for code"));
	});

	it("includes error handling principles for developer agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "developer");
		assert.ok(result.includes("## Error Handling Principles"));
	});

	it("includes auditor-specific overrides for auditor agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "auditor");
		assert.ok(result.includes("git diff"));
	});

	it("includes error handling principles for auditor agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "auditor");
		assert.ok(result.includes("## Error Handling Principles"));
	});

	it("includes researcher-specific overrides for researcher agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "researcher");
		assert.ok(result.includes("web_crawl"));
	});

	it("includes error handling principles for researcher agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "researcher");
		assert.ok(result.includes("## Error Handling Principles"));
	});

	it("includes architect-specific overrides for architect agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "architect");
		assert.ok(result.includes("structural_search"));
	});

	it("includes error handling principles for architect agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "architect");
		assert.ok(result.includes("## Error Handling Principles"));
	});

	it("includes test-designer-specific overrides for test-designer agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "test-designer");
		assert.ok(result.includes("structural_search"));
	});

	it("includes error handling principles for test-designer agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "test-designer");
		assert.ok(result.includes("## Error Handling Principles"));
	});

	it("handles empty base prompt", () => {
		const result = buildAgentSystemPrompt("", "developer");
		assert.ok(result.startsWith("🛠 Tool Discipline"));
		assert.ok(result.includes("## Error Handling Principles"));
	});
});
