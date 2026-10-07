// ─── Tests: Gate Failure Context (Issue #787) ─────────────────────
// Phase 1: StageState gateFailureContext field — interface contract
// Phase 2: applyGateFailureContext pure function
// Phase 4: handler gate-failure wire-in (behavior via runPreTransitionHooks)
// Phase 5: Regression — module-graph edges
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/gate-failure-context.test.mts

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStageState, applyGateFailureContext } from "../pipeline/stages/index.ts";
import type { StageState } from "../pipeline/stages/index.ts";
import { readGraph } from "../../lib/test/source-graph.ts";
import { runPreTransitionHooks } from "../pipeline/handler/agent-loop.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLER_TS = resolve(__dirname, "../pipeline/handler/agent-loop.ts");

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
// Phase 4: Handler gate-failure capture — behavior (Issue #787)
// ---------------------------------------------------------------------------
// The wire-in is exercised through the exported runPreTransitionHooks with an
// injected audit runner. Every assertion observes runtime effects (stageState,
// pi.sendMessage, ctx.ui.notify), never source text.

function makeHookHarness() {
	const notify = mock.fn();
	const sendMessage = mock.fn();
	const setStatus = mock.fn();
	const pi = { sendMessage, sendUserMessage: mock.fn() } as any;
	const ctx = { cwd: "/repo", ui: { notify, setStatus } } as any;
	return { pi, ctx, notify, sendMessage };
}

async function runHooks(
	auditResult: Record<string, unknown>,
	stageState = createStageState("Implementation"),
	iteration = 1,
) {
	const { pi, ctx, notify, sendMessage } = makeHookHarness();
	const auditFn = (async () => auditResult) as any;
	const result = await runPreTransitionHooks(
		{ hooks: ["ci"] } as any,
		"Audit",
		787,
		"Gate failure context",
		{} as any,
		"developer",
		{ body: "", comments: [] },
		"/wt/issue-787",
		pi,
		ctx,
		undefined,
		stageState,
		iteration,
		auditFn,
	);
	return { result, stageState, notify, sendMessage };
}

describe("pre-transition hooks — gate failure capture (Phase 4, Issue #787)", () => {
	it("stores the blocking note and records the failure in stage state", async () => {
		const { result, stageState } = await runHooks({
			nextStatus: "Implementation",
			note: "--- CI Gate ---\nCI_FAILED: build check",
		});
		assert.equal(result, "Implementation");
		assert.ok(
			stageState.gateFailureContext?.includes("CI_FAILED: build check"),
			"failure context stored on stage state",
		);
		assert.equal(stageState.gateFailureHistory.length, 1, "history records the failed run");
	});

	it("sends exactly one gate-failure message and a warning notification", async () => {
		const { notify, sendMessage } = await runHooks({
			nextStatus: "Implementation",
			note: "CI_FAILED: build check",
		});
		assert.equal(sendMessage.mock.callCount(), 1, "one gate-failure message");
		assert.ok(
			String(sendMessage.mock.calls[0]!.arguments[0].content).includes("CI_FAILED: build check"),
			"message carries the failure note",
		);
		assert.equal(notify.mock.callCount(), 1, "one gate-failure notification");
		assert.equal(
			notify.mock.calls[0]!.arguments[1],
			"warning",
			"notification uses warning level",
		);
	});

	it("clears the stored context and stays silent when the gate passes", async () => {
		const stageState = createStageState("Implementation");
		stageState.gateFailureContext = "stale failure";
		const { result, notify, sendMessage } = await runHooks(
			{ nextStatus: "Audit", note: "all gates passed" },
			stageState,
		);
		assert.equal(result, "Audit");
		assert.equal(stageState.gateFailureContext, undefined, "context cleared on pass");
		assert.equal(sendMessage.mock.callCount(), 0, "no message on a pass");
		assert.equal(notify.mock.callCount(), 0, "no warning on a pass");
	});

	it("stores dead-code, duplicate-code and vuln results on the stage state", async () => {
		const deadCodeResult = { status: "clean", findings: [], totalDeadLines: 0 };
		const duplicateCodeResult = {
			status: "clean",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
		};
		const vulnResult = {
			status: "clean",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
		};
		const { result, stageState } = await runHooks({
			nextStatus: "Audit",
			note: "ok",
			deadCodeResult,
			duplicateCodeResult,
			vulnResult,
		});
		assert.equal(result, "Audit");
		assert.equal(stageState.deadCodeResult, deadCodeResult);
		assert.equal(stageState.duplicateCodeResult, duplicateCodeResult);
		assert.equal(stageState.vulnResult, vulnResult);
	});

	it("skips the audit runner when the step declares no gate hook", async () => {
		const { pi, ctx, sendMessage } = makeHookHarness();
		const auditFn = (async () => {
			throw new Error("audit runner must not run without a gate hook");
		}) as any;
		const result = await runPreTransitionHooks(
			{ hooks: [] } as any,
			"Audit",
			787,
			"Gate failure context",
			{} as any,
			"developer",
			{ body: "", comments: [] },
			"/wt/issue-787",
			pi,
			ctx,
			undefined,
			createStageState("Implementation"),
			1,
			auditFn,
		);
		assert.equal(result, "Audit");
		assert.equal(sendMessage.mock.callCount(), 0);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: Regression — module-graph edges (Issue #787/#1668)
// ---------------------------------------------------------------------------
// Gate-failure behavior is owned by the Phase 4 tests above. What remains here
// is the import edge a type checker cannot express: the handler must reach
// applyGateFailureContext through the stages barrel, and the audit-feedback
// scan must use the shared anchored matcher.

describe("Regression — gate wiring module-graph edges (Phase 5, Issue #787)", () => {
	it("agent-loop.ts imports applyGateFailureContext through the stages barrel", () => {
		const graph = readGraph(HANDLER_TS);
		assert.ok(
			graph.importedNames.includes("applyGateFailureContext"),
			"applyGateFailureContext imported from the stages barrel",
		);
		assert.ok(
			graph.specifiers.includes("../stages/index.ts"),
			"wired through ../stages/index.ts",
		);
	});

	it("auditor rejection path consumes the shared anchored matcher — issue #1668", () => {
		const graph = readGraph(HANDLER_TS);
		assert.ok(
			graph.importedNames.includes("isAuditRejectedComment"),
			"auditFeedback scan imports the shared anchored matcher",
		);
		assert.ok(
			graph.specifiers.includes("../../lib/audit-headings.ts"),
			"matched via lib/audit-headings.ts (no unanchored substring regex)",
		);
	});
});
