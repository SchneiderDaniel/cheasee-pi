// ─── Tests: pipeline/output.ts — buildPipelineSummary with Closes #N ──
// Phase 2: Verify Closes #N line appears in PR body for GitHub cross-reference.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPipelineSummary } from "../pipeline/output.ts";
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
	statusMapping: { todo: "developer" },
	codeowners: ["@owner"],
	maxRejections: 3,
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 300,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
	agentTimeoutsMin: {},
};

const emptyResults: PipelineAgentResult[] = [];

// ─── Tests: Closes #N in buildPipelineSummary ─────────────────────

// Split from output.test.mts (issue #2035 Long File refactor).
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
		assert.ok(output.includes("**Total:** 3 runs"), "total shows 3 runs");
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
		assert.ok(output.includes("**Total:** 1 run"), "total shows 1 run");
	});
});

// ─── Tests: buildPipelineSummary — retry rows (issue #1495) ──────
// Retry path pushes one row per dispatch: FAILED (failed run stats) +
// SUCCESS (after retry) (retry run stats). Totals reduce over all runs.

describe("buildPipelineSummary — retry rows (issue #1495)", () => {
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

	it("FAILED + SUCCESS (after retry) developer pair renders two rows, each with its own stats", () => {
		// Issue #1494 exact durations: failed run 30m 0s, retry 17m 49s.
		const results = [
			makeAgent("developer", "FAILED", 80_000, 1_800_025, 100),
			makeAgent("developer", "SUCCESS (after retry)", 60_000, 1_068_861, 80),
		];
		const output = buildPipelineSummary(results, "success", 1494, "Test", defaultConfig);
		const devRows = output.split("\n").filter((l) => l.startsWith("| developer |"));
		assert.equal(devRows.length, 2, "both runs appear as rows");
		assert.ok(
			devRows[0].includes("✗ FAILED | 30m 0s | 80.0K | 100 |"),
			`failed row carries failed run's stats, got: ${devRows[0]}`,
		);
		assert.ok(
			devRows[1].includes("✓ SUCCESS (after retry) | 17m 49s | 60.0K | 80 |"),
			`retry row carries retry run's stats, got: ${devRows[1]}`,
		);
	});

	it("totals sum all runs incl. the failed attempt (6 runs · exact total line)", () => {
		const results = [
			makeAgent("researcher", "SUCCESS", 100_000, 5_000_000, 50),
			makeAgent("architect", "SUCCESS", 80_000, 4_000_000, 40),
			makeAgent("test-designer", "SUCCESS", 60_000, 3_000_000, 30),
			makeAgent("developer", "FAILED", 80_000, 1_800_025, 100),
			makeAgent("developer", "SUCCESS (after retry)", 60_000, 1_068_861, 80),
			makeAgent("auditor", "SUCCESS", 20_000, 500_000, 15),
		];
		const output = buildPipelineSummary(results, "success", 1494, "Test", defaultConfig);
		// 15_368_886 ms = 256m 9s; 400.0K tokens; 315 tool calls.
		assert.ok(
			output.includes("**Total:** 6 runs · 256m 9s · 400.0K tokens · 315 tool calls"),
			"totals reflect all 6 dispatches incl. the failed attempt",
		);
		assert.ok(
			output.includes("**Total:** 6 runs"),
			"count labeled runs (entries), not distinct agents",
		);
	});

	it("retry-also-fails: two FAILED rows, both counted; Stopped at resolves to the LAST FAILED entry", () => {
		const results = [
			makeAgent("architect", "FAILED", 0, 100_000, 0),
			makeAgent("developer", "FAILED", 10_000, 500_000, 20),
			makeAgent("developer", "FAILED", 8_000, 300_000, 15),
		];
		const output = buildPipelineSummary(results, "failed", 1494, "Test", defaultConfig);
		const devRows = output.split("\n").filter((l) => l.startsWith("| developer |"));
		assert.equal(devRows.length, 2, "both failed developer runs documented");
		assert.ok(
			output.includes("**Stopped at:** developer"),
			"Stopped at picks the last FAILED entry (developer), not the architect row",
		);
		assert.ok(
			output.includes("**Total:** 3 runs · 15m 0s · 18.0K tokens · 35 tool calls"),
			"totals count every failed run",
		);
	});

	it("FAILED retry row renders errorOutput truncated at 80 chars (Bug #711 path)", () => {
		const longError =
			"This is a very long crash diagnostic from the failed first run that exceeds eighty characters and must be truncated in the status column";
		const results = [
			{ ...makeAgent("developer", "FAILED", 0, 1_800_025, 0), errorOutput: longError },
			makeAgent("developer", "SUCCESS (after retry)", 60_000, 1_068_861, 80),
		];
		const output = buildPipelineSummary(results, "success", 1494, "Test", defaultConfig);
		assert.ok(
			output.includes(longError.slice(0, 80) + "..."),
			"failed run's error output truncated with ...",
		);
		assert.ok(!output.includes(longError.slice(81)), "chars beyond 80 not rendered");
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
		assert.ok(output.includes("1 run"), "run count present");
		assert.ok(output.includes("30s") || output.includes("0m 30s"), "duration present");
		assert.ok(output.includes("5.0K tokens"), "tokens present");
		assert.ok(output.includes("10 tool calls"), "tool calls present");
		assert.ok(output.includes("· 1 failed"), "failed count present");
	});
});

// ─── Tests: buildPipelineSummary — errorMsg in failed branch ────────
