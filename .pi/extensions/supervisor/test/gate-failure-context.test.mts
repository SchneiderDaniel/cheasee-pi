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
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, SupervisorConfig } from "../config/types.ts";
import type { RunContext } from "../pipeline/handler/shared.ts";
import { createStageState, applyGateFailureContext } from "../pipeline/stages/index.ts";
import type { StageState } from "../pipeline/stages/index.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";
import { readGraph } from "../../lib/test/source-graph.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLER_TS = resolve(__dirname, "../pipeline/handler/agent-loop.ts");

// runAgentLoop with the audit module mocked needs --experimental-test-module-mocks.
// Without it the Phase 4 integration suite is skipped; the pure-function and
// module-graph suites below still run.
const hasMockModule = typeof mock.module === "function";

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
// The wire-in is exercised through the real runAgentLoop with the audit module
// mocked. Every assertion observes runtime effects (stageState, pi.sendMessage,
// ctx.ui.notify), never source text. The suite is guarded by hasMockModule, so
// the pure-function and module-graph suites still run without the flag.

const WT = mkdtempSync(join(tmpdir(), "gate-failure-wt-"));

const HOOK_CONFIG: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Architecture: "architect",
		Research: "researcher",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees/",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 0,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
	agentTimeoutsMin: {},
};

const HOOK_FIELDS: Array<{ id: string; name: string; type: string; options: Array<{ id: string; name: string }> }> =
	[
		{
			id: "status-field-id",
			name: "Status",
			type: "single_select",
			options: [
				{ id: "opt-research", name: "Research" },
				{ id: "opt-architecture", name: "Architecture" },
				{ id: "opt-test-design", name: "TestDesign" },
				{ id: "opt-implementation", name: "Implementation" },
				{ id: "opt-audit", name: "Audit" },
				{ id: "opt-done", name: "Done" },
			],
		},
	];

// The mocked audit runner's next result; set per test, read at call time.
let nextAuditResult: Record<string, unknown> = { nextStatus: "Audit", note: "ok" };
const auditSpy = mock.fn(async (..._args: unknown[]) => nextAuditResult);

if (hasMockModule) {
	mock.module("../pipeline/audit/index.ts", {
		namedExports: { runTscAndLspAudit: auditSpy as unknown },
	});
}

function makeAgentResult(agentName: string, overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName,
		toolCount: 5,
		tokenCount: 1000,
		durationMs: 10000,
		textOutput: "",
		textOnly: "",
		summaryLine: "did work",
		errorOutput: "",
		...overrides,
	};
}

function developerSuccess(): AgentRunResult {
	return makeAgentResult("developer", {
		textOutput: "Implemented\nIMPLEMENTATION_COMPLETE",
		textOnly: "IMPLEMENTATION_COMPLETE",
	});
}

function failure(): AgentRunResult {
	return makeAgentResult("developer", { success: false, textOutput: "stop", textOnly: "stop" });
}

function scriptedRunner(results: AgentRunResult[]): ReturnType<typeof mock.fn> {
	return mock.fn(async () => results.shift() ?? failure());
}

function buildHookRunContext(opts: {
	runner: ReturnType<typeof mock.fn>;
	notify: ReturnType<typeof mock.fn>;
	stageState: StageState;
	pi: ExtensionAPI;
	loopStatus: string;
}): RunContext {
	return {
		args: undefined,
		ctx: {
			cwd: WT,
			ui: { notify: opts.notify, setStatus: () => {} },
		} as unknown as ExtensionCommandContext,
		pi: opts.pi,
		issueNum: 787,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) => {
			if (cmd === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 787,
						title: "Gate failure context",
						body: "body",
						author: { login: "user1" },
						comments: [],
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		}) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: HOOK_CONFIG,
		port: {
			getClosingPrsForIssue: async () => [],
			postIssueComment: async () => {},
			closeIssue: async () => {},
			setItemStatusField: async () => {},
		} as any,
		issueTitle: "Gate failure context",
		filteredData: { body: "body", comments: [] },
		issueData: {
			number: 787,
			title: "Gate failure context",
			body: "body",
			author: { login: "user1" },
			comments: [],
		},
		stageState: opts.stageState,
		loopStatus: opts.loopStatus,
		loopItem: { id: "item-1" },
		fields: HOOK_FIELDS as any,
		statusField: HOOK_FIELDS[0] as any,
		projectId: "project-1",
		worktreePath: WT,
		worktreeBranch: "worktree-git-issue-787-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

async function runHooks(
	auditResult: Record<string, unknown>,
	opts: { stageState?: StageState; results?: AgentRunResult[]; loopStatus?: string } = {},
) {
	nextAuditResult = auditResult;
	auditSpy.mock.resetCalls();
	const notify = mock.fn();
	const sendMessage = mock.fn();
	const pi = {
		exec: (async (cmd: string, args: string[]) => {
			// Report branch commits so the empty-worktree guard lets the
			// Implementation→Audit transition (and its gate hooks) run.
			if (cmd === "git" && args[0] === "rev-list") {
				return { code: 0, stdout: "1", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		}) as any,
		sendMessage,
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	const stageState = opts.stageState ?? createStageState("Implementation");
	const runCtx = buildHookRunContext({
		runner: scriptedRunner(opts.results ?? [developerSuccess()]),
		notify,
		stageState,
		pi,
		loopStatus: opts.loopStatus ?? "Implementation",
	});
	const { runAgentLoop } = await import("../pipeline/handler/agent-loop.ts");
	await runAgentLoop(runCtx);
	return { stageState, notify, sendMessage, runCtx };
}

if (hasMockModule) {
	describe("pre-transition hooks — gate failure capture (Phase 4, Issue #787)", () => {
		it("stores the blocking note and records the failure in stage state", async () => {
			const { stageState } = await runHooks({
				nextStatus: "Implementation",
				note: "--- CI Gate ---\nCI_FAILED: build check",
			});
			assert.ok(
				stageState.gateFailureContext?.includes("CI_FAILED: build check"),
				"failure context stored on stage state",
			);
			assert.equal(stageState.gateFailureHistory.length, 1, "history records the failed run");
			assert.equal(
				auditSpy.mock.calls[0]!.arguments[5],
				WT,
				"worktreePath forwarded to the audit runner (6th argument)",
			);
		});

		it("sends exactly one gate-failure message and a warning notification", async () => {
			const { notify, sendMessage } = await runHooks({
				nextStatus: "Implementation",
				note: "CI_FAILED: build check",
			});
			const blockedMessages = sendMessage.mock.calls.filter((c: any) =>
				String(c.arguments[0]?.content ?? "").includes("Pre-Transition Gates Blocked"),
			);
			assert.equal(blockedMessages.length, 1, "one gate-failure message");
			assert.ok(
				String(blockedMessages[0]!.arguments[0].content).includes("CI_FAILED: build check"),
				"message carries the failure note",
			);
			const blocked = notify.mock.calls.find(
				(c: any) =>
					c.arguments[1] === "warning" &&
					String(c.arguments[0]).includes("Pre-transition gates blocked"),
			);
			assert.ok(blocked, "one warning notification for the blocked transition");
		});

		it("clears the stored context and stays silent when the gate passes", async () => {
			const stageState = createStageState("Implementation");
			stageState.gateFailureContext = "stale failure";
			const { notify, sendMessage } = await runHooks(
				{ nextStatus: "Audit", note: "all gates passed" },
				{ stageState },
			);
			assert.equal(stageState.gateFailureContext, undefined, "context cleared on pass");
			const blockedMessages = sendMessage.mock.calls.filter((c: any) =>
				String(c.arguments[0]?.content ?? "").includes("Pre-Transition Gates Blocked"),
			);
			assert.equal(blockedMessages.length, 0, "no gate-failure message on a pass");
			const blocked = notify.mock.calls.find(
				(c: any) => c.arguments[1] === "warning" && String(c.arguments[0]).includes("Pre-transition"),
			);
			assert.equal(blocked, undefined, "no blocked-transition warning on a pass");
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
			const { stageState } = await runHooks({
				nextStatus: "Audit",
				note: "ok",
				deadCodeResult,
				duplicateCodeResult,
				vulnResult,
			});
			assert.equal(stageState.deadCodeResult, deadCodeResult);
			assert.equal(stageState.duplicateCodeResult, duplicateCodeResult);
			assert.equal(stageState.vulnResult, vulnResult);
		});

		it("skips the audit runner when the step declares no gate hook", async () => {
			const testDesigner = makeAgentResult("test-designer", {
				textOutput: "Plan\nTEST_PLAN_COMPLETE",
				textOnly: "TEST_PLAN_COMPLETE",
			});
			await runHooks(
				{ nextStatus: "Implementation", note: "CI_FAILED" },
				{ loopStatus: "TestDesign", results: [testDesigner] },
			);
			assert.equal(auditSpy.mock.callCount(), 0, "audit runner not invoked without a gate hook");
		});
	});
}

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
