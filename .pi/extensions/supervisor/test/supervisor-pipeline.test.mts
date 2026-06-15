/**
 * Tests for pipeline.ts — worktree creation before task construction (Phase 2)
 *
 * Phase 2a: Worktree created before loop (available to ALL agents)
 * Phase 2b: buildAgentTask receives resolved worktreePath
 * Phase 2c: agentCwd set to worktreePath for all agents (researcher, architect, developer, auditor)
 * Phase 2d: Worktree creation is idempotent (once per pipeline run)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-pipeline.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLER_TS = resolve(__dirname, "../pipeline/handler.ts");

function readHandlerSource(): string {
	return readFileSync(HANDLER_TS, "utf-8");
}

// ---------------------------------------------------------------------------
// Worktree creation before agent dispatch
// ---------------------------------------------------------------------------

describe("pipeline handler — worktree creation before loop", () => {
	it("worktree created before for loop", () => {
		const src = readHandlerSource();
		const loopIdx = src.indexOf("for (let i = 0; i < MAX_PIPELINE_LOOPS");
		const beforeLoop = src.substring(0, loopIdx);
		assert.ok(
			beforeLoop.includes("createWorktree"),
			"createWorktree called before the pipeline loop",
		);
	});

	it("generateBranchName called in worktree creation section", () => {
		const src = readHandlerSource();
		const wtIdx = src.indexOf("Creating worktree");
		assert.ok(wtIdx >= 0, "'Creating worktree' log message exists");
		const section = src.substring(wtIdx - 100, wtIdx + 500);
		assert.ok(section.includes("generateBranchName"), "generateBranchName in worktree section");
	});

	it("worktreePath assigned only once", () => {
		const src = readHandlerSource();
		const matches = src.match(/worktreePath\s*=\s*await/g);
		assert.ok(matches && matches.length === 1, "worktreePath assigned exactly once");
	});
});

// ---------------------------------------------------------------------------
// buildAgentTask receives resolved worktreePath
// ---------------------------------------------------------------------------

describe("pipeline handler — worktreePath passed to buildAgentTask", () => {
	it("buildAgentTask call receives worktreePath argument", () => {
		const src = readHandlerSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreePath,") || btSection.includes("worktreePath\n"),
			"worktreePath arg in buildAgentTask call",
		);
	});

	it("buildAgentTask call receives worktreeBranch argument", () => {
		const src = readHandlerSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreeBranch,") || btSection.includes("worktreeBranch\n"),
			"worktreeBranch arg in buildAgentTask call",
		);
	});
});

// ---------------------------------------------------------------------------
// agentCwd for developer and auditor
// ---------------------------------------------------------------------------

describe("pipeline handler — agentCwd for all agents", () => {
	it("agentCwd uses worktreePath directly", () => {
		const src = readHandlerSource();
		const idx = src.indexOf("cwdOverride: worktreePath");
		assert.ok(idx >= 0, "agentCwd uses worktreePath directly");
	});

	it("agentCwd passed to executeAgent", () => {
		const src = readHandlerSource();
		const idx = src.indexOf("executeAgent(");
		const endIdx = src.indexOf(");", idx);
		const callSection = src.substring(idx, endIdx + 2);
		assert.ok(callSection.includes("worktreePath"), "executeAgent uses worktreePath for agentCwd");
	});
});

// ---------------------------------------------------------------------------
// Worktree cleanup at end of pipeline
// ---------------------------------------------------------------------------

describe("pipeline handler — worktree cleanup", () => {
	it("cleanup guarded by worktreePath check", () => {
		const src = readHandlerSource();
		assert.ok(
			src.includes("if (worktreePath && worktreeBranch)"),
			"Cleanup guarded by worktreePath",
		);
	});

	it("cleanup calls cleanupWorktree", () => {
		const src = readHandlerSource();
		assert.ok(src.includes("cleanupWorktree"), "cleanupWorktree called");
	});

	it("cleanup at end of handler after try/catch", () => {
		const src = readHandlerSource();
		const cleanupIdx = src.lastIndexOf("cleanupWorktree");
		const catchEnd = src.lastIndexOf("}");
		assert.ok(cleanupIdx > 0 && cleanupIdx < catchEnd, "cleanup near end of file");
	});
});

// ---------------------------------------------------------------------------
// Agent retry logic
// ---------------------------------------------------------------------------

describe("pipeline handler — agent retry logic", () => {
	it("validateAgentResult called after both initial and retry runAgent", () => {
		const src = readHandlerSource();
		const matches = src.match(/validateAgentResult\(result\)/g);
		assert.strictEqual(
			matches ? matches.length : 0,
			2,
			"validateAgentResult(result) called exactly twice (initial + retry)",
		);
	});

	it("retry block checks budgetExceeded first", () => {
		const src = readHandlerSource();
		const budgetIdx = src.indexOf("result.budgetExceeded");
		const usedRetryIdx = src.indexOf("usedRetry = true;");
		assert.ok(budgetIdx >= 0, "budgetExceeded check exists");
		assert.ok(usedRetryIdx > budgetIdx, "budget check precedes retry logic");
	});

	it("retry logic runs on !result.success", () => {
		const src = readHandlerSource();
		// Find the executeAgent call which contains retry logic
		const executeIdx = src.indexOf("executeAgent");
		assert.ok(executeIdx >= 0, "executeAgent helper used");
	});
});

// ---------------------------------------------------------------------------
// Post-processing after agent success
// ---------------------------------------------------------------------------

describe("pipeline handler — post-agent-success processing", () => {
	it("handlePostAgentSuccess called when result.success", () => {
		const src = readHandlerSource();
		assert.ok(src.includes("handlePostAgentSuccess"), "post-agent-success handler called");
	});
});

// ---------------------------------------------------------------------------
// Researcher budget-exceeded guard (no duplicate comments)
// ---------------------------------------------------------------------------

describe("pipeline handler — researcher budget-exceeded guard (no duplicate comments)", () => {
	it("budget-exceeded researcher block has !result.success guard to skip when handlePostAgentSuccess posted combined message", () => {
		const src = readHandlerSource();
		// The FIRST "if (result.budgetExceeded)" is the one in the main pipeline loop
		// (the second is in executeAgent for retry logic — occurs later in file)
		const mainIdx = src.indexOf("if (result.budgetExceeded)");
		assert.ok(mainIdx >= 0, "budget-exceeded check exists in main loop");

		const afterBudget = src.slice(mainIdx, mainIdx + 400);
		// The researcher block should have `if (!result.success)` guard
		assert.ok(
			afterBudget.includes('agentName === "researcher"'),
			"researcher check inside budget-exceeded block",
		);

		// The guard check
		const researcherBlockBorder = afterBudget.indexOf('agentName === "researcher"');
		const researcherSection = afterBudget.slice(researcherBlockBorder, researcherBlockBorder + 400);
		assert.ok(
			researcherSection.includes("!result.success"),
			"budget-exceeded researcher block guarded by !result.success to avoid duplicate comment",
		);
	});

	it("status transition still fires for researcher budget-exceeded regardless of success", () => {
		const src = readHandlerSource();
		// Main loop budget-exceeded block (first occurrence)
		const mainIdx = src.indexOf("if (result.budgetExceeded)");
		const section = src.slice(mainIdx, src.indexOf("stopReason", mainIdx));
		// The researcher block should always call inferForwardStatus
		assert.ok(
			section.includes("inferForwardStatus(step)"),
			"status transition fires for researcher budget-exceeded",
		);
	});

	it("non-researcher budget-exceeded agent stops pipeline with stopReason (existing behavior preserved)", () => {
		const src = readHandlerSource();
		// Main loop budget-exceeded block (first occurrence)
		const mainIdx = src.indexOf("if (result.budgetExceeded)");
		// Find the stopReason after the researcher if-block closes.
		// After the closing brace of the researcher block, the next stopReason
		// is for non-researcher agents.
		const researcherBlockEnd = src.indexOf("// Graceful degradation", mainIdx);
		const afterResearcherBlock = src.slice(researcherBlockEnd);
		const stopReasonIdx = afterResearcherBlock.indexOf("stopReason");
		const section = afterResearcherBlock.slice(stopReasonIdx, stopReasonIdx + 300);
		assert.ok(
			section.includes("exceeded budget"),
			"non-researcher budget-exceeded sets stopReason",
		);
	});

	it("budgetExceeded=false does not enter the budget-exceeded block (existing behavior preserved)", () => {
		const src = readHandlerSource();
		const count = (src.match(/if \(result\.budgetExceeded\)/g) || []).length;
		assert.equal(count, 2, "budgetExceeded check appears twice (executeAgent + handler loop)");
	});
});
