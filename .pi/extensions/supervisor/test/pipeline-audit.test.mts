/**
 * Tests for pipeline-audit.ts — worktreePath plumbing fix (Issue #284)
 *
 * Phase 1: `worktreePath` parameter plumbing in `pipeline-audit.ts`
 * Phase 2: `getRunGate` returns typed runner via dynamic import
 * Phase 3: `worktreePath` passed from `pipeline.ts` call site
 * Phase 4: Path construction consistency (resolvePath not string concat)
 * Phase 6: Non-standard `worktreeBase` config compatibility
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline-audit.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDIT_TS = resolve(__dirname, "../pipeline/audit.ts");
const PIPELINE_TS = resolve(__dirname, "../pipeline/handler.ts");
const AUDIT_GATE_DECISION_TS = resolve(__dirname, "../checks/audit-gate-decision.ts");
const TSC_CHECKPOINT_INDEX_TS = resolve(__dirname, "../../tsc-checkpoint/index.ts");

function readAuditSource(): string {
	return readFileSync(AUDIT_TS, "utf-8");
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
		const fnEnd = src.indexOf("): Promise<{ nextStatus: string; note: string }>", fnIdx);
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
		const src = readAuditSource();
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
		const src = readAuditSource();
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
		const src = readAuditSource();
		// Find the pi.exec("git diff") call
		const execIdx = src.indexOf('pi.exec("git"');
		assert.ok(execIdx >= 0, "pi.exec git diff call exists");
		const execSection = src.substring(execIdx, execIdx + 150);
		// cwd should reference worktreePath or resolvePath with worktreePath
		assert.ok(execSection.includes("worktreePath"), "pi.exec cwd should reference worktreePath");
	});

	it("runLspPreAudit no longer recomputes path via generateBranchName", () => {
		const src = readAuditSource();
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

	it("getRunGate exists in audit-gate-decision.ts with PolicyName param", () => {
		const src = readFileSync(AUDIT_GATE_DECISION_TS, "utf-8");
		const getRunIdx = src.indexOf("export async function getRunGate");
		assert.ok(getRunIdx >= 0, "getRunGate function exists in audit-gate-decision.ts");
		// Verify the signature shows PolicyName generic
		assert.ok(
			src.includes("getRunGate<K extends PolicyName>"),
			"getRunGate should be generic over PolicyName",
		);
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
// Phase 3: `worktreePath` passed from `pipeline.ts` call site
// ===========================================================================

describe("pipeline.ts — worktreePath passed to runTscAndLspAudit (Phase 3)", () => {
	it("runTscAndLspAudit call includes worktreePath as 8th arg", () => {
		const src = readPipelineSource();
		// Find the runTscAndLspAudit call
		const callIdx = src.indexOf("const auditResult = await runTscAndLspAudit(");
		assert.ok(callIdx >= 0, "runTscAndLspAudit call exists");
		// Find the closing paren
		const callSection = src.substring(callIdx, src.indexOf(");", callIdx));
		// Should contain worktreePath, as an argument
		assert.ok(
			callSection.includes("worktreePath"),
			"worktreePath should be present in runTscAndLspAudit call args",
		);
		// Count args — should be 8 now (was 7 before fix)
		// Count commas at top level (not nested)
		const argCount = (callSection.match(/,/g) || []).length;
		assert.ok(argCount >= 7, "runTscAndLspAudit should have at least 8 args (7 commas)");
	});

	it("worktreePath in scope at pre-transition hooks site (declared before hooks block)", () => {
		const src = readPipelineSource();
		// Verify worktreePath declared at handler scope
		const declIdx = src.indexOf("let worktreePath: string | undefined;");
		assert.ok(declIdx >= 0, "worktreePath declared at handler scope");

		// Verify declaration comes before pre-transition hooks block
		const hooksIdx = src.indexOf("// Pre-transition hooks");
		assert.ok(declIdx < hooksIdx, "worktreePath declared before hooks block");
	});
});

// ===========================================================================
// Phase 4: Path construction consistency (resolvePath not string concat)
// ===========================================================================

describe("pipeline-audit.ts — resolvePath used in runLspPreAudit (Phase 4)", () => {
	it("resolvePath imported in pipeline-audit.ts", () => {
		const src = readAuditSource();
		const importSection = src.substring(0, src.indexOf("export async function"));
		assert.ok(importSection.includes("resolve"), "resolvePath imported in pipeline-audit.ts");
	});

	it("resolvePath used where string concat was in runLspPreAudit", () => {
		const src = readAuditSource();
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
	it("no string concat pattern `${config.worktreeBase!}${branch}` in pipeline-audit.ts", () => {
		const src = readAuditSource();
		const oldPattern = "`${config.worktreeBase!}${branch}`";
		assert.ok(
			!src.includes(oldPattern),
			"Old string-concat pattern should not exist in pipeline-audit.ts",
		);
	});

	it("path resolution uses resolvePath via createWorktree import", () => {
		const auditSrc = readAuditSource();
		const pipelineSrc = readPipelineSource();

		// handler.ts imports worktree utilities which use resolvePath internally
		const pipelinePathPattern = "createWorktree, installWorktreeDeps, cleanupWorktree";
		const auditPathPattern = "resolvePath(";

		assert.ok(
			pipelineSrc.includes(pipelinePathPattern),
			"pipeline/handler.ts imports worktree utilities from worktree.ts",
		);

		// Verify pipeline-audit.ts uses resolvePath with worktreeBase
		assert.ok(auditSrc.includes(auditPathPattern), "pipeline-audit.ts uses resolvePath");
	});
});

// ===========================================================================
// Phase 7: TSC checkpoint try/catch error boundary (Issue #788)
// ===========================================================================

describe("pipeline-audit.ts — TSC checkpoint try/catch error boundary (Phase 7)", () => {
	it("tscResult declared with let outside try block (visible after catch)", () => {
		const src = readAuditSource();
		// Verify let-declared tscResult before try block, not const inside it
		const letDecl = "let tscResult: TscCheckpointResult | null = null;";
		assert.ok(src.includes(letDecl), "tscResult should be declared with let outside try block");
		// Verify it appears before the try block in Step 5
		const step5Idx = src.indexOf("// Step 5: TSC checkpoint (Tier 2)");
		const tryIdx = src.indexOf("try {", step5Idx);
		const declIdx = src.indexOf(letDecl, step5Idx);
		assert.ok(
			declIdx > step5Idx && declIdx < tryIdx,
			"let tscResult should appear between Step 5 comment and try block",
		);
	});

	it("runTscCheckpointFn call wrapped in try block", () => {
		const src = readAuditSource();
		const callIdx = src.indexOf("runTscCheckpointFn(worktreePath)");
		assert.ok(callIdx >= 0, "runTscCheckpointFn(worktreePath) call exists");
		// try block should contain the call
		const beforeCall = src.substring(callIdx - 30, callIdx);
		assert.ok(beforeCall.includes("try {"), "call should be inside try block");
	});

	it("catch block calls ctx.ui.notify with warning level", () => {
		const src = readAuditSource();
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
		const src = readAuditSource();
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
		const src = readAuditSource();
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
		const src = readAuditSource();
		const catchIdx = src.indexOf("catch (tscErr: unknown)");
		assert.ok(catchIdx >= 0, "catch (tscErr: unknown) block exists");
		const decisionIdx = src.indexOf("const tscDecision = determineAuditGate({");
		assert.ok(decisionIdx >= 0, "determineAuditGate call exists");
		// Decision must come after catch block
		assert.ok(decisionIdx > catchIdx, "determineAuditGate should be after the catch block");
	});

	it("determineAuditGate and if/else are not wrapped inside try/catch", () => {
		const src = readAuditSource();
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
// Phase 5: State checkpoint integration (pipeline state checkpoint for crash recovery)
// ===========================================================================

describe("pipeline-audit.ts — state checkpoint integration (Phase 5)", () => {
	it("imports writeCheckpointFile from state-checkpoint", () => {
		const src = readAuditSource();
		const importSection = src.substring(0, src.indexOf("export async function"));
		assert.ok(
			importSection.includes('import { writeCheckpointFile } from "./state-checkpoint.ts"'),
			"should import writeCheckpointFile from state-checkpoint",
		);
	});

	it("calls writeCheckpointFile with checkpoint 'pre-tsc' before getRunGate('tsc')", () => {
		const src = readAuditSource();
		// Find the pre-tsc checkpoint write block
		const preTscIdx = src.indexOf('checkpoint: "pre-tsc"');
		assert.ok(preTscIdx >= 0, "should have pre-tsc checkpoint write");

		// The pre-tsc checkpoint should appear before getRunGate("tsc") call
		const getRunGateIdx = src.indexOf('await getRunGate("tsc")');
		assert.ok(getRunGateIdx >= 0, 'should have getRunGate("tsc") call');

		// Extract section from pre-tsc checkpoint to getRunGate
		const section = src.substring(preTscIdx, getRunGateIdx);
		// The checkpoint write block should be followed by getRunGate
		assert.ok(section.includes('checkpoint: "pre-tsc"'), "pre-tsc checkpoint block exists");
		// Verify ordering: pre-tsc checkpoint comes BEFORE getRunGate("tsc")
		assert.ok(
			preTscIdx < getRunGateIdx,
			'pre-tsc checkpoint should be written before getRunGate("tsc") is called',
		);
	});

	it("calls writeCheckpointFile with checkpoint 'pre-lsp' before runLspPreAudit()", () => {
		const src = readAuditSource();
		const preLspIdx = src.indexOf('checkpoint: "pre-lsp"');
		assert.ok(preLspIdx >= 0, "should have pre-lsp checkpoint write");

		const runLspIdx = src.indexOf("await runLspPreAudit(issueNum");
		assert.ok(runLspIdx >= 0, "should have runLspPreAudit() call");

		assert.ok(
			preLspIdx < runLspIdx,
			"pre-lsp checkpoint should be written before runLspPreAudit() is called",
		);
	});

	it("writeCheckpointFile('pre-tsc') passes correct state shape", () => {
		const src = readAuditSource();
		const preTscIdx = src.indexOf('checkpoint: "pre-tsc"');
		assert.ok(preTscIdx >= 0, "should have pre-tsc checkpoint");

		// Find the writeCheckpointFile call containing pre-tsc
		const callStart = src.lastIndexOf("writeCheckpointFile(ctx.cwd,", preTscIdx);
		assert.ok(callStart >= 0, "writeCheckpointFile call exists for pre-tsc");

		// Find closing ");" after the checkpoint
		const closingParen = src.indexOf(");", preTscIdx);
		assert.ok(closingParen >= 0, "should find closing paren for pre-tsc call");

		const callSection = src.substring(callStart, closingParen + 2);

		// Verify all required fields are present in the call block
		assert.ok(callSection.includes("issueNum"), "should pass issueNum");
		assert.ok(callSection.includes("checkpoint"), "should pass checkpoint");
		assert.ok(callSection.includes("worktreePath"), "should pass worktreePath");
		assert.ok(callSection.includes("worktreeBranch"), "should pass worktreeBranch");
		assert.ok(callSection.includes("startedAt"), "should pass startedAt");
		assert.ok(
			callSection.includes("new Date().toISOString()"),
			"should use new Date().toISOString() for startedAt",
		);
		assert.ok(callSection.includes("ctx.cwd"), "should use ctx.cwd as first arg");
	});

	it("writeCheckpointFile('pre-lsp') passes correct state shape", () => {
		const src = readAuditSource();
		const preLspIdx = src.indexOf('checkpoint: "pre-lsp"');
		assert.ok(preLspIdx >= 0, "should have pre-lsp checkpoint");

		const callStart = src.lastIndexOf("writeCheckpointFile(ctx.cwd,", preLspIdx);
		assert.ok(callStart >= 0, "writeCheckpointFile call exists for pre-lsp");

		const closingParen = src.indexOf(");", preLspIdx);
		assert.ok(closingParen >= 0, "should find closing paren for pre-lsp call");

		const callSection = src.substring(callStart, closingParen + 2);

		assert.ok(callSection.includes("issueNum"), "should pass issueNum");
		assert.ok(callSection.includes("checkpoint"), "should pass checkpoint");
		assert.ok(callSection.includes("worktreePath"), "should pass worktreePath");
		assert.ok(callSection.includes("worktreeBranch"), "should pass worktreeBranch");
		assert.ok(callSection.includes("startedAt"), "should pass startedAt");
		assert.ok(callSection.includes("ctx.cwd"), "should use ctx.cwd as first arg");
	});

	it("writeCheckpointFile calls use ctx.cwd consistently", () => {
		const src = readAuditSource();
		const matches = src.match(/writeCheckpointFile\(ctx\.cwd,/g);
		assert.equal(
			matches?.length ?? 0,
			2,
			"should have exactly 2 writeCheckpointFile calls with ctx.cwd",
		);
	});
	it("no old resolvePath(worktreePath, '..') pattern remains", () => {
		const src = readAuditSource();
		// Should not reference worktreePath for cwd in checkpoint writes
		// (the old pattern used resolvePath(worktreePath, "..") )
		const oldPattern = 'resolvePath(worktreePath, "..")';
		assert.ok(
			!src.includes(oldPattern),
			"should not use resolvePath(worktreePath, '..') for checkpoint writes",
		);
	});
});
