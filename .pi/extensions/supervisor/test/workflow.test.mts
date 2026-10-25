/**
 * Tests for workflow.ts — config-driven pipeline transitions
 *
 * Pure function tests for resolveNextStatus().
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/workflow.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	resolveNextStatus,
	resolveNextStatusFromAgentOutput,
	type WorkflowStep,
} from "../config/workflow.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("resolveNextStatus", () => {
	it("returns null when step has no markerMap", () => {
		const step: WorkflowStep = { status: "Backlog", builtIn: "backlog" };
		const result = resolveNextStatus(step, "anything");
		assert.strictEqual(result, null);
	});

	it("returns matching status when marker found (Architecture → TestDesign)", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "some output ARCHITECTURE_COMPLETE more text");
		assert.strictEqual(result, "TestDesign");
	});

	it("returns null when no marker matches", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "some random output with no marker");
		assert.strictEqual(result, null);
	});

	it("last occurring marker wins when multiple exist (Architecture feedback loop)", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: {
				ARCHITECTURE_COMPLETE: "TestDesign",
				FEEDBACK_RESEARCH: "Research",
			},
		};
		const result = resolveNextStatus(step, "ARCHITECTURE_COMPLETE\nsome design\nFEEDBACK_RESEARCH");
		// FEEDBACK_RESEARCH appears last → Research
		assert.strictEqual(result, "Research");
	});

	it("RESEARCH_COMPLETE alone (no feedback) → Architecture", () => {
		const step: WorkflowStep = {
			status: "Research",
			agentName: "researcher",
			markerMap: {
				RESEARCH_COMPLETE: "Architecture",
			},
		};
		const result = resolveNextStatus(step, "RESEARCH_COMPLETE no feedback needed");
		assert.strictEqual(result, "Architecture");
	});

	it("auditor reject appears after approve → Implementation", () => {
		const step: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: {
				AUDIT_APPROVED: "Done",
				AUDIT_REJECTED: "Implementation",
			},
		};
		const result = resolveNextStatus(
			step,
			"AUDIT_APPROVED\nsome checks\nAUDIT_REJECTED\nmissing test coverage",
		);
		assert.strictEqual(result, "Implementation");
	});

	it("auditor approve appears after reject → Done", () => {
		const step: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: {
				AUDIT_APPROVED: "Done",
				AUDIT_REJECTED: "Implementation",
			},
		};
		const result = resolveNextStatus(step, "AUDIT_REJECTED\nfix applied\nAUDIT_APPROVED\nall good");
		assert.strictEqual(result, "Done");
	});

	it("case sensitivity — lowercase marker does not match", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "architecture_complete");
		assert.strictEqual(result, null);
	});

	it("markerMap with single entry works", () => {
		const step: WorkflowStep = {
			status: "TestDesign",
			agentName: "test-designer",
			markerMap: { TEST_PLAN_COMPLETE: "Implementation" },
		};
		const result = resolveNextStatus(step, "some output TEST_PLAN_COMPLETE");
		assert.strictEqual(result, "Implementation");
	});

	it("empty output string returns null", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "");
		assert.strictEqual(result, null);
	});

	it("empty markerMap returns null", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: {},
		};
		const result = resolveNextStatus(step, "anything");
		assert.strictEqual(result, null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// resolveNextStatusFromAgentOutput() — structured JSON routing
// ═══════════════════════════════════════════════════════════════════════

describe("resolveNextStatusFromAgentOutput", () => {
	const architectStep: WorkflowStep = {
		status: "Architecture",
		agentName: "architect",
		markerMap: {
			ARCHITECTURE_COMPLETE: "TestDesign",
			FEEDBACK_RESEARCH: "Research",
		},
	};

	const auditorStep: WorkflowStep = {
		status: "Audit",
		agentName: "auditor",
		markerMap: {
			AUDIT_APPROVED: "Done",
			AUDIT_REJECTED: "Implementation",
		},
	};

	const developerStep: WorkflowStep = {
		status: "Implementation",
		agentName: "developer",
		markerMap: {
			IMPLEMENTATION_COMPLETE: "Audit",
		},
	};

	it("targetStatus Research with architect step → Research (bypasses FEEDBACK filter)", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			summary: "Need more research",
			targetStatus: "Research",
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, "Research");
	});

	it("targetStatus empty string → falls through to markerMap (backward compat)", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			summary: "Architecture done",
			targetStatus: "",
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, "TestDesign");
	});

	it("targetStatus whitespace only → falls through to markerMap (backward compat)", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			targetStatus: "   ",
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, "TestDesign");
	});

	it("targetStatus Research + action COMPLETE → Research (targetStatus wins over COMPLETE filter)", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			summary: "Need more research",
			targetStatus: "Research",
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, "Research");
	});

	it("auditor with targetStatus Implementation + action APPROVED → Implementation", () => {
		const json = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			targetStatus: "Implementation",
		});
		const result = resolveNextStatusFromAgentOutput(auditorStep, json);
		assert.strictEqual(result, "Implementation");
	});

	it("developer targetStatus Done is rejected; action COMPLETE follows markerMap", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			summary: "Done early",
			targetStatus: "Done",
		});
		const result = resolveNextStatusFromAgentOutput(developerStep, json);
		assert.strictEqual(result, "Audit");
	});

	it("no targetStatus → uses markerMap (unchanged default)", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			summary: "Architecture done",
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, "TestDesign");
	});

	it("step with no markerMap → returns null even with targetStatus in output", () => {
		const noMapStep: WorkflowStep = {
			status: "Backlog",
		};
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "backlog",
			targetStatus: "Research",
		});
		const result = resolveNextStatusFromAgentOutput(noMapStep, json);
		assert.strictEqual(result, null);
	});

	it("targetStatus with value false (boolean) → validation fails, falls through to null", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			targetStatus: false,
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, null);
	});

	it("targetStatus with value 42 (number) → validation fails, falls through to null", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			targetStatus: 42,
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, null);
	});

	it("refusal output never maps to a forward status", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			refusal: "cannot design this",
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, json);
		assert.strictEqual(result, null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// auditMarker precedence — AUDIT_DECISION long form wins over short form
// ═══════════════════════════════════════════════════════════════════════

describe("auditMarker precedence — long form wins over short form", () => {
	const bothMarkers: WorkflowStep = {
		status: "Audit",
		agentName: "auditor",
		markerMap: {
			"AUDIT_DECISION: APPROVED": "Done",
			"AUDIT_DECISION: REJECTED": "Implementation",
			AUDIT_APPROVED: "ShortApprove",
			AUDIT_REJECTED: "ShortReject",
		},
	};
	const shortOnly: WorkflowStep = {
		status: "Audit",
		agentName: "auditor",
		markerMap: { AUDIT_APPROVED: "ShortApprove", AUDIT_REJECTED: "ShortReject" },
	};
	const output = (obj: Record<string, unknown>) => JSON.stringify({ agentName: "auditor", ...obj });
	const finding = (severity: string) => ({
		severity,
		dimension: "code-quality",
		symptom: "s",
		consequence: "c",
		remedy: "r",
	});

	// Phase 1: lock the precedence rule (divergent values make the winner observable).
	it("action APPROVED → long key wins over divergent short key", () => {
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(bothMarkers, output({ action: "APPROVED" })),
			"Done",
		);
	});
	it("action REJECTED → long key wins over divergent short key", () => {
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(bothMarkers, output({ action: "REJECTED" })),
			"Implementation",
		);
	});
	it("only long key present → its value", () => {
		const longOnly: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: { "AUDIT_DECISION: APPROVED": "Done" },
		};
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(longOnly, output({ action: "APPROVED" })),
			"Done",
		);
	});
	it("only short key present → its value", () => {
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(shortOnly, output({ action: "APPROVED" })),
			"ShortApprove",
		);
	});
	it("both keys map to the same status → that status", () => {
		const same: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: { "AUDIT_DECISION: APPROVED": "Done", AUDIT_APPROVED: "Done" },
		};
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(same, output({ action: "APPROVED" })),
			"Done",
		);
	});
	it("empty long key + short key present → falls through to short (locks ||, not ??)", () => {
		const emptyLong: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: { "AUDIT_DECISION: APPROVED": "", AUDIT_APPROVED: "Done" },
		};
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(emptyLong, output({ action: "APPROVED" })),
			"Done",
		);
	});
	it("empty long REJECTED key + short key present → falls through to short", () => {
		const emptyLongReject: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: { "AUDIT_DECISION: REJECTED": "", AUDIT_REJECTED: "Implementation" },
		};
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(emptyLongReject, output({ action: "REJECTED" })),
			"Implementation",
		);
	});
	it("empty long key, no short key, matching action → null (falls through all branches)", () => {
		const emptyNoShort: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: { "AUDIT_DECISION: APPROVED": "" },
		};
		assert.strictEqual(
			resolveNextStatusFromAgentOutput(emptyNoShort, output({ action: "APPROVED" })),
			null,
		);
	});

	// Phase 2: branch-parity net — every one of the nine collapsed decision sites.
	const approvalTriggers: Array<[string, string]> = [
		["action APPROVED", output({ action: "APPROVED" })],
		["COMPLETE + empty findings", output({ action: "COMPLETE", findings: [] })],
		[
			"COMPLETE + suggestion finding",
			output({ action: "COMPLETE", findings: [finding("suggestion")] }),
		],
		[
			"COMPLETE + approved commentBody",
			output({ action: "COMPLETE", commentBody: "## Audit Approved\nok" }),
		],
		["raw approved heading", "## Audit Approved"],
		["bare COMPLETE", output({ action: "COMPLETE" })],
	];
	for (const [name, text] of approvalTriggers) {
		it(`approval site — ${name} → long Done / short ShortApprove`, () => {
			assert.strictEqual(resolveNextStatusFromAgentOutput(bothMarkers, text), "Done", name);
			assert.strictEqual(resolveNextStatusFromAgentOutput(shortOnly, text), "ShortApprove", name);
		});
	}

	const rejectionTriggers: Array<[string, string]> = [
		["action REJECTED", output({ action: "REJECTED" })],
		[
			"COMPLETE + critical finding",
			output({ action: "COMPLETE", findings: [finding("critical")] }),
		],
		["COMPLETE + warning finding", output({ action: "COMPLETE", findings: [finding("warning")] })],
		[
			"COMPLETE + rejected commentBody",
			output({ action: "COMPLETE", commentBody: "## Audit Rejected\nbad" }),
		],
		["raw rejected heading", "## Audit Rejected"],
	];
	for (const [name, text] of rejectionTriggers) {
		it(`rejection site — ${name} → long Implementation / short ShortReject`, () => {
			assert.strictEqual(
				resolveNextStatusFromAgentOutput(bothMarkers, text),
				"Implementation",
				name,
			);
			assert.strictEqual(resolveNextStatusFromAgentOutput(shortOnly, text), "ShortReject", name);
		});
	}
});
