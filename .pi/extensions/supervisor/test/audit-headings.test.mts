// ─── Tests: lib/audit-headings.ts — anchored audit heading matchers ──
// Issue #1668 regression: the unanchored substring regex counted quoted
// "## Audit Rejected" occurrences (e.g. a Test Plan body describing the
// refusal contract) as pipeline rejections, tripping the limit early.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AUDIT_APPROVED_HEADING,
	AUDIT_REJECTED_HEADING,
	isAuditApprovedComment,
	isAuditRejectedComment,
	lastLineHeadingIndex,
} from "../lib/audit-headings.ts";

const TEST_PLAN_QUOTE = 'no "## Audit Rejected"/"## Audit Approved" verdict comment';

// ─── Tests: isAuditRejectedComment() ─────────────────────────────

describe("isAuditRejectedComment()", () => {
	it("matches a genuine rejection heading at body position 0", () => {
		assert.equal(isAuditRejectedComment(`## Audit Rejected\n\nSome finding`), true);
	});

	it("is case-insensitive", () => {
		assert.equal(isAuditRejectedComment("## audit rejected\nx"), true);
		assert.equal(isAuditRejectedComment("## AUDIT REJECTED\nx"), true);
	});

	it("rejects the exact #1618 Test Plan quote (regression anchor)", () => {
		assert.equal(isAuditRejectedComment(TEST_PLAN_QUOTE), false);
	});

	it("rejects a mid-body occurrence (position-0 only)", () => {
		assert.equal(isAuditRejectedComment(`intro\n\n## Audit Rejected\n...`), false);
	});

	it("rejects fenced-code, blockquote and leading-newline variants", () => {
		assert.equal(isAuditRejectedComment("```\n## Audit Rejected\n```"), false);
		assert.equal(isAuditRejectedComment("> ## Audit Rejected"), false);
		assert.equal(isAuditRejectedComment("\n## Audit Rejected"), false);
	});

	it("counts a botched '##AuditRejected' at position 0 (\\s* trade-off)", () => {
		assert.equal(isAuditRejectedComment("##AuditRejected\nx"), true);
	});

	it("returns false for empty/undefined/null bodies", () => {
		assert.equal(isAuditRejectedComment(""), false);
		assert.equal(isAuditRejectedComment(undefined), false);
		assert.equal(isAuditRejectedComment(null), false);
	});

	it("does not match the approval heading", () => {
		assert.equal(isAuditRejectedComment(`## Audit Approved`), false);
	});
});

// ─── Tests: isAuditApprovedComment() ────────────────────────────

describe("isAuditApprovedComment()", () => {
	it("matches a genuine approval heading at body position 0", () => {
		assert.equal(isAuditApprovedComment(`## Audit Approved\n\nScore: 6/6`), true);
	});

	it("is case-insensitive", () => {
		assert.equal(isAuditApprovedComment("## audit approved\nx"), true);
	});

	it("rejects the exact #1618 Test Plan quote (regression anchor)", () => {
		assert.equal(isAuditApprovedComment(TEST_PLAN_QUOTE), false);
	});

	it("rejects mid-body and quoted variants", () => {
		assert.equal(isAuditApprovedComment(`intro\n\n## Audit Approved\n...`), false);
		assert.equal(isAuditApprovedComment("> ## Audit Approved"), false);
	});

	it("does not match the rejection heading", () => {
		assert.equal(isAuditApprovedComment(`## Audit Rejected`), false);
	});

	it("returns false for empty body", () => {
		assert.equal(isAuditApprovedComment(""), false);
	});
});

// ─── Tests: lastLineHeadingIndex() ───────────────────────────────

describe("lastLineHeadingIndex()", () => {
	it("returns the last line-start occurrence index (case-insensitive)", () => {
		const text = "reason: ## Audit Rejected ignored\n\n## Audit Rejected\nreal";
		const idx = lastLineHeadingIndex(text, AUDIT_REJECTED_HEADING);
		assert.notEqual(idx, -1);
		assert.ok(idx > text.indexOf("reason:"), "matches the later line-start heading");
	});

	it("prefers the most recent heading across line breaks", () => {
		const text = "## Audit Rejected\n\n## Audit Approved";
		assert.ok(
			lastLineHeadingIndex(text, AUDIT_APPROVED_HEADING) >
				lastLineHeadingIndex(text, AUDIT_REJECTED_HEADING),
		);
	});

	it("ignores mid-line occurrences", () => {
		assert.equal(lastLineHeadingIndex("reason: ## Audit Rejected", AUDIT_REJECTED_HEADING), -1);
	});

	it("returns -1 when absent", () => {
		assert.equal(lastLineHeadingIndex("no headings here", AUDIT_REJECTED_HEADING), -1);
	});

	it("finds the heading at position 0", () => {
		assert.equal(lastLineHeadingIndex("## Audit Approved\n...", AUDIT_APPROVED_HEADING), 0);
	});
});

// ─── Tests: heading constants ────────────────────────────────────

describe("heading constants", () => {
	it("equal the canonical template headings", () => {
		assert.equal(AUDIT_REJECTED_HEADING, "## Audit Rejected");
		assert.equal(AUDIT_APPROVED_HEADING, "## Audit Approved");
	});
});