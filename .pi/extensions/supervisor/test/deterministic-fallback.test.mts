// ─── Tests: extractStructuredAuditOutput with structured JSON input ──
// Replaces old buildAuditCommentFallback tests which was removed.
// Now tests the primary JSON path of extractStructuredAuditOutput.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractStructuredAuditOutput } from "../github/comment.ts";

// ─── Helpers ──────────────────────────────────────────────────────

/** Wrap AgentOutput JSON in text so parseAgentOutput extracts it.
 *  Agents output code-fenced JSON; this simulates that format. */
function wrapJson(obj: Record<string, unknown>): string {
	return "Some preceding text\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\nTrailing text";
}

// ─── REJECTED with findings ──────────────────────────────────────

const REJECT_JSON_WITH_FINDINGS = {
	action: "REJECTED",
	agentName: "auditor",
	commentBody: [
		"## Audit Rejected",
		"",
		"### 🔴 Critical — Architecture Compliance: Dependency direction wrong",
		"- **Symptom:** Domain layer imports from adapter layer",
		"- **Consequence:** Breaks dependency rule",
		"- **Remedy:** Invert dependency, introduce port interface",
		"- **Location:** `src/domain/service.ts:42`",
		"",
		"### 🟡 Warning — Test Quality: Missing edge case tests",
		"- **Symptom:** No test for empty input",
		"- **Consequence:** Empty input causes runtime error",
		"- **Remedy:** Add test case for empty input",
		"- **Location:** `src/adapter/controller.test.ts:15`",
		"",
		"Fix and resubmit.",
	].join("\n"),
	auditScore: { passing: 0, total: 6 },
	findings: [
		{
			severity: "critical",
			dimension: "architecture-compliance",
			symptom: "Domain layer imports from adapter layer",
			consequence: "Breaks dependency rule",
			remedy: "Invert dependency, introduce port interface",
			location: "src/domain/service.ts:42",
		},
		{
			severity: "warning",
			dimension: "test-quality",
			symptom: "No test for empty input",
			consequence: "Empty input causes runtime error",
			remedy: "Add test case for empty input",
			location: "src/adapter/controller.test.ts:15",
		},
	],
};

const REJECT_JSON_NO_FINDINGS = {
	action: "REJECTED",
	agentName: "auditor",
	commentBody: "## Audit Rejected\nNo structured findings available.",
};

const APPROVE_JSON = {
	action: "APPROVED",
	agentName: "auditor",
	commentBody: [
		"## Audit Approved",
		"",
		"Score: 6/6",
		"",
		"### Summary",
		"Implementation follows architecture correctly.",
		"",
		"- Architecture compliance: ✅",
		"- Ticket fulfillment: ✅",
		"- Tests passed: ✅",
		"- Test quality: ✅",
		"- Correctness & Safety: ✅",
		"- Code quality: ✅",
		"- Completeness: ✅",
	].join("\n"),
	auditScore: { passing: 6, total: 6 },
};

// ─── Tests ────────────────────────────────────────────────────────

describe("extractStructuredAuditOutput — REJECTED with structured findings", () => {
	const input = wrapJson(REJECT_JSON_WITH_FINDINGS);
	const result = extractStructuredAuditOutput(input);

	it("returns non-null", () => {
		assert.ok(result !== null, "Should produce audit output");
	});

	it("decision is REJECTED", () => {
		assert.equal(result!.decision, "REJECTED");
	});

	it("commentBody starts with ## Audit Rejected", () => {
		assert.ok(result!.commentBody!.startsWith("## Audit Rejected"), "Should start with header");
	});

	it("commentBody contains 🔴 Critical finding", () => {
		assert.ok(result!.commentBody!.includes("🔴 Critical"), "Should include critical finding");
		assert.ok(
			result!.commentBody!.includes("Dependency direction wrong"),
			"Should include finding title",
		);
	});

	it("commentBody contains 🟡 Warning finding", () => {
		assert.ok(result!.commentBody!.includes("🟡 Warning"), "Should include warning");
	});

	it("commentBody contains Symptom/Consequence/Remedy/Location for critical", () => {
		assert.ok(result!.commentBody!.includes("Symptom:"), "Should include Symptom");
		assert.ok(result!.commentBody!.includes("Consequence:"), "Should include Consequence");
		assert.ok(result!.commentBody!.includes("Remedy:"), "Should include Remedy");
		assert.ok(result!.commentBody!.includes("Location:"), "Should include Location");
	});

	it("commentBody ends with Fix and resubmit", () => {
		assert.ok(
			result!.commentBody!.trim().endsWith("Fix and resubmit."),
			"Should end with fix message",
		);
	});
});

describe("extractStructuredAuditOutput — REJECTED without structured findings", () => {
	const input = wrapJson(REJECT_JSON_NO_FINDINGS);
	const result = extractStructuredAuditOutput(input);

	it("returns non-null", () => {
		assert.ok(result !== null, "Should produce audit output");
	});

	it("decision is REJECTED", () => {
		assert.equal(result!.decision, "REJECTED");
	});

	it("commentBody contains fallback text", () => {
		assert.ok(
			result!.commentBody!.includes("No structured findings"),
			"Should include fallback message",
		);
	});
});

describe("extractStructuredAuditOutput — APPROVED", () => {
	const input = wrapJson(APPROVE_JSON);
	const result = extractStructuredAuditOutput(input);

	it("returns non-null", () => {
		assert.ok(result !== null, "Should produce audit output");
	});

	it("decision is APPROVED", () => {
		assert.equal(result!.decision, "APPROVED");
	});

	it("commentBody starts with ## Audit Approved", () => {
		assert.ok(result!.commentBody!.startsWith("## Audit Approved"), "Should start with header");
	});

	it("commentBody contains score", () => {
		assert.ok(result!.commentBody!.includes("Score:"), "Should include score");
		assert.ok(result!.commentBody!.includes("6/6"), "Should include score value");
	});

	it("commentBody contains checklist items with status", () => {
		assert.ok(
			result!.commentBody!.includes("Architecture compliance: ✅"),
			"Should include checklist item",
		);
		assert.ok(
			result!.commentBody!.includes("Ticket fulfillment: ✅"),
			"Should include checklist item",
		);
	});

	it("commentBody contains Summary section", () => {
		assert.ok(result!.commentBody!.includes("### Summary"), "Should include summary section");
		assert.ok(
			result!.commentBody!.includes("Implementation follows architecture"),
			"Should include summary text",
		);
	});
});

describe("extractStructuredAuditOutput — edge cases", () => {
	it("returns null for empty string", () => {
		assert.equal(extractStructuredAuditOutput(""), null);
	});

	it("returns null for whitespace-only", () => {
		assert.equal(extractStructuredAuditOutput("   \n  \n"), null);
	});

	it("handles non-printable chars in JSON commentBody", () => {
		const input = wrapJson({
			action: "REJECTED",
			agentName: "auditor",
			commentBody: "**🔴 Critical — X: Y**\n- Symptom: z\n",
		});
		const result = extractStructuredAuditOutput(input);
		assert.ok(result !== null);
	});
});
