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

describe("buildPipelineSummary — config-load-failure error path", () => {
	it("undefined config → bare #N issue link, no crash (regression: TypeError reading 'repo')", () => {
		const output = buildPipelineSummary(emptyResults, "failed", 42, "Title", undefined);
		assert.ok(output.includes("**Issue:** #42"), "bare #N link when repo unknown");
		assert.ok(!output.includes("github.com/undefined"), "no undefined repo link");
	});
});

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
				error: "Already implemented on base branch — no new changes to PR",
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
			assert.ok(
				output.includes("Already implemented on base branch"),
				"should show why PR was skipped",
			);
		});

		it("skipped PR does not alter Closes #N line", () => {
			const prResult: PrCreationResult = {
				success: false,
				error: "Already implemented on base branch — no new changes to PR",
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

// ─── Tests: buildPipelineSummary — header emoji/text ────────────

describe("buildPipelineSummary — header emoji/text", () => {
	it("overallStatus=success → header ## ✅ Pipeline Complete", () => {
		const output = buildPipelineSummary(emptyResults, "success", 42, "Test", defaultConfig);
		assert.ok(
			output.includes("## ✅ Pipeline Complete"),
			"success should show ✅ and Pipeline Complete",
		);
	});

	it("overallStatus=success with failed PR → header ## ⚠️ Pipeline Complete (PR creation failed)", () => {
		const prResult: PrCreationResult = { success: false, error: "GitHub API error" };
		const output = buildPipelineSummary(
			emptyResults,
			"success",
			42,
			"Test",
			defaultConfig,
			undefined,
			prResult,
		);
		assert.ok(
			output.includes("## ⚠️ Pipeline Complete (PR creation failed)"),
			"success + failed PR should show ⚠️ and PR creation failed text",
		);
	});

	it("overallStatus=failed → header ## ❌ Pipeline Failed", () => {
		const output = buildPipelineSummary(emptyResults, "failed", 42, "Test", defaultConfig);
		assert.ok(
			output.includes("## ❌ Pipeline Failed"),
			"failed should show ❌ and Pipeline Failed",
		);
	});

	it("overallStatus=stopped → header ## ⏹ Pipeline Stopped", () => {
		const output = buildPipelineSummary(
			emptyResults,
			"stopped",
			42,
			"Test",
			defaultConfig,
			"User interrupted",
		);
		assert.ok(
			output.includes("## ⏹ Pipeline Stopped"),
			"stopped should show ⏹ and Pipeline Stopped",
		);
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
