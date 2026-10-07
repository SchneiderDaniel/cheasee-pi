/**
 * Tests for pipeline/audit/index.ts — worktreePath plumbing fix (Issue #284)
 *
 * Phase 1: `worktreePath` parameter plumbing in the audit orchestrator
 * Phase 2: `getRunGate` returns typed runner via dynamic import
 * Phase 3: `worktreePath` passed from `pipeline.ts` call site
 * Phase 4: Path construction consistency (resolvePath not string concat)
 * Phase 6: Non-standard `worktreeBase` config compatibility
 * Phase 7: TSC checkpoint try/catch error boundary (lives in tsc-gate.ts)
 *
 * Issue #1407: audit.ts was split into pipeline/audit/*; signature and
 * checkpoint assertions point at the orchestrator (index.ts), LSP assertions
 * at lsp-gate.ts, TSC error-boundary assertions at tsc-gate.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline-audit.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as stateCheckpoint from "../pipeline/state-checkpoint.ts";
import type { SupervisorConfig } from "../config/types.ts";
import type { SupervisorCheckpointState } from "../pipeline/state-checkpoint.ts";
import type { Result } from "../pipeline/result.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDIT_TS = resolve(__dirname, "../pipeline/audit/index.ts");
const LSP_GATE_TS = resolve(__dirname, "../pipeline/audit/lsp-gate.ts");
const TSC_GATE_TS = resolve(__dirname, "../pipeline/audit/tsc-gate.ts");
// Issue #1395 split: the pipeline loop moved to handler/agent-loop.ts; the
// worktree imports moved to handler/preflight.ts.
const PIPELINE_TS = resolve(__dirname, "../pipeline/handler/agent-loop.ts");
const PREFLIGHT_TS = resolve(__dirname, "../pipeline/handler/preflight.ts");
const AUDIT_GATE_DECISION_TS = resolve(__dirname, "../checks/audit-gate-decision.ts");
const TSC_CHECKPOINT_INDEX_TS = resolve(__dirname, "../../tsc-checkpoint/index.ts");

function readAuditSource(): string {
	return readFileSync(AUDIT_TS, "utf-8");
}

function readLspGateSource(): string {
	return readFileSync(LSP_GATE_TS, "utf-8");
}

function readTscGateSource(): string {
	return readFileSync(TSC_GATE_TS, "utf-8");
}

function readPipelineSource(): string {
	return readFileSync(PIPELINE_TS, "utf-8");
}

// ===========================================================================
// Phase 1: `worktreePath` parameter plumbing in `pipeline-audit.ts`
// ===========================================================================

describe("pipeline-audit.ts — worktreePath param plumbing (Phase 1)", () => {
	it("runTscAndLspAudit accepts worktreePath as 6th param (between filteredData and pi)", () => {
		const src = readAuditSource();
		const fnIdx = src.indexOf("export async function runTscAndLspAudit(");
		const fnEnd = src.indexOf("): Promise<{", fnIdx);
		const signature = src.substring(fnIdx, fnEnd);
		// Verify worktreePath is a parameter
		assert.ok(
			signature.includes("worktreePath"),
			"runTscAndLspAudit should have worktreePath parameter",
		);
		// Verify order: filteredData, worktreePath, pi, ctx
		const filteredIdx = signature.indexOf("filteredData");
		const wtIdx = signature.indexOf("worktreePath");
		const piIdx = signature.indexOf("pi:");
		const ctxIdx = signature.indexOf("ctx:");
		assert.ok(
			filteredIdx < wtIdx && wtIdx < piIdx && piIdx < ctxIdx,
			"worktreePath should be between filteredData and pi",
		);
	});

	it("runTscCheckpointFn called with worktreePath not pi", () => {
		const src = readTscGateSource();
		// Check that runTscCheckpointFn is called with worktreePath only
		const tscCallIdx = src.indexOf("runTscCheckpointFn(worktreePath");
		assert.ok(tscCallIdx >= 0, "runTscCheckpointFn(worktreePath) call exists");
		// Extract arguments after call
		const callSection = src.substring(tscCallIdx, tscCallIdx + 80);
		// Should reference worktreePath, not pi
		assert.ok(
			callSection.includes("worktreePath"),
			"runTscCheckpointFn should receive worktreePath",
		);
		assert.ok(
			!callSection.includes("runTscCheckpointFn(pi,"),
			"runTscCheckpointFn should NOT receive pi as first arg",
		);
	});

	it("runLspPreAudit signature: single worktreePath param replaces branch and wt", () => {
		const src = readLspGateSource();
		const fnIdx = src.indexOf("async function runLspPreAudit(");
		const fnEnd = src.indexOf("): Promise<{ nextStatus: string; note: string }>", fnIdx);
		const signature = src.substring(fnIdx, fnEnd);
		// Verify worktreePath is a parameter
		assert.ok(
			signature.includes("worktreePath"),
			"runLspPreAudit should have worktreePath parameter",
		);
		// Verify branch and wt parameters are removed
		assert.ok(!signature.includes("branch:"), "runLspPreAudit should not have branch parameter");
		assert.ok(!signature.includes("wt:"), "runLspPreAudit should not have wt parameter");
	});

	it("runLspPreAudit passes worktreePath to pi.exec cwd", () => {
		const src = readLspGateSource();
		// Find the pi.exec("git diff") call
		const execIdx = src.indexOf('pi.exec("git"');
		assert.ok(execIdx >= 0, "pi.exec git diff call exists");
		const execSection = src.substring(execIdx, execIdx + 150);
		// cwd should reference worktreePath or resolvePath with worktreePath
		assert.ok(execSection.includes("worktreePath"), "pi.exec cwd should reference worktreePath");
	});

	it("runLspPreAudit no longer recomputes path via generateBranchName", () => {
		const src = readLspGateSource();
		// Within runLspPreAudit function body, no generateBranchName call
		const fnIdx = src.indexOf("async function runLspPreAudit(");
		const fnBody = src.substring(fnIdx);
		// Find scope boundary (next top-level function or export)
		const nextFnIdx = fnBody.indexOf("\nexport", 1);
		const fnBodyTrimmed = nextFnIdx >= 0 ? fnBody.substring(0, nextFnIdx) : fnBody;
		assert.ok(
			!fnBodyTrimmed.includes("generateBranchName"),
			"runLspPreAudit should not call generateBranchName",
		);
	});

	it("runTscAndLspAudit no longer computes wt via string concat", () => {
		const src = readAuditSource();
		// Check that no `${config.worktreeBase!}${branch}` pattern exists in runTscAndLspAudit
		const fnIdx = src.indexOf("export async function runTscAndLspAudit(");
		const fnEndIdx = src.indexOf("function runLspPreAudit", fnIdx);
		const fnBody = fnEndIdx >= 0 ? src.substring(fnIdx, fnEndIdx) : src.substring(fnIdx);
		// Old string concat pattern should be gone
		assert.ok(
			!fnBody.includes("config.worktreeBase!") || !fnBody.includes("${branch}"),
			"runTscAndLspAudit should not use string concat for worktree path",
		);
		// Verify no 'const wt =' line in runTscAndLspAudit
		const wtLineMatch = fnBody.match(/const\s+wt\s*=\s*`/);
		assert.ok(!wtLineMatch, "runTscAndLspAudit should not have const wt = template literal");
	});

	it("generateBranchName imported for CI gating, not path construction", () => {
		const src = readAuditSource();
		// generateBranchName import is OK (needed for CI gating branch name)
		const importSection = src.substring(0, src.indexOf("export async function"));
		assert.ok(
			importSection.includes("generateBranchName"),
			"pipeline-audit.ts should import generateBranchName for CI gating",
		);
		// But it should NOT be used for string-concatenated path construction
		const fnBody = src.substring(src.indexOf("export async function"));
		const oldPathPattern = "`${config.worktreeBase!}${branch}`";
		assert.ok(
			!fnBody.includes(oldPathPattern),
			"generateBranchName not used for path string concat",
		);
	});
});

// ===========================================================================
// Phase 2: `getRunGate` returns typed runner via dynamic import
// ===========================================================================

describe("getRunGate — unified dynamic import (Phase 2)", () => {
	it("runTscCheckpoint accepts worktreePath as first param (no pi)", async () => {
		const { runTscCheckpoint } = await import("../../tsc-checkpoint/index.ts");
		// Function has 2 params: worktreePath (required) + optional getParsedCommandLineOfConfigFile
		// Verifies pi was removed from the signature — function is callable with single worktreePath arg
		assert.ok(runTscCheckpoint.length >= 1, "runTscCheckpoint should accept at least worktreePath");
	});

	it("calling resolved function with single string argument does not throw", async () => {
		const { runTscCheckpoint } = await import("../../tsc-checkpoint/index.ts");
		// Should not throw — returns empty diagnostics for nonexistent path
		await assert.doesNotReject(async () => {
			await runTscCheckpoint("/nonexistent/tsconfig-path");
		});
	});

	it("calling resolved function with zero args throws (worktreePath is required)", async () => {
		const { runTscCheckpoint } = await import("../../tsc-checkpoint/index.ts");
		// Since the function uses resolve() on worktreePath, calling without args should throw
		await assert.rejects(async () => {
			// @ts-expect-error testing runtime behavior with missing required param
			await runTscCheckpoint();
		});
	});
});

// ===========================================================================
// Phase 8: LSP gate consumes runner-supplied retryCount (issue #1773)
// ===========================================================================
// retryCount sourcing is asserted behaviorally in
// lsp-auditor/test/lsp-auditor-run-pre-audit.test.mts (runPreAudit with
// active-branch retry entries → result.retryCount), so the former source
// guards were removed.

// ===========================================================================
// Phase 4: Path construction consistency (resolvePath not string concat)
// ===========================================================================

describe("pipeline/audit/lsp-gate.ts — resolvePath used in runLspPreAudit (Phase 4)", () => {
	it("resolvePath imported in lsp-gate.ts", () => {
		const src = readLspGateSource();
		const importSection = src.substring(0, src.indexOf("export async function"));
		assert.ok(importSection.includes("resolve"), "resolvePath imported in lsp-gate.ts");
	});

	it("resolvePath used where string concat was in runLspPreAudit", () => {
		const src = readLspGateSource();
		const fnIdx = src.indexOf("async function runLspPreAudit(");
		const nextFnIdx = src.indexOf("\nexport", fnIdx);
		const fnBody = nextFnIdx >= 0 ? src.substring(fnIdx, nextFnIdx) : src.substring(fnIdx);

		// Old string concat pattern should not exist in runLspPreAudit
		const oldConcat = fnBody.match(/\$\{config\.worktreeBase!\}\$\{branch\}/);
		assert.ok(!oldConcat, "runLspPreAudit should not use string concat from old pattern");

		// resolvePath should be used for cwd computation
		assert.ok(
			fnBody.includes("resolvePath"),
			"runLspPreAudit should use resolvePath for path operations",
		);
	});
});

// ===========================================================================
// Phase 6: Non-standard `worktreeBase` config compatibility
// ===========================================================================

describe("pipeline-audit.ts — non-standard worktreeBase config (Phase 6)", () => {
	it("path resolution uses resolvePath via createWorktree import", () => {
		const lspGateSrc = readLspGateSource();
		const preflightSrc = readFileSync(PREFLIGHT_TS, "utf-8");

		// handler/preflight.ts imports worktree utilities which use resolvePath internally
		const pipelinePathPattern = "createWorktree, installWorktreeDeps";
		const auditPathPattern = "resolvePath(";

		assert.ok(
			preflightSrc.includes(pipelinePathPattern),
			"pipeline/handler/preflight.ts imports worktree utilities from worktree.ts",
		);

		// Verify lsp-gate.ts uses resolvePath (path resolution moved there in #1407)
		assert.ok(lspGateSrc.includes(auditPathPattern), "lsp-gate.ts uses resolvePath");
	});
});

// ===========================================================================
// Phase 7: TSC checkpoint try/catch error boundary (Issue #788)
// ===========================================================================

describe("pipeline/audit/tsc-gate.ts — TSC checkpoint try/catch error boundary (Phase 7)", () => {
	it("runTscCheckpointFn call wrapped in try block", () => {
		const src = readTscGateSource();
		const callIdx = src.indexOf("runTscCheckpointFn(worktreePath)");
		assert.ok(callIdx >= 0, "runTscCheckpointFn(worktreePath) call exists");
		// try block should contain the call
		const beforeCall = src.substring(callIdx - 30, callIdx);
		assert.ok(beforeCall.includes("try {"), "call should be inside try block");
	});

	it("catch block calls ctx.ui.notify with warning level", () => {
		const src = readTscGateSource();
		const catchBlock = src.substring(
			src.indexOf("catch (tscErr: unknown)"),
			src.indexOf("catch (tscErr: unknown)") + 400,
		);
		assert.ok(
			catchBlock.includes("ctx.ui.notify(`TSC checkpoint threw:"),
			"catch block should call ctx.ui.notify with TSC checkpoint message",
		);
		assert.ok(
			catchBlock.includes(', "warning")'),
			"ctx.ui.notify should be called with warning level",
		);
	});

	it("catch block calls getDebugLogger().warn with pipeline-audit module", () => {
		const src = readTscGateSource();
		const catchBlock = src.substring(
			src.indexOf("catch (tscErr: unknown)"),
			src.indexOf("catch (tscErr: unknown)") + 400,
		);
		assert.ok(
			catchBlock.includes('getDebugLogger().warn("pipeline-audit"'),
			"catch block should call getDebugLogger().warn with pipeline-audit module",
		);
	});

	it("catch block calls collector?.push with pipeline-audit module and warn level", () => {
		const src = readTscGateSource();
		const catchBlock = src.substring(
			src.indexOf("catch (tscErr: unknown)"),
			src.indexOf("catch (tscErr: unknown)") + 500,
		);
		const pattern1 = 'collector?.push("pipeline-audit", "warn"';
		const pattern2 = 'collector.push("pipeline-audit", "warn"';
		assert.ok(
			catchBlock.includes(pattern1) || catchBlock.includes(pattern2),
			"catch block should call collector?.push with pipeline-audit module and warn level",
		);
	});

	it("determineAuditGate call is outside the catch block (no early return)", () => {
		const src = readTscGateSource();
		const catchIdx = src.indexOf("catch (tscErr: unknown)");
		assert.ok(catchIdx >= 0, "catch (tscErr: unknown) block exists");
		const decisionIdx = src.indexOf("const tscDecision = determineAuditGate({");
		assert.ok(decisionIdx >= 0, "determineAuditGate call exists");
		// Decision must come after catch block
		assert.ok(decisionIdx > catchIdx, "determineAuditGate should be after the catch block");
	});

	it("determineAuditGate and if/else are not wrapped inside try/catch", () => {
		const src = readTscGateSource();
		const decisionIdx = src.indexOf("const tscDecision = determineAuditGate({");
		assert.ok(decisionIdx >= 0, "determineAuditGate call exists");
		// Find the catch block closing brace before the decision line
		const beforeDecision = src.substring(0, decisionIdx);
		const lastCatchIdx = beforeDecision.lastIndexOf("catch (tscErr: unknown)");
		assert.ok(lastCatchIdx >= 0, "catch block found before decision call");
		// Text between catch block end and decision should not contain 'try {'
		const afterCatch = beforeDecision.substring(lastCatchIdx);
		// Find the catch block's closing '}'
		const catchCloseIdx = afterCatch.lastIndexOf("}");
		assert.ok(catchCloseIdx >= 0, "catch block has closing brace");
		const between = afterCatch.substring(catchCloseIdx, afterCatch.length);
		assert.ok(!between.includes("try {"), "determineAuditGate should not be inside a try block");
	});
});

// ===========================================================================
// Phase 5: State checkpoint integration (behavior — Issue #1866)
// ===========================================================================
// Checkpoints are observed through an injected writer spy, not by scanning
// orchestrator source: the spy records each write so the pre-tsc → pre-lsp
// order and the state shape come from real calls, and a failing writer drives
// the warning notification path.

// ── Module mocks: heavy gates + checkpoint writer (issue #1866) ──
// The orchestrator runs for real; only the shell-out gates and the checkpoint
// writer are replaced (--experimental-test-module-mocks). Without the flag the
// Phase 5 suite is skipped.
const hasMockModule = typeof mock.module === "function";

// Mutable holders read by the mocks at call time.
let checkpointWrites: Array<{ cwd: string; state: SupervisorCheckpointState }> = [];
let checkpointWriteResult: Result<void> = { ok: true, value: undefined };

if (hasMockModule) {
	mock.module("../pipeline/state-checkpoint.ts", {
		namedExports: {
			...stateCheckpoint,
			writeCheckpointFile: (cwd: string, state: SupervisorCheckpointState) => {
				checkpointWrites.push({ cwd, state });
				return checkpointWriteResult;
			},
		},
	});
	mock.module("../pipeline/audit/pre-gates.ts", {
		namedExports: {
			runCiGate: (async () => ({})) as unknown,
			runDuplicateGate: (async () => ({
				dupResult: { status: "no_jscpd", clones: [], totalDuplicateLines: 0, changedFilesScanned: [] },
			})) as unknown,
			runDeadCodeGate: (async () => ({
				deadResult: { status: "no_knip", findings: [], totalDeadLines: 0, changedFilesScanned: [] },
			})) as unknown,
			runPackageSafetyGate: (async () => ({})) as unknown,
			runOsvGate: (async () => ({
				vulnResult: {
					status: "no_osv_scanner",
					findings: [],
					counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				},
			})) as unknown,
			runTraceabilityGate: (async () => ({})) as unknown,
		},
	});
	mock.module("../pipeline/audit/tsc-gate.ts", {
		namedExports: { runTscGate: (async () => null) as unknown },
	});
	mock.module("../pipeline/audit/lsp-gate.ts", {
		namedExports: {
			runLspPreAudit: (async () => ({ nextStatus: "Audit", note: "lsp ok" })) as unknown,
		},
	});
}

function makeAuditConfig(): SupervisorConfig {
	return {
		ciGatingTimeoutSec: 0,
		defaultBranch: "main",
		branchPrefix: "worktree-",
		repo: "owner/repo",
	} as SupervisorConfig;
}

function makeAuditCtx(): { ctx: any; notify: ReturnType<typeof mock.fn> } {
	const notify = mock.fn();
	return {
		ctx: { cwd: "/repo", ui: { notify, setStatus: mock.fn() } },
		notify,
	};
}

if (hasMockModule) {
	describe("pipeline/audit/index.ts — state checkpoint integration (Phase 5)", () => {
		it("writes pre-tsc then pre-lsp checkpoints, each carrying issue/worktree state", async () => {
			checkpointWrites = [];
			checkpointWriteResult = { ok: true, value: undefined };
			const { ctx } = makeAuditCtx();
			const { runTscAndLspAudit } = await import("../pipeline/audit/index.ts");

			const result = await runTscAndLspAudit(
				42,
				"Checkpoint order",
				makeAuditConfig(),
				"developer",
				{ body: "", comments: [] },
				"/wt/issue-42",
				{} as any,
				ctx,
				undefined,
			);

			assert.equal(result.nextStatus, "Audit");
			assert.deepEqual(
				checkpointWrites.map((w) => w.state.checkpoint),
				["pre-tsc", "pre-lsp"],
				"checkpoint writes happen in gate order",
			);
			for (const { cwd, state } of checkpointWrites) {
				assert.equal(cwd, "/repo", "checkpoint is written under ctx.cwd");
				assert.equal(state.issueNum, 42);
				assert.equal(state.worktreePath, "/wt/issue-42");
				assert.ok(state.worktreeBranch.length > 0, "worktreeBranch is set");
				assert.ok(!Number.isNaN(Date.parse(state.startedAt)), "startedAt is an ISO date");
			}
		});

		it("notifies a warning for each failed checkpoint write", async () => {
			checkpointWrites = [];
			checkpointWriteResult = { ok: false, error: "disk full", source: "state-checkpoint" };
			const { ctx, notify } = makeAuditCtx();
			const { runTscAndLspAudit } = await import("../pipeline/audit/index.ts");

			await runTscAndLspAudit(
				7,
				"Checkpoint failure",
				makeAuditConfig(),
				"developer",
				{ body: "", comments: [] },
				"/wt/issue-7",
				{} as any,
				ctx,
				undefined,
			);

			const messages = notify.mock.calls.map((c: any) => c.arguments[0] as string);
			assert.ok(
				messages.some((m) => m.includes("pre-TSC") && m.includes("disk full")),
				`expected a pre-TSC failure warning, got: ${messages.join(" | ")}`,
			);
			assert.ok(
				messages.some((m) => m.includes("pre-LSP") && m.includes("disk full")),
				`expected a pre-LSP failure warning, got: ${messages.join(" | ")}`,
			);
			for (const call of notify.mock.calls) {
				assert.equal(call.arguments[1], "warning", "checkpoint failure notify uses warning level");
			}
		});
	});
}

