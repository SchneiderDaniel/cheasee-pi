// ─── Tests: lib/audit-rejections.ts — rejection identity + loop count ──
// Issue #2044: the auditor updates its prior rejection comment in place, so
// the loop counter moves from counted `## Audit Rejected` comments to
// `reject-N` labels, with a legacy max(labels, comments) fallback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	countAuditRejections,
	findPriorAuditRejection,
	parseRejectCount,
	rejectLabel,
	REJECT_LABEL_PREFIX,
} from "../lib/audit-rejections.ts";

// ─── parseRejectCount() ──────────────────────────────────────────

describe("parseRejectCount()", () => {
	it("returns 0 for no labels", () => {
		assert.equal(parseRejectCount([]), 0);
	});

	it("returns the single label number", () => {
		assert.equal(parseRejectCount(["reject-1"]), 1);
	});

	it("returns the highest N across labels", () => {
		assert.equal(parseRejectCount(["reject-1", "reject-3", "reject-2"]), 3);
	});

	it("ignores unrelated and malformed labels", () => {
		assert.equal(parseRejectCount(["bug", "reject-", "reject-x", "reject- 2"]), 0);
	});

	it("trims surrounding whitespace", () => {
		assert.equal(parseRejectCount([" reject-4 "]), 4);
	});
});

// ─── rejectLabel() ───────────────────────────────────────────────

describe("rejectLabel()", () => {
	it("builds the reject-N label grammar", () => {
		assert.equal(rejectLabel(1), "reject-1");
		assert.equal(rejectLabel(12), "reject-12");
		assert.equal(REJECT_LABEL_PREFIX, "reject-");
	});
});

// ─── findPriorAuditRejection() ───────────────────────────────────

describe("findPriorAuditRejection()", () => {
	it("returns undefined when no comment carries an id", () => {
		const comments = [{ body: "## Audit Rejected\nx" }];
		assert.equal(findPriorAuditRejection(comments), undefined);
	});

	it("returns the newest rejection comment with its id", () => {
		const comments = [
			{ id: "1", body: "## Audit Rejected\nold" },
			{ id: "2", body: "## Audit Approved\nok" },
			{ id: "3", body: "## Audit Rejected\nnew" },
		];
		assert.deepEqual(findPriorAuditRejection(comments), {
			id: "3",
			body: "## Audit Rejected\nnew",
		});
	});

	it("matches gate rejections as audit rejections", () => {
		const comments = [{ id: "9", body: "## Audit Score Gate Rejected\nlow score" }];
		assert.deepEqual(findPriorAuditRejection(comments), {
			id: "9",
			body: "## Audit Score Gate Rejected\nlow score",
		});
	});

	it("ignores id-less rejection comments and quoted headings", () => {
		const comments = [
			{ id: "1", body: "## Audit Approved" },
			{ id: "2", body: 'no "## Audit Rejected" verdict comment' },
		];
		assert.equal(findPriorAuditRejection(comments), undefined);
	});
});

// ─── countAuditRejections() ──────────────────────────────────────

describe("countAuditRejections()", () => {
	it("uses the label count when labels are ahead", () => {
		assert.equal(countAuditRejections(["reject-5"], [{ body: "## Audit Rejected" }]), 5);
	});

	it("falls back to legacy comment count for pre-label issues", () => {
		const comments = [
			{ body: "## Audit Rejected\n1" },
			{ body: "## Audit Rejected\n2" },
		];
		assert.equal(countAuditRejections([], comments), 2);
	});

	it("counts gate rejections in the legacy fallback", () => {
		const comments = [
			{ body: "## Audit Rejected\n1" },
			{ body: "## Audit Score Gate Rejected\n2" },
		];
		assert.equal(countAuditRejections([], comments), 2);
	});

	it("ignores quoted headings in comment bodies", () => {
		const comments = [{ body: 'no "## Audit Rejected"/"## Audit Approved" verdict comment' }];
		assert.equal(countAuditRejections([], comments), 0);
	});
});
