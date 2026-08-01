/**
 * stages-split.test.mts — barrel contract + size guards for the stages/ split
 * (Clean Code Audit #1394, issue #1397).
 *
 * Guards the behavior-preserving file split:
 *  - all public exports load from the stages/index.ts barrel
 *  - stages.ts is gone, replaced by the stages/ directory
 *  - explicit re-exports only (no `export *`)
 *  - per-module nbnc (non-blank/non-comment) line budget ≤ 500 (SonarQube S104)
 *  - handlePostAgentSuccess / handleAuditorOutput spans ≤ 100 (S138)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MAX_PIPELINE_LOOPS,
	createStageState,
	handleBacklogTransition,
	isDoneStatus,
	resolveAgentName,
	isRejectionLimitReached,
	calculateNextStatus,
	trackAuditScore,
	applyStatusTransition,
	buildAgentResultEntry,
	handlePostAgentSuccess,
	shouldSkipResearcher,
	inferForwardStatus,
	hasBranchCommits,
	gitCherryContains,
	buildDuplicateCodeContext,
	applyGateFailureContext,
	buildDeadCodeContext,
	buildVulnContext,
	validateResearcherFindings,
	buildApprovalCommentFromOutput,
	buildRejectionCommentFromOutput,
	type StageState,
	type AuditGateContext,
	type GateRejected,
} from "../../pipeline/stages/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STAGES_DIR = join(__dirname, "../../pipeline/stages");
const OLD_FILE = join(__dirname, "../../pipeline/stages.ts");

const RUNTIME_EXPORTS: Array<{ name: string; value: unknown }> = [
	{ name: "MAX_PIPELINE_LOOPS", value: MAX_PIPELINE_LOOPS },
	{ name: "createStageState", value: createStageState },
	{ name: "handleBacklogTransition", value: handleBacklogTransition },
	{ name: "isDoneStatus", value: isDoneStatus },
	{ name: "resolveAgentName", value: resolveAgentName },
	{ name: "isRejectionLimitReached", value: isRejectionLimitReached },
	{ name: "calculateNextStatus", value: calculateNextStatus },
	{ name: "trackAuditScore", value: trackAuditScore },
	{ name: "applyStatusTransition", value: applyStatusTransition },
	{ name: "buildAgentResultEntry", value: buildAgentResultEntry },
	{ name: "handlePostAgentSuccess", value: handlePostAgentSuccess },
	{ name: "shouldSkipResearcher", value: shouldSkipResearcher },
	{ name: "inferForwardStatus", value: inferForwardStatus },
	{ name: "hasBranchCommits", value: hasBranchCommits },
	{ name: "gitCherryContains", value: gitCherryContains },
	{ name: "buildDuplicateCodeContext", value: buildDuplicateCodeContext },
	{ name: "applyGateFailureContext", value: applyGateFailureContext },
	{ name: "buildDeadCodeContext", value: buildDeadCodeContext },
	{ name: "buildVulnContext", value: buildVulnContext },
	{ name: "validateResearcherFindings", value: validateResearcherFindings },
	{ name: "buildApprovalCommentFromOutput", value: buildApprovalCommentFromOutput },
	{ name: "buildRejectionCommentFromOutput", value: buildRejectionCommentFromOutput },
];

/** Non-blank/non-comment line count — mirrors the issue's awk-style measure. */
function nbnc(source: string): number {
	return source.split("\n").filter((line) => {
		const t = line.trim();
		if (t === "") return false;
		if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
		return true;
	}).length;
}

/** Line span (incl. doc comment) of a function by name, across all stages/*.ts sources. */
function functionSpan(source: string, fnName: string): number | null {
	const lines = source.split("\n");
	const startIdx = lines.findIndex((l) => new RegExp(`function\\s+${fnName}\\s*\\(`).test(l));
	if (startIdx === -1) return null;
	let depth = 0;
	for (let i = startIdx; i < lines.length; i++) {
		for (const ch of lines[i]!) {
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) return i - startIdx + 1;
			}
		}
	}
	return null;
}

function readAllStagesSource(): string {
	return readdirSync(STAGES_DIR)
		.filter((f) => f.endsWith(".ts"))
		.sort()
		.map((f) => readFileSync(join(STAGES_DIR, f), "utf-8"))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 1: Barrel contract
// ---------------------------------------------------------------------------

describe("stages/ split — barrel contract", () => {
	it("exports all 22 runtime symbols from stages/index.ts", () => {
		for (const { name, value } of RUNTIME_EXPORTS) {
			assert.ok(
				typeof value === "function" || typeof value === "number",
				`stages/index.ts export "${name}" is ${typeof value} (dropped export?)`,
			);
		}
	});

	it("re-exports the 3 public types (StageState, AuditGateContext, GateRejected)", () => {
		const state: StageState = createStageState("Backlog");
		const gateCtx: AuditGateContext = { researcherSkipped: false, scoreThreshold: 0.5 };
		const gateRejected: GateRejected = { score: { passing: 1, total: 1 }, required: 1, total: 1 };
		assert.equal(state.loopStatus, "Backlog");
		assert.equal(gateCtx.scoreThreshold, 0.5);
		assert.equal(gateRejected.total, 1);
	});

	it("MAX_PIPELINE_LOOPS identity preserved", () => {
		assert.equal(MAX_PIPELINE_LOOPS, 20);
	});

	it("pipeline/stages.ts no longer exists; stages/index.ts exists", () => {
		assert.ok(!existsSync(OLD_FILE), "pipeline/stages.ts should be deleted after the split");
		assert.ok(existsSync(join(STAGES_DIR, "index.ts")), "stages/index.ts exists");
	});

	it("index.ts uses explicit re-exports only (no export *)", () => {
		const src = readFileSync(join(STAGES_DIR, "index.ts"), "utf-8");
		assert.ok(!src.includes("export *"), "stages/index.ts must not use export *");
	});
});

// ---------------------------------------------------------------------------
// Phase 1: Size guards (S104 file budget, S138 function budget)
// ---------------------------------------------------------------------------

describe("stages/ split — size guards", () => {
	it("each stages/*.ts module stays ≤ 500 nbnc lines", () => {
		const files = readdirSync(STAGES_DIR).filter((f) => f.endsWith(".ts"));
		assert.ok(files.length >= 4, `stages/ contains split modules (found: ${files.length})`);
		for (const f of files) {
			const count = nbnc(readFileSync(join(STAGES_DIR, f), "utf-8"));
			assert.ok(
				count <= 500,
				`${f} has ${count} nbnc lines — over the S104 ceiling of 500`,
			);
		}
	});

	it("handlePostAgentSuccess span ≤ 100 lines", () => {
		const span = functionSpan(readAllStagesSource(), "handlePostAgentSuccess");
		assert.ok(span !== null, "handlePostAgentSuccess found in stages/");
		assert.ok(span <= 100, `handlePostAgentSuccess spans ${span} lines — over S138 ceiling of 100`);
	});

	it("handleAuditorOutput span ≤ 100 lines", () => {
		const span = functionSpan(readAllStagesSource(), "handleAuditorOutput");
		assert.ok(span !== null, "handleAuditorOutput found in stages/");
		assert.ok(span <= 100, `handleAuditorOutput spans ${span} lines — over S138 ceiling of 100`);
	});
});
