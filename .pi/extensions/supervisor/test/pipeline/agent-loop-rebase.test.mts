// ─── Tests: pre-Implementation rebase wiring (issue #1473) ────────
// Phase 3: StageState.rebaseConflictFiles lifecycle (entity tests on the
//          state object shared across loop iterations).
// Phase 5: agent-loop.ts pre-dispatch wiring (source analysis, per repo
//          convention — the dispatch path has no direct unit tests).
// Phase 4 pattern reference: gate-failure-context.test.mts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StageState } from "../../pipeline/stages/core.ts";
import { createStageState, applyGateFailureContext } from "../../pipeline/stages/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AGENT_LOOP_TS = resolve(__dirname, "../../pipeline/handler/agent-loop.ts");

function agentLoopSource(): string {
	return readFileSync(AGENT_LOOP_TS, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 3: StageState.rebaseConflictFiles lifecycle
// ---------------------------------------------------------------------------

describe("StageState — rebaseConflictFiles field (Phase 3, Issue #1473)", () => {
	it("createStageState('Implementation') — rebaseConflictFiles is undefined", () => {
		const state = createStageState("Implementation");
		assert.ok(
			"rebaseConflictFiles" in state,
			"rebaseConflictFiles field exists on StageState",
		);
		assert.equal(state.rebaseConflictFiles, undefined);
	});

	it("set on conflict → read back same string[]", () => {
		const state = createStageState("Implementation");
		state.rebaseConflictFiles = ["src/a.ts", "src/b.ts"];
		assert.deepEqual(state.rebaseConflictFiles, ["src/a.ts", "src/b.ts"]);
	});

	it("cleared by assigning undefined (next successful pre-dispatch rebase)", () => {
		const state = createStageState("Implementation");
		state.rebaseConflictFiles = ["src/a.ts"];
		state.rebaseConflictFiles = undefined;
		assert.equal(state.rebaseConflictFiles, undefined);
	});

	it("independent of gateFailureContext — applyGateFailureContext never disturbs rebaseConflictFiles", () => {
		const state: StageState = createStageState("Implementation");
		state.rebaseConflictFiles = ["src/a.ts"];
		applyGateFailureContext(state, "Implementation", "CI gate failed");
		assert.deepEqual(
			state.rebaseConflictFiles,
			["src/a.ts"],
			"setting gateFailureContext must not clear rebaseConflictFiles",
		);
		assert.equal(state.gateFailureContext, "CI gate failed");
		// And vice versa: conflict context never touches gateFailureContext
		state.gateFailureContext = "previous";
		state.rebaseConflictFiles = ["src/b.ts"];
		assert.equal(state.gateFailureContext, "previous");
	});

	it("independent of gateFailureContext — Audit transition clears only gateFailureContext", () => {
		const state = createStageState("Implementation");
		state.gateFailureContext = "GATE_FAILED";
		state.rebaseConflictFiles = ["src/a.ts"];
		applyGateFailureContext(state, "Audit", "");
		assert.equal(state.gateFailureContext, undefined, "gate context cleared on Audit");
		assert.deepEqual(
			state.rebaseConflictFiles,
			["src/a.ts"],
			"rebaseConflictFiles survives status transitions (loop-back state)",
		);
	});

	it("createStageState initializes all fields alongside the new one", () => {
		const state = createStageState("Research");
		assert.equal(state.loopStatus, "Research");
		assert.equal(state.lastAuditScore, null);
		assert.equal(state.auditCycleCount, 0);
		assert.equal(state.researcherSkipped, false);
		assert.equal(state.duplicateCodeResult, null);
		assert.equal(state.deadCodeResult, null);
		assert.equal(state.vulnResult, null);
		assert.equal(state.gateFailureContext, undefined);
		assert.deepEqual(state.gateFailureHistory, []);
		assert.equal(state.rebaseConflictFiles, undefined);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: agent-loop.ts pre-dispatch wiring (source analysis)
// ---------------------------------------------------------------------------

describe("agent-loop.ts — pre-Implementation rebase wiring (Phase 5, Issue #1473)", () => {
	it("tryRebaseOntoBase imported from ../rebase.ts", () => {
		const src = agentLoopSource();
		assert.ok(
			src.includes('import { tryRebaseOntoBase } from "../rebase.ts"'),
			"tryRebaseOntoBase imported from pipeline/rebase.ts",
		);
	});

	it("refreshWorktreeBeforeImplementation invoked inside the loop BEFORE `const task = buildAgentTask(`", () => {
		const src = agentLoopSource();
		const loopIdx = src.indexOf("for (let i = 0; i < MAX_PIPELINE_LOOPS");
		const refreshIdx = src.indexOf("refreshWorktreeBeforeImplementation(runCtx, worktreePath)");
		const taskIdx = src.indexOf("const task = buildAgentTask(");
		assert.ok(loopIdx >= 0, "loop found");
		assert.ok(refreshIdx >= 0, "helper invoked");
		assert.ok(taskIdx >= 0, "buildAgentTask call found");
		assert.ok(
			refreshIdx > loopIdx && refreshIdx < taskIdx,
			"refresh fires on every developer dispatch, before task build (incl. Audit→Implementation loop-back)",
		);
		// The helper itself invokes the rebase mechanics
		const helperIdx = src.indexOf("async function refreshWorktreeBeforeImplementation");
		const rebaseCallIdx = src.indexOf("await tryRebaseOntoBase(");
		assert.ok(rebaseCallIdx > helperIdx, "tryRebaseOntoBase invoked inside the helper");
	});

	it("guarded by agentName === \"developer\" && worktreePath && worktreeBranch", () => {
		const src = agentLoopSource();
		const refreshIdx = src.indexOf("refreshWorktreeBeforeImplementation(runCtx, worktreePath)");
		const guard = src.slice(0, refreshIdx);
		assert.ok(
			guard.includes('agentName === "developer" && worktreePath && worktreeBranch'),
			"developer-only guard with worktree present — never fires for researcher/architect/test-designer/auditor",
		);
	});

	it("helper calls tryRebaseOntoBase with { mergeFallback: false }", () => {
		const src = agentLoopSource();
		const helperIdx = src.indexOf("async function refreshWorktreeBeforeImplementation");
		const rebaseCallIdx = src.indexOf("await tryRebaseOntoBase(");
		const callBlock = src.slice(rebaseCallIdx, rebaseCallIdx + 300);
		assert.ok(callBlock.includes("{ mergeFallback: false }"), "mergeFallback disabled for pre-dispatch refresh");
		assert.ok(
			src.slice(helperIdx).includes("tryRebaseOntoBase("),
			"rebase call lives in the helper, not the loop",
		);
	});

	it("conflict path — stageState.rebaseConflictFiles set, context derived from it, developer dispatched normally", () => {
		const src = agentLoopSource();
		const conflictIdx = src.indexOf("rebaseResult.conflictFiles.length > 0");
		assert.ok(conflictIdx >= 0, "conflict branch present");
		const conflictBlock = src.slice(conflictIdx, conflictIdx + 400);
		assert.ok(
			conflictBlock.includes("stageState.rebaseConflictFiles = rebaseResult.conflictFiles"),
			"conflict files stored in stage state",
		);
		assert.ok(
			conflictBlock.includes("rebaseConflictContext = rebaseResult.conflictFiles.join"),
			"task context derived from conflict files",
		);
		assert.ok(
			src.includes("rebaseConflictContext,"),
			"context passed to buildAgentTask (appended arg)",
		);
		// Developer dispatched normally regardless of conflict state: the loop
		// builds the task unconditionally, feeding it the helper's context.
		const taskIdx = src.indexOf("const task = buildAgentTask(");
		const guardIdx = src.indexOf("refreshWorktreeBeforeImplementation(runCtx, worktreePath)");
		assert.ok(taskIdx >= 0, "buildAgentTask call present");
		assert.ok(
			guardIdx < taskIdx,
			"refresh (with conflict context) completes before the task is built",
		);
	});

	it("fetch/non-conflict failure — fail-open: warning surfaced, context NOT set, stale base proceeds", () => {
		const src = agentLoopSource();
		const failIdx = src.indexOf("rebaseResult.conflictFiles.length > 0");
		const elseBlock = src.slice(failIdx + 100);
		assert.ok(
			elseBlock.includes("stageState.rebaseConflictFiles = undefined;"),
			"non-conflict failure clears stale conflict state (no context injected)",
		);
		assert.ok(
			elseBlock.includes("proceeding with current base"),
			"fail-open: developer proceeds on stale base",
		);
		assert.ok(
			/collector\?\.push\([\s\S]*Pre-Implementation rebase failed/.test(elseBlock),
			"failure surfaced via collector",
		);
		assert.ok(elseBlock.includes("ctx.ui.notify("), "failure surfaced via notify");
	});

	it("success path — rebaseConflictFiles cleared, no context injected", () => {
		const src = agentLoopSource();
		const successIdx = src.indexOf("if (rebaseResult.success)");
		assert.ok(successIdx >= 0, "success branch present");
		const successBlock = src.slice(successIdx, successIdx + 200);
		assert.ok(
			successBlock.includes("stageState.rebaseConflictFiles = undefined"),
			"success clears stale conflict context",
		);
	});

	it("exception safety — try/catch around the rebase call, fail-open on throw", () => {
		const src = agentLoopSource();
		const helperIdx = src.indexOf("async function refreshWorktreeBeforeImplementation");
		const helperBlock = src.slice(helperIdx);
		assert.ok(helperBlock.includes("try {"), "rebase wrapped in try/catch");
		assert.ok(helperBlock.includes("} catch (rebaseErr"), "catch block present");
	});

	it("regression — auditFeedback/gateFailureContext/deadCodeResult/vulnResult injection paths unchanged", () => {
		const src = agentLoopSource();
		assert.ok(
			src.includes('agentName === "developer"\n\t\t\t\t? (() => {'),
			"auditFeedback extraction intact",
		);
		assert.ok(
			src.includes("stageState.gateFailureContext,"),
			"gateFailureContext still passed to buildAgentTask",
		);
		assert.ok(
			src.includes("buildDeadCodeContext(stageState.deadCodeResult)"),
			"deadCodeContext injection intact",
		);
		assert.ok(
			src.includes("buildVulnContext(stageState.vulnResult)"),
			"vulnContext injection intact",
		);
		assert.ok(
			src.includes("buildDuplicateCodeContext(stageState.duplicateCodeResult)"),
			"duplicateCodeContext injection intact",
		);
		// New param appended AFTER systemPromptOptions — prior arg ordering preserved
		const taskCallStart = src.indexOf("const task = buildAgentTask(");
		const taskCall = src.slice(taskCallStart, taskCallStart + 1600);
		const gfcIdx = taskCall.indexOf("stageState.gateFailureContext,");
		const spoIdx = taskCall.indexOf("systemPromptOptions,");
		const rccIdx = taskCall.indexOf("rebaseConflictContext,");
		assert.ok(gfcIdx >= 0 && spoIdx >= 0 && rccIdx >= 0, "all three args present");
		assert.ok(
			gfcIdx < spoIdx && spoIdx < rccIdx,
			"param order preserved: gateFailureContext → systemPromptOptions → rebaseConflictContext",
		);
	});
});
