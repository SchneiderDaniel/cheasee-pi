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

	it("developer with targetStatus Done + action COMPLETE → Done", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			summary: "Done early",
			targetStatus: "Done",
		});
		const result = resolveNextStatusFromAgentOutput(developerStep, json);
		assert.strictEqual(result, "Done");
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
// Heading fallbacks — anchored verdict detection (issue #1668)
// ═══════════════════════════════════════════════════════════════════════

describe("resolveNextStatusFromAgentOutput — audit heading fallbacks (issue #1668)", () => {
	const auditorStep: WorkflowStep = {
		status: "Audit",
		agentName: "auditor",
		markerMap: {
			AUDIT_APPROVED: "Done",
			AUDIT_REJECTED: "Implementation",
		},
	};

	it("structured commentBody '## Audit Rejected' + bare COMPLETE → REJECTED (existing behavior)", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "auditor",
			commentBody: "## Audit Rejected\nBad code",
		});
		const result = resolveNextStatusFromAgentOutput(auditorStep, json);
		assert.strictEqual(result, "Implementation");
	});

	it("structured commentBody '## Audit Approved' + bare COMPLETE → APPROVED", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "auditor",
			commentBody: "## Audit Approved\nAll good",
		});
		const result = resolveNextStatusFromAgentOutput(auditorStep, json);
		assert.strictEqual(result, "Done");
	});

	it("structured commentBody quoting the heading only → NOT REJECTED, bare-COMPLETE APPROVED default", () => {
		const json = JSON.stringify({
			action: "COMPLETE",
			agentName: "auditor",
			commentBody: 'no "## Audit Rejected"/"## Audit Approved" verdict comment',
		});
		const result = resolveNextStatusFromAgentOutput(auditorStep, json);
		assert.strictEqual(result, "Done");
	});

	it("raw text with a later '## Audit Approved' line than '## Audit Rejected' → approval wins", () => {
		const raw =
			"## Audit Rejected\nFirst pass had issues\n\n## Audit Approved\nAll fixed in resubmission";
		const result = resolveNextStatusFromAgentOutput(auditorStep, raw);
		assert.strictEqual(result, "Done");
	});

	it("raw text with a later '## Audit Rejected' line than '## Audit Approved' → rejection wins", () => {
		const raw = "## Audit Approved\nFirst pass fine\n\n## Audit Rejected\nTest gaps found";
		const result = resolveNextStatusFromAgentOutput(auditorStep, raw);
		assert.strictEqual(result, "Implementation");
	});

	it("raw mid-line occurrence 'reason: ## Audit Rejected' → classified REJECTED (aligned grammar, bug #1698)", () => {
		const raw = "reason: ## Audit Rejected because the heading is quoted inline";
		// Aligned with the comment poster (extractStructuredAuditMarkers uses
		// pan-text lastIndexOf): a rejection heading is a rejection even when it
		// sits mid-line. The status parser must never disagree with the comment
		// poster — a posted "## Audit Rejected" must ALWAYS loop back to
		// Implementation, never fall through to the Done default (bug #1698:
		// unparseable REJECTED audit → PR created + issue closed).
		const result = resolveNextStatusFromAgentOutput(auditorStep, raw);
		assert.strictEqual(result, "Implementation");
	});

	it("unparseable REJECTED JSON (schema-failing findings, escaped-\\n commentBody) → Implementation, not Done (regression #1698)", () => {
		// Live-incident shape (issue #1698): the auditor emitted REJECTED JSON
		// whose commentBody used literal \n (one-line value, heading mid-line)
		// and whose findings failed schema validation (severity not in the
		// enum). Structured parse fails → line-anchored scan alone misses the
		// heading → the pan-text pass (same grammar as the comment poster,
		// which DID post "## Audit Rejected") must classify REJECTED.
		const raw = [
			`{`,
			`  "agentName": "auditor",`,
			`  "action": "REJECTED",`,
			`  "commentBody": "## Audit Rejected\\n\\n### Findings\\n\\n1. **Correctness & Safety — about.go:54-55**\\n   - Symptom: write errors ignored\\n   - Consequence: partial output reports success\\n   - Remedy: return wrapped error\\n\\n### Audit Score\\nAUDIT_SCORE: 7/10",`,
			`  "summary": "Rejected - issues found",`,
			`  "findings": [{ "severity": "error", "dimension": "code-quality", "symptom": "x", "consequence": "y", "remedy": "z", "location": "about.go" }]`,
			`}`,
		].join("\n");
		const result = resolveNextStatusFromAgentOutput(auditorStep, raw);
		assert.strictEqual(result, "Implementation");
	});
});
