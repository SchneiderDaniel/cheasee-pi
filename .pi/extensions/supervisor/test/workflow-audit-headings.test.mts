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
import { resolveNextStatusFromAgentOutput, type WorkflowStep } from "../config/workflow.ts";

// Split from workflow.test.mts (issue #2035 Long File refactor).
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
