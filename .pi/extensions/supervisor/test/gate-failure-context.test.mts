// ─── Tests: Gate Failure Context (Issue #787) ─────────────────────
// Phase 1: StageState gateFailureContext field — interface contract
// Phase 2: applyGateFailureContext pure function
// Phase 4: handler.ts adapter integration (code analysis)
// Phase 5: Regression — existing paths unchanged
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/gate-failure-context.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStageState, applyGateFailureContext } from "../pipeline/stages/index.ts";
import type { StageState } from "../pipeline/stages/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLER_TS = resolve(__dirname, "../pipeline/handler/agent-loop.ts");

function readHandlerSource(): string {
	return readFileSync(HANDLER_TS, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 1: StageState gateFailureContext field — interface contract
// ---------------------------------------------------------------------------

describe("StageState — gateFailureContext field (Phase 1, Issue #787)", () => {
	it("interface has gateFailureContext?: string field (type-level verification via compilation)", () => {
		const state = createStageState("Implementation");
		assert.ok("gateFailureContext" in state, "gateFailureContext field exists on StageState");
	});

	it("createStageState('Implementation') — gateFailureContext is undefined", () => {
		const state = createStageState("Implementation");
		assert.equal(state.gateFailureContext, undefined);
	});

	it("setting gateFailureContext then reading it back returns the same string", () => {
		const state = createStageState("Implementation");
		state.gateFailureContext = "CI_FAILED: build check failed";
		assert.equal(state.gateFailureContext, "CI_FAILED: build check failed");
	});

	it("setting gateFailureContext then assigning undefined clears it", () => {
		const state = createStageState("Implementation");
		state.gateFailureContext = "some note";
		state.gateFailureContext = undefined;
		assert.equal(state.gateFailureContext, undefined);
	});

	it("createStageState initializes all existing fields correctly alongside new field", () => {
		const state = createStageState("Implementation");
		assert.equal(state.loopStatus, "Implementation");
		assert.equal(state.lastAuditScore, null);
		assert.equal(state.auditCycleCount, 0);
		assert.equal(state.duplicateCodeResult, null);
		assert.equal(state.researcherSkipped, false);
		assert.equal(state.deadCodeResult, null);
		assert.equal(state.gateFailureContext, undefined);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: applyGateFailureContext pure function
// ---------------------------------------------------------------------------

describe("applyGateFailureContext (Phase 2, Issue #787)", () => {
	it("stores note when effectiveNextStatus is Implementation and note is non-empty", () => {
		const state: StageState = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "CI_FAILED: build check");
		assert.equal(state.gateFailureContext, "CI_FAILED: build check");
	});

	it("does not change state when effectiveNextStatus is Implementation with empty note", () => {
		const state: StageState = createStageState("Implementation");
		state.gateFailureContext = "previous context";
		applyGateFailureContext(state, "Implementation", "");
		assert.equal(state.gateFailureContext, "previous context");
	});

	it("clears context when effectiveNextStatus is Audit (successful gate pass)", () => {
		const state: StageState = createStageState("Audit");
		state.gateFailureContext = "CI_FAILED: build check";
		applyGateFailureContext(state, "Audit", "");
		assert.equal(state.gateFailureContext, undefined);
	});

	it("clears context even when note is non-empty but status is Audit", () => {
		const state: StageState = createStageState("Audit");
		state.gateFailureContext = "previous failure";
		applyGateFailureContext(state, "Audit", "some info note");
		assert.equal(state.gateFailureContext, undefined);
	});

	it("leaves state unchanged when status is neither Implementation nor Audit (e.g. Done)", () => {
		const state: StageState = createStageState("Done");
		state.gateFailureContext = "existing context";
		applyGateFailureContext(state, "Done", "some note");
		assert.equal(state.gateFailureContext, "existing context");
	});

	it("no-op on Implementation with whitespace-only note", () => {
		const state: StageState = createStageState("Implementation");
		state.gateFailureContext = "existing context";
		applyGateFailureContext(state, "Implementation", "   ");
		assert.equal(state.gateFailureContext, "existing context");
	});
});

// ---------------------------------------------------------------------------
// Phase 4: Handler capture integration — code analysis
// ---------------------------------------------------------------------------

describe("pipeline handler — gate failure context capture (Phase 4, Issue #787)", () => {
	it("handler source contains applyGateFailureContext import from stages/index.ts", () => {
		const src = readHandlerSource();
		// Issue #1395 split: agent-loop.ts lives in the handler/ subdirectory;
		// issue #1397 split turned stages.ts into the stages/ directory, so the
		// import is "../stages/index.ts" (barrel) instead of "../stages.ts".
		const stagesImport = '} from "../stages/index.ts"';
		const importSection = src.substring(0, src.indexOf(stagesImport) + stagesImport.length + 1);
		assert.ok(
			importSection.includes("applyGateFailureContext"),
			"applyGateFailureContext imported from stages/index.ts",
		);
	});

	it("handler source captures auditResult.note into stageState via applyGateFailureContext", () => {
		const src = readHandlerSource();
		const idx = src.indexOf("effectiveNextStatus = auditResult.nextStatus");
		const hookSection = src.substring(idx, idx + 800);
		assert.ok(
			hookSection.includes("applyGateFailureContext"),
			"applyGateFailureContext called after effectiveNextStatus assignment",
		);
		assert.ok(
			hookSection.includes("stageState") &&
				hookSection.includes("effectiveNextStatus") &&
				hookSection.includes("auditResult.note"),
			"applyGateFailureContext receives stageState, effectiveNextStatus, auditResult.note",
		);
	});

	it("handler source passes stageState.gateFailureContext to buildAgentTask", () => {
		const src = readHandlerSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("stageState.gateFailureContext,") ||
				btSection.includes("stageState.gateFailureContext\n"),
			"stageState.gateFailureContext passed to buildAgentTask",
		);
	});

	it("gateFailureContext passed before systemPromptOptions (parameter ordering)", () => {
		const src = readHandlerSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		const gfcIdx = btSection.indexOf("stageState.gateFailureContext");
		const spoIdx = btSection.indexOf("systemPromptOptions");
		assert.ok(
			gfcIdx >= 0 && spoIdx >= 0 && gfcIdx < spoIdx,
			"gateFailureContext argument appears before systemPromptOptions",
		);
	});

	it("all gate failure context blocks exist in pre-transition hook section", () => {
		const src = readHandlerSource();
		assert.ok(
			src.includes("applyGateFailureContext(stageState, effectiveNextStatus, auditResult.note"),
			"applyGateFailureContext call in pre-transition hook section",
		);
		assert.ok(
			src.includes("auditResult.deadCodeResult"),
			"deadCodeResult block in pre-transition hook section",
		);
		assert.ok(
			src.includes("auditResult.duplicateCodeResult"),
			"duplicateCodeResult block in pre-transition hook section",
		);
	});

	it("no change to existing deadCodeResult/duplicateCodeResult blocks (no regression)", () => {
		const src = readHandlerSource();
		assert.ok(src.includes("if (auditResult.deadCodeResult)"), "deadCodeResult block still exists");
		assert.ok(
			src.includes("if (auditResult.duplicateCodeResult)"),
			"duplicateCodeResult block still exists",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: Regression — existing pre-transition hooks and paths unchanged
// ---------------------------------------------------------------------------
// Issue #1407: audit.ts split into pipeline/audit/*. Section strings live in
// pre-gates.ts, gate decisions in tsc-gate.ts/lsp-gate.ts, and the
// Implementation/Audit rule in aggregate.ts (orchestrator pushes failures).

describe("Regression — existing pre-transition hooks unchanged (Phase 5, Issue #787)", () => {
	const PRE_GATES = resolve(__dirname, "../pipeline/audit/pre-gates.ts");
	const AGGREGATE = resolve(__dirname, "../pipeline/audit/aggregate.ts");
	const TSC_GATE = resolve(__dirname, "../pipeline/audit/tsc-gate.ts");
	const LSP_GATE = resolve(__dirname, "../pipeline/audit/lsp-gate.ts");
	const INDEX = resolve(__dirname, "../pipeline/audit/index.ts");

	it("CI gating still returns nextStatus Implementation on failure and adds to gateFailures", async () => {
		const preGatesSrc = readFileSync(PRE_GATES, "utf-8");
		const aggregateSrc = readFileSync(AGGREGATE, "utf-8");
		const indexSrc = readFileSync(INDEX, "utf-8");
		assert.ok(preGatesSrc.includes("--- CI Gate ---"), "CI Gate section in pre-gates.ts");
		assert.ok(
			aggregateSrc.includes('nextStatus: "Implementation"'),
			"Implementation decision in aggregate.ts",
		);
		assert.ok(indexSrc.includes("gateFailures.push"), "orchestrator pushes gate failures");
	});

	it("Dead code gate appends failure to gateFailures (no issue comment)", () => {
		const preGatesSrc = readFileSync(PRE_GATES, "utf-8");
		const aggregateSrc = readFileSync(AGGREGATE, "utf-8");
		const indexSrc = readFileSync(INDEX, "utf-8");
		assert.ok(
			preGatesSrc.includes("--- Dead Code Gate ---"),
			"Dead code gate section in pre-gates.ts",
		);
		assert.ok(indexSrc.includes("gateFailures.push"), "orchestrator pushes gate failures");
		assert.ok(
			!preGatesSrc.includes("## 🔴 Dead Code Gate — Implementation Rejected") &&
				!aggregateSrc.includes("## 🔴 Dead Code Gate — Implementation Rejected"),
			"Dead code gate no longer posts a separate issue comment",
		);
		assert.ok(
			aggregateSrc.includes('nextStatus: "Implementation"') && aggregateSrc.includes("note: `"),
			"Dead code gate still returns Implementation with note for developer context",
		);
	});

	it("TSC checkpoint still returns { nextStatus, note } on failure", () => {
		const src = readFileSync(TSC_GATE, "utf-8");
		assert.ok(
			src.includes("nextStatus: tscDecision.nextStatus") && src.includes("note: tscDecision.note"),
			"TSC checkpoint returns nextStatus and note",
		);
	});

	it("LSP pre-audit still returns { nextStatus, note } on failure", () => {
		const src = readFileSync(LSP_GATE, "utf-8");
		assert.ok(
			src.includes("return { nextStatus: decision.nextStatus, note: decision.note }"),
			"LSP pre-audit returns nextStatus and note",
		);
	});

	it("auditor rejection path (auditFeedback via comment-scanning) unchanged", () => {
		const src = readHandlerSource();
		assert.ok(src.includes("/##\\s*Audit\\s*Rejected/i"), "auditFeedback regex unchanged");
	});

	it("pre-transition hooks step.hooks check still includes all hook types", () => {
		const src = readHandlerSource();
		assert.ok(src.includes(`["ci", "tsc", "lsp", "dup", "trace"]`), "step.hooks check unchanged");
	});
});
