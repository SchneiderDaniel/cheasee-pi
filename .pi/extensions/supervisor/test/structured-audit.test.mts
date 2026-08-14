/**
 * Entity tests: structured-audit.ts (extracted from output.ts in #1535).
 *
 * Text-marker / heading fallback for structured audit output plus the
 * shared stripTrailingMetadata helper. The parse-first strategy lives in
 * output.ts's extractStructuredAuditOutput facade; ordering is pinned in
 * output-facade.test.mts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractStructuredAuditMarkers, stripTrailingMetadata } from "../agent/structured-audit.ts";

describe("extractStructuredAuditMarkers — AUDIT_DECISION", () => {
	it("returns decision for AUDIT_DECISION: APPROVED", () => {
		const result = extractStructuredAuditMarkers("AUDIT_DECISION: APPROVED");
		assert.deepEqual(result, { decision: "APPROVED" });
	});

	it("returns decision for AUDIT_DECISION: REJECTED", () => {
		const result = extractStructuredAuditMarkers("AUDIT_DECISION: REJECTED");
		assert.deepEqual(result, { decision: "REJECTED" });
	});

	it("last match wins when multiple AUDIT_DECISION markers present", () => {
		const output = ["AUDIT_DECISION: APPROVED", "text between", "AUDIT_DECISION: REJECTED"].join(
			"\n",
		);
		assert.deepEqual(extractStructuredAuditMarkers(output), { decision: "REJECTED" });
	});
});

describe("extractStructuredAuditMarkers — standalone markers", () => {
	it("last-position wins when both standalone markers present", () => {
		const output = "AUDIT_APPROVED\nAUDIT_REJECTED";
		assert.deepEqual(extractStructuredAuditMarkers(output), { decision: "REJECTED" });
	});

	it("later standalone marker wins regardless of kind", () => {
		const output = "AUDIT_REJECTED\nAUDIT_APPROVED";
		assert.deepEqual(extractStructuredAuditMarkers(output), { decision: "APPROVED" });
	});
});

describe("extractStructuredAuditMarkers — PR/COMMENT fields", () => {
	const output = [
		"AUDIT_DECISION: APPROVED",
		"PR_TITLE: Fix the bug",
		"PR_BODY: This is the pull request body.",
		"COMMENT_BODY: Looks good to me.",
	].join("\n");

	it("extracts PR_TITLE, PR_BODY, COMMENT_BODY", () => {
		assert.deepEqual(extractStructuredAuditMarkers(output), {
			decision: "APPROVED",
			prTitle: "Fix the bug",
			prBody: "This is the pull request body.",
			commentBody: "Looks good to me.",
		});
	});

	it("strips COMMENT_BODY_END from commentBody", () => {
		const withEnd = [
			"AUDIT_DECISION: REJECTED",
			"COMMENT_BODY: Body text",
			"COMMENT_BODY_END",
			"trailing noise",
		].join("\n");
		const result = extractStructuredAuditMarkers(withEnd);
		assert.equal(result?.decision, "REJECTED");
		assert.equal(result?.commentBody, "Body text");
	});
});

describe("extractStructuredAuditMarkers — heading fallback", () => {
	it("## Audit Approved heading yields decision + commentBody", () => {
		const output = [
			"Some preamble text.",
			"## Audit Approved",
			"The changes look good and are approved.",
			"💭 thinking text to strip",
			"📊 metrics to strip",
		].join("\n");
		const result = extractStructuredAuditMarkers(output);
		assert.equal(result?.decision, "APPROVED");
		assert.ok(result?.commentBody?.includes("## Audit Approved"));
		assert.ok(result?.commentBody?.includes("approved."));
		assert.equal(result?.commentBody?.includes("thinking text"), false);
		assert.equal(result?.commentBody?.includes("metrics"), false);
	});

	it("## Audit Rejected heading wins over Approved when later", () => {
		const output = [
			"## Audit Approved",
			"first pass",
			"## Audit Rejected",
			"second pass rejected",
		].join("\n");
		const result = extractStructuredAuditMarkers(output);
		assert.equal(result?.decision, "REJECTED");
	});

	it("truncates trailing JSON code fence after heading", () => {
		const output = [
			"## Audit Approved",
			"The review body text is long enough that the trailing JSON fence lands well past the heading threshold.",
			"```json",
			'{"action":"APPROVED"}',
			"```",
		].join("\n");
		const result = extractStructuredAuditMarkers(output);
		assert.equal(result?.decision, "APPROVED");
		assert.ok(result?.commentBody?.includes("The review body text"));
		assert.equal(result?.commentBody?.includes("```json"), false);
	});

	it("returns null when no markers or heading present", () => {
		assert.equal(extractStructuredAuditMarkers("just some plain text here"), null);
		assert.equal(extractStructuredAuditMarkers(""), null);
	});
});

describe("stripTrailingMetadata — shared helper", () => {
	it("keeps short slices intact", () => {
		assert.equal(
			stripTrailingMetadata("## Audit Approved\nShort.", "## Audit Approved".length),
			"## Audit Approved\nShort.",
		);
	});

	it("truncates at trailing 💭 line when slice is long enough", () => {
		const input =
			"## Audit Approved\nThe review body is sufficiently long here.\n💭 trailing think\n📊 trailing metrics";
		const result = stripTrailingMetadata(input, "## Audit Approved".length);
		assert.equal(result?.includes("trailing think"), false);
		assert.ok(result?.includes("The review body"));
	});
});
