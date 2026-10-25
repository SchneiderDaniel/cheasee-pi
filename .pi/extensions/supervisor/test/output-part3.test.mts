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
describe("buildPipelineSummary — errorMsg in failed branch", () => {
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

	const successAgent = (): PipelineAgentResult =>
		makeAgent("developer", "SUCCESS", 5000, 30000, 10);
	const failedAgent = (): PipelineAgentResult => makeAgent("auditor", "FAILED", 0, 5000, 0);

	it("failed without FAILED agent — errorMsg produces **Error:** line before manual intervention", () => {
		const output = buildPipelineSummary(
			[successAgent()],
			"failed",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			"Something went wrong in dispatch",
		);
		assert.ok(
			output.includes("**Error:** Something went wrong in dispatch"),
			"should include error message",
		);
		assert.ok(
			output.includes("**Manual intervention required.**"),
			"should include manual intervention",
		);
		// Error line should appear before manual intervention
		const errorIdx = output.indexOf("**Error:**");
		const manualIdx = output.indexOf("**Manual intervention required.**");
		assert.ok(
			errorIdx >= 0 && manualIdx >= 0 && errorIdx < manualIdx,
			"Error line before manual intervention",
		);
	});

	it("failed WITH FAILED agent + errorMsg — both Stopped at and Error appear", () => {
		const output = buildPipelineSummary(
			[successAgent(), failedAgent()],
			"failed",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			"Mid-dispatch exception",
		);
		assert.ok(
			output.includes("**Stopped at:** auditor"),
			"should include Stopped at for failed agent",
		);
		assert.ok(output.includes("**Error:** Mid-dispatch exception"), "should include error message");
		// Stopped at should come before Error
		const stoppedIdx = output.indexOf("**Stopped at:**");
		const errorIdx = output.indexOf("**Error:**");
		assert.ok(stoppedIdx >= 0 && errorIdx >= 0 && stoppedIdx < errorIdx, "Stopped at before Error");
	});

	// Audit finding #1987: a timed-out agent is recorded FAILED, so the
	// detailed stopReason must survive into the failed summary rather than
	// collapsing to the generic "agent failed" line.
	it("failed + detailed stopReason — renders the reason, not the generic 'agent failed' line", () => {
		const timeoutReason =
			"Agent developer timed out (configured 3600s, actual 3600123ms; tier large, base 1800000ms, effective 3600000ms, preserved 2 file(s) as abc1234)";
		const output = buildPipelineSummary(
			[failedAgent()],
			"failed",
			1987,
			"Large issue",
			defaultConfig,
			timeoutReason,
		);
		assert.ok(
			output.includes("**Stopped at:** Agent developer timed out"),
			"detailed stopReason rendered",
		);
		assert.ok(output.includes("tier large"), "declared tier is user-visible");
		assert.ok(output.includes("effective 3600000ms"), "effective timeout is user-visible");
		assert.ok(output.includes("preserved 2 file(s)"), "preserved work is user-visible");
		assert.ok(
			!output.includes("— agent failed"),
			"generic agent-failed line is suppressed when a stopReason is present",
		);
	});

	it("errorMsg omitted (backward compat) — no Error line", () => {
		const output = buildPipelineSummary(
			[successAgent(), failedAgent()],
			"failed",
			42,
			"Test",
			defaultConfig,
		);
		assert.ok(
			!output.includes("**Error:**"),
			"should not include Error line when errorMsg omitted",
		);
		assert.ok(output.includes("**Stopped at:** auditor"), "Stopped at still present");
	});

	it("errorMsg truncated at 80 chars", () => {
		const longMsg = "x".repeat(100);
		const output = buildPipelineSummary(
			[successAgent()],
			"failed",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			longMsg,
		);
		assert.ok(output.includes("x".repeat(80) + "..."), "should truncate at 80 chars");
		assert.ok(!output.includes("x".repeat(81)), "chars beyond 80 should not appear");
	});

	it("errorMsg exactly 80 chars — not truncated", () => {
		const exactly80 = "a".repeat(80);
		const output = buildPipelineSummary(
			[successAgent()],
			"failed",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			exactly80,
		);
		assert.ok(output.includes(exactly80), "80-char message should not be truncated");
	});

	it("errorMsg empty string — no Error line", () => {
		const output = buildPipelineSummary(
			[successAgent()],
			"failed",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			"",
		);
		assert.ok(!output.includes("**Error:**"), "should not render Error line for empty string");
	});

	it("errorMsg with newlines — first line visible in Error line", () => {
		const multiLineMsg = "First line error\nSecond line\nThird line";
		const output = buildPipelineSummary(
			[successAgent()],
			"failed",
			42,
			"Test",
			defaultConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			multiLineMsg,
		);
		assert.ok(
			output.includes("**Error:** First line error"),
			"first line of multiline error should appear",
		);
	});
});
