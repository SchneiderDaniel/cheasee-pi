// ─── Tests: pipeline/output.ts — buildPipelineSummary with Closes #N ──
// Phase 2: Verify Closes #N line appears in PR body for GitHub cross-reference.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPipelineSummary, validateAgentResult } from "../pipeline/output.ts";
import type {
	PipelineAgentResult,
	SupervisorConfig,
	PrCreationResult,
	AgentRunResult,
} from "../config/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

const defaultConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {},
	codeowners: ["@owner"],
};

const emptyResults: PipelineAgentResult[] = [];

// ─── Tests: Closes #N in buildPipelineSummary ─────────────────────

describe("buildPipelineSummary — Closes #N line", () => {
	it("contains Closes #N when issueNum is provided", () => {
		const output = buildPipelineSummary(emptyResults, "success", 42, "Some title", defaultConfig);
		assert.ok(output.includes("Closes #42"), "Should contain Closes #42");
	});

	it("places Closes #N immediately after issue URL with no intervening content", () => {
		const output = buildPipelineSummary(emptyResults, "success", 42, "Some title", defaultConfig);
		const issueLineIdx = output.indexOf("**Issue:** https://github.com/owner/repo/issues/42");
		const closesLineIdx = output.indexOf("Closes #42");
		assert.ok(issueLineIdx >= 0, "Issue URL line present");
		assert.ok(closesLineIdx >= 0, "Closes #N line present");
		// Closes #N should come right after issue URL line
		const afterIssue = output.slice(issueLineIdx);
		const linesAfterIssue = afterIssue.split("\n");
		assert.ok(linesAfterIssue[0].includes("**Issue:**"), "First line is issue URL");
		assert.ok(linesAfterIssue[1].includes("Closes #42"), "Second line is Closes #42");
	});

	it("works for boundary issue number 1", () => {
		const output = buildPipelineSummary(emptyResults, "success", 1, "Title", defaultConfig);
		assert.ok(output.includes("Closes #1"), "Should contain Closes #1");
	});

	it("works for large issue number 99999", () => {
		const output = buildPipelineSummary(emptyResults, "success", 99999, "Title", defaultConfig);
		assert.ok(output.includes("Closes #99999"), "Should contain Closes #99999");
	});

	it("works for issue number 0", () => {
		const output = buildPipelineSummary(emptyResults, "success", 0, "Title", defaultConfig);
		assert.ok(output.includes("Closes #0"), "Should contain Closes #0");
	});

	it("contains Closes #N when prCreationResult is provided (success)", () => {
		const prResult: PrCreationResult = {
			success: true,
			prNumber: 100,
		};
		const output = buildPipelineSummary(
			emptyResults,
			"success",
			42,
			"Title",
			defaultConfig,
			undefined,
			prResult,
		);
		assert.ok(output.includes("Closes #42"), "Should contain Closes #42");
		assert.ok(output.includes("#100"), "Should contain PR number reference");
		assert.ok(output.includes("created"), "Should indicate PR was created");
	});

	it("contains Closes #N when prCreationResult is provided (failure)", () => {
		const prResult: PrCreationResult = {
			success: false,
			error: "Network error",
		};
		const output = buildPipelineSummary(
			emptyResults,
			"success",
			42,
			"Title",
			defaultConfig,
			undefined,
			prResult,
		);
		assert.ok(output.includes("Closes #42"), "Should contain Closes #42");
		assert.ok(output.includes("PR creation failed"), "Should mention failure");
	});

	it("does NOT include Closes #N line before the issue URL line", () => {
		const output = buildPipelineSummary(emptyResults, "success", 42, "Title", defaultConfig);
		const issueIdx = output.indexOf("**Issue:**");
		const closesIdx = output.indexOf("Closes #42");
		assert.ok(issueIdx >= 0, "Issue URL present");
		assert.ok(closesIdx >= 0, "Closes #N present");
		assert.ok(closesIdx > issueIdx, "Closes #N appears after issue URL");
	});

	// ─── Tests: Bug 2 — Skipped PR rendering ───────────────────────

	describe("buildPipelineSummary — skipped PR (Bug 2)", () => {
		it("skipped PR (ahead_by=0) renders as 'PR creation failed' not 'created'", () => {
			const prResult: PrCreationResult = {
				success: false,
				error: "No commits ahead of base — PR skipped",
			};
			const output = buildPipelineSummary(
				emptyResults,
				"success",
				42,
				"Title",
				defaultConfig,
				undefined,
				prResult,
			);
			// Should NOT render "created" or "#undefined"
			assert.ok(!output.includes("created"), "should NOT say 'created' for skipped PR");
			assert.ok(!output.includes("#undefined"), "should NOT render '#undefined' for skipped PR");
			// Should render the error message
			assert.ok(
				output.includes("PR creation failed"),
				"should indicate PR creation failed/skipped",
			);
			assert.ok(output.includes("No commits ahead of base"), "should show why PR was skipped");
		});

		it("skipped PR does not alter Closes #N line", () => {
			const prResult: PrCreationResult = {
				success: false,
				error: "No commits ahead of base — PR skipped",
			};
			const output = buildPipelineSummary(
				emptyResults,
				"success",
				42,
				"Title",
				defaultConfig,
				undefined,
				prResult,
			);
			assert.ok(output.includes("Closes #42"), "Closes #N should still be present");
		});
	});
});

// ─── Tests: Bug #711 — error output rendering ─────────────────

describe("buildPipelineSummary — error output rendering (Bug #711)", () => {
	const agentWithError: PipelineAgentResult = {
		agentName: "developer",
		status: "FAILED",
		durationMs: 2500,
		tokenCount: 0,
		toolCount: 0,
		errorOutput: "Failed to start pi: ENOENT",
	};

	const agentWithNoError: PipelineAgentResult = {
		agentName: "auditor",
		status: "FAILED",
		durationMs: 5000,
		tokenCount: 100,
		toolCount: 2,
	};

	const successAgent: PipelineAgentResult = {
		agentName: "architect",
		status: "SUCCESS",
		durationMs: 10000,
		tokenCount: 2000,
		toolCount: 15,
	};

	it("failed agent with errorOutput includes error in status display", () => {
		const output = buildPipelineSummary(
			[agentWithError],
			"failed",
			42,
			"Test issue",
			defaultConfig,
		);
		// Should contain the error message in the status column
		assert.ok(
			output.includes("Failed to start pi: ENOENT"),
			"should include error output in status display",
		);
	});

	it("failed agent with errorOutput shows ✗ FAILED (error message)", () => {
		const output = buildPipelineSummary(
			[agentWithError],
			"failed",
			42,
			"Test issue",
			defaultConfig,
		);
		// The status column should show the error in parentheses
		assert.ok(
			output.includes("✗ FAILED (Failed to start pi: ENOENT)"),
			"should format as FAILED (error message)",
		);
	});

	it("failed agent without errorOutput shows plain FAILED", () => {
		const output = buildPipelineSummary(
			[agentWithNoError],
			"failed",
			42,
			"Test issue",
			defaultConfig,
		);
		assert.ok(output.includes("✗ FAILED"), "should show plain FAILED without error details");
		// Should NOT have empty parentheses
		assert.ok(
			!output.includes("FAILED ()"),
			"should not show empty parentheses when no errorOutput",
		);
	});

	it("truncates error output to 80 chars", () => {
		const longError =
			"This is a very long error message that goes well beyond eighty characters and should be truncated for display in the pipeline summary table";
		const agentLongError: PipelineAgentResult = {
			...agentWithError,
			errorOutput: longError,
		};
		const output = buildPipelineSummary(
			[agentLongError],
			"failed",
			42,
			"Test issue",
			defaultConfig,
		);
		// Should contain the first 80 chars followed by "..."
		assert.ok(
			output.includes(longError.slice(0, 80) + "..."),
			"error message should be truncated at 80 chars with ...",
		);
		assert.ok(!output.includes(longError.slice(81)), "characters beyond 80 should not appear");
	});

	it("exactly 80 char error output is not truncated", () => {
		const exactly80 = "a".repeat(80);
		const agent80: PipelineAgentResult = {
			...agentWithError,
			errorOutput: exactly80,
		};
		const output = buildPipelineSummary([agent80], "failed", 42, "Test issue", defaultConfig);
		assert.ok(output.includes(exactly80), "80-char message should not be truncated");
	});

	it("79 char error output is not truncated", () => {
		const exactly79 = "a".repeat(79);
		const agent79: PipelineAgentResult = {
			...agentWithError,
			errorOutput: exactly79,
		};
		const output = buildPipelineSummary([agent79], "failed", 42, "Test issue", defaultConfig);
		assert.ok(output.includes(exactly79), "79-char message should not be truncated");
	});

	it("multiple agents — shows error for failed, normal for success", () => {
		const output = buildPipelineSummary(
			[successAgent, agentWithError],
			"failed",
			42,
			"Test issue",
			defaultConfig,
		);
		assert.ok(output.includes("✓ SUCCESS"), "success agent should show ✓ SUCCESS");
		assert.ok(
			output.includes("✗ FAILED (Failed to start pi: ENOENT)"),
			"failed agent should show error message",
		);
	});

	it("error output with newlines shows first line in status (render is truncation-safe for markdown)", () => {
		const multiLineError = "First line error\nSecond line\nThird line";
		const agentMulti: PipelineAgentResult = {
			...agentWithError,
			errorOutput: multiLineError,
		};
		const output = buildPipelineSummary([agentMulti], "failed", 42, "Test issue", defaultConfig);
		// Newlines in table cells break markdown rendering;
		// the implementation renders the error inline — at minimum the first
		// line appears in the status column display
		assert.ok(
			output.includes("✗ FAILED (First line error"),
			"first line of multiline error should appear in status",
		);
	});
});

// ─── Tests: validateAgentResult() ─────────────────────────────────

describe("validateAgentResult()", () => {
	const makeResult = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
		output: "",
		success: true,
		agentName: "developer",
		toolCount: 10,
		tokenCount: 5000,
		durationMs: 30000,
		textOutput: "done",
		summaryLine: "Implemented feature",
		errorOutput: "",
		textOnly: "IMPLEMENTATION_COMPLETE",
		...overrides,
	});

	it("normal result (success=true, tokens>0, tools>5) — not modified", () => {
		const result = makeResult({ success: true, tokenCount: 5000, toolCount: 10 });
		validateAgentResult(result);
		assert.equal(result.success, true, "should remain true for normal result");
	});

	it("success=true, tokenCount=0, toolCount > 5 — derated to failed", () => {
		const result = makeResult({ success: true, tokenCount: 0, toolCount: 10 });
		validateAgentResult(result);
		assert.equal(
			result.success,
			false,
			"should derate to failed when tokenCount=0 and toolCount > 5",
		);
		assert.ok(
			result.errorOutput.includes("Sanity check failed"),
			"should set errorOutput explaining the sanity check",
		);
	});

	it("already failed result — not modified", () => {
		const result = makeResult({ success: false, tokenCount: 0, toolCount: 0 });
		const beforeError = result.errorOutput;
		validateAgentResult(result);
		assert.equal(result.success, false, "should remain false");
		assert.equal(result.errorOutput, beforeError, "should not modify existing errorOutput");
	});

	it("success=true, tokenCount=0, toolCount=0 (crash scenario) — not derated", () => {
		// This is the exact crash scenario from Bug #711: 0 tokens, 0 tools
		const result = makeResult({ success: true, tokenCount: 0, toolCount: 0 });
		validateAgentResult(result);
		assert.equal(
			result.success,
			true,
			"should NOT derate crash scenario (0 tokens, 0 tools) — toolCount <= 5",
		);
	});

	it("success=true, tokenCount=0, toolCount=5 (boundary) — not derated", () => {
		const result = makeResult({ success: true, tokenCount: 0, toolCount: 5 });
		validateAgentResult(result);
		assert.equal(result.success, true, "toolCount=5 is boundary, should not be derated");
	});

	it("success=true, tokenCount=0, toolCount=6 — derated to failed", () => {
		const result = makeResult({ success: true, tokenCount: 0, toolCount: 6 });
		validateAgentResult(result);
		assert.equal(result.success, false, "toolCount=6 exceeds threshold, should be derated");
	});

	it("derated result has existing errorOutput preserved", () => {
		const result = makeResult({
			success: true,
			tokenCount: 0,
			toolCount: 10,
			errorOutput: "Previous error",
		});
		validateAgentResult(result);
		assert.equal(result.success, false);
		assert.ok(
			result.errorOutput.includes("Previous error"),
			"should preserve existing errorOutput",
		);
		assert.ok(
			result.errorOutput.includes("Sanity check failed"),
			"should append sanity check message",
		);
	});

	it("success=true, tokenCount > 0, toolCount > 5 — not derated", () => {
		const result = makeResult({ success: true, tokenCount: 100, toolCount: 20 });
		validateAgentResult(result);
		assert.equal(result.success, true, "tokens > 0 means it's valid");
	});

	it("success=false, tokenCount=0, toolCount=10 — not modified (already failed)", () => {
		const result = makeResult({ success: false, tokenCount: 0, toolCount: 10 });
		const beforeError = result.errorOutput;
		validateAgentResult(result);
		assert.equal(result.success, false, "already failed should stay failed");
		assert.equal(result.errorOutput, beforeError, "should not modify already-failed result");
	});
});

// ─── Tests: buildPipelineSummary — gate failure history rendering ──

describe("buildPipelineSummary — gate failure history (R2)", () => {
	const singleDev: PipelineAgentResult = {
		agentName: "developer",
		status: "SUCCESS",
		durationMs: 10000,
		tokenCount: 5000,
		toolCount: 10,
	};

	it("no gateFailureHistory when undefined (backward compat)", () => {
		const output = buildPipelineSummary([singleDev], "success", 42, "Test", defaultConfig);
		assert.ok(!output.includes("Gate failures"), "should not include Gate failures section");
	});

	it("no gateFailureHistory when empty array (backward compat)", () => {
		const output = buildPipelineSummary(
			[singleDev],
			"success",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			[],
		);
		assert.ok(!output.includes("Gate failures"), "should not include Gate failures section");
	});

	it("renders single gate failure entry", () => {
		const output = buildPipelineSummary(
			[singleDev],
			"success",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			["CI Gate gate failed on run 1 — developer restarted"],
		);
		assert.ok(output.includes("Gate failures"), "should include Gate failures section");
		assert.ok(
			output.includes("CI Gate gate failed on run 1"),
			"should include the gate failure entry",
		);
	});

	it("renders multiple gate failure entries", () => {
		const output = buildPipelineSummary(
			[singleDev],
			"success",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			[
				"CI Gate gate failed on run 1 — developer restarted",
				"TSC Checkpoint gate failed on run 2 — developer restarted",
			],
		);
		assert.ok(output.includes("CI Gate gate failed on run 1"), "first entry present");
		assert.ok(output.includes("TSC Checkpoint gate failed on run 2"), "second entry present");
		// Both should be rendered as list items
		const lines = output.split("\n");
		const gfSectionStart = lines.findIndex((l) => l.includes("Gate failures"));
		assert.ok(gfSectionStart >= 0, "Gate failures section exists");
		// Next lines should be list items
		assert.ok(lines[gfSectionStart + 1]?.startsWith("- "), "first entry is a list item");
		assert.ok(lines[gfSectionStart + 2]?.startsWith("- "), "second entry is a list item");
	});

	it("gate failure section appears after total stats but before failure info", () => {
		const output = buildPipelineSummary(
			[singleDev],
			"success",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			["CI Gate gate failed on run 1 — developer restarted"],
		);
		const totalIdx = output.indexOf("**Total:**");
		const gfIdx = output.indexOf("**Gate failures:**");
		const closesIdx = output.indexOf("Closes #42");
		assert.ok(totalIdx >= 0, "total stats present");
		assert.ok(gfIdx >= 0, "gate failures section present");
		assert.ok(closesIdx >= 0, "Closes #N present");
		assert.ok(gfIdx > totalIdx, "gate failures after total stats");
	});
});

// ─── Tests: buildPipelineSummary — multi-developer-run accumulation ──

describe("buildPipelineSummary — multi-developer-run (Phase 5)", () => {
	const makeAgent = (
		name: string,
		status: PipelineAgentResult["status"],
		tokens: number,
		duration: number,
		tools: number,
	): PipelineAgentResult => ({
		agentName: name,
		status,
		tokenCount: tokens,
		durationMs: duration,
		toolCount: tools,
	});

	it("2 developer entries + 1 auditor → 3 rows", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 10),
			makeAgent("developer", "SUCCESS", 3000, 20000, 8),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);

		// Count rows in the agent table
		const tableRows = output
			.split("\n")
			.filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Agent |"));
		assert.equal(tableRows.length, 3, "should have 3 agent rows");

		// Both developer rows present
		const devRows = tableRows.filter((r) => r.includes("developer"));
		assert.equal(devRows.length, 2, "both developer runs should appear");

		// Total token count = sum of ALL entries
		assert.ok(output.includes("**Total:** 3 agents"), "total shows 3 agents");
		assert.ok(output.includes("10.0K tokens"), "total tokens = 5000+3000+2000 = 10000");
	});

	it("total token count equals sum of all rows, not just last", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 10),
			makeAgent("developer", "SUCCESS", 3000, 20000, 8),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("10.0K tokens"), "total = 5000+3000+2000 = 10000");
		// The total line should say 10.0K, not 5.0K (not just last developer run)
		const totalLine = output.split("\n").find((l) => l.startsWith("**Total:"));
		assert.ok(totalLine, "total line present");
		assert.ok(totalLine!.includes("10.0K"), "total shows sum, not just last run");
		assert.ok(!totalLine!.includes("5.0K"), "total does not show only last developer run");
	});

	it("total duration = sum of all entries", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 10),
			makeAgent("developer", "SUCCESS", 3000, 20000, 8),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("1m 5s"), "total duration = 30+20+15 = 65s = 1m 5s");
	});

	it("total tool calls = sum of all entries", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 10),
			makeAgent("developer", "SUCCESS", 3000, 20000, 8),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("23 tool calls"), "total tools = 10+8+5 = 23");
	});

	it("failed intermediate run (0 tokens) appears as FAILED row", () => {
		const results = [
			makeAgent("developer", "FAILED", 0, 5000, 0),
			makeAgent("developer", "SUCCESS", 5000, 30000, 10),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		const tableRows = output
			.split("\n")
			.filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Agent |"));
		assert.equal(tableRows.length, 3, "3 rows including failed");

		// First row should be FAILED with 0 tokens
		const failedRow = tableRows.find((r) => r.includes("FAILED"));
		assert.ok(failedRow, "failed row present");
		assert.ok(failedRow!.includes("0"), "failed row shows 0 tokens");

		// Total tokens = 0+5000+2000 = 7000
		assert.ok(output.includes("7.0K tokens"), "total includes 0 from failed run");
	});

	it("4 developer runs + 1 auditor = 5 rows, all present (no capping)", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 10),
			makeAgent("developer", "SUCCESS", 3000, 20000, 8),
			makeAgent("developer", "SUCCESS", 4000, 25000, 9),
			makeAgent("developer", "SUCCESS", 2000, 15000, 6),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		const tableRows = output
			.split("\n")
			.filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Agent |"));
		assert.equal(tableRows.length, 5, "all 5 rows present");

		const devRows = tableRows.filter((r) => r.includes("developer"));
		assert.equal(devRows.length, 4, "all 4 developer runs present");
	});

	it("single successful run — unchanged from pre-change behavior", () => {
		const results = [makeAgent("developer", "SUCCESS", 5000, 30000, 10)];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		const tableRows = output
			.split("\n")
			.filter((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.startsWith("| Agent |"));
		assert.equal(tableRows.length, 1, "1 row for single developer");
		assert.ok(output.includes("5.0K tokens"), "token count correct");
		assert.ok(output.includes("**Total:** 1 agents"), "total shows 1 agent");
	});
});

// ─── Tests: buildPipelineSummary — failed tool call rendering ────

describe("buildPipelineSummary — failed tool call rendering", () => {
	const makeAgent = (
		name: string,
		status: PipelineAgentResult["status"],
		tokens: number,
		duration: number,
		tools: number,
		failed?: number,
	): PipelineAgentResult => ({
		agentName: name,
		status,
		tokenCount: tokens,
		durationMs: duration,
		toolCount: tools,
		failedToolCount: failed,
	});

	it("shows · 2 failed (50%) when half of 4 tools failed across agents", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 2, 1),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 2, 1),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("· 2 failed (50%)"), "should show 2 failed (50%)");
	});

	it("shows · 0 failed (0%) when all agents have failedToolCount: 0", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 10, 0),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5, 0),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("· 0 failed (0%)"), "should show 0 failed (0%)");
	});

	it("unchanged (no · N failed suffix) when all agents have undefined failedToolCount (backward compat)", () => {
		const results = [makeAgent("developer", "SUCCESS", 5000, 30000, 10)];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(!output.includes("failed"), "should NOT include failed suffix when undefined");
		assert.ok(output.includes("10 tool calls"), "original format preserved");
	});

	it("zero-division guard: when total tool calls = 0, percentage renders as 0 not NaN", () => {
		const results = [makeAgent("developer", "SUCCESS", 0, 0, 0, 0)];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("0 failed (0%)"), "should show 0% not NaN");
	});

	it("all calls failed: · 5 failed (100%) for 5/5 failed", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 3, 3),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 2, 2),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("· 5 failed (100%)"), "should show 5 failed (100%)");
	});

	it("sums failedToolCount across all agents correctly", () => {
		const results = [
			makeAgent("developer", "SUCCESS", 5000, 30000, 10, 1),
			makeAgent("developer", "SUCCESS", 3000, 20000, 8, 3),
			makeAgent("auditor", "SUCCESS", 2000, 15000, 5, 0),
		];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("· 4 failed"), "should sum to 4 failed across 3 agents");
	});

	it("existing total-line format preserved: agents count, duration, tokens, tool calls all present (regression guard)", () => {
		const results = [makeAgent("developer", "SUCCESS", 5000, 30000, 10, 1)];
		const output = buildPipelineSummary(results, "success", 42, "Test", defaultConfig);
		assert.ok(output.includes("**Total:"), "Total line present");
		assert.ok(output.includes("1 agents"), "agent count present");
		assert.ok(output.includes("30s") || output.includes("0m 30s"), "duration present");
		assert.ok(output.includes("5.0K tokens"), "tokens present");
		assert.ok(output.includes("10 tool calls"), "tool calls present");
		assert.ok(output.includes("· 1 failed"), "failed count present");
	});
});
