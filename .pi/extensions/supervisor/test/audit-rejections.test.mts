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
	const MARK = "<!-- supervisor:audit-rejection -->";

	it("returns undefined when no comment carries an id", () => {
		const comments = [{ body: `## Audit Rejected\nx\n\n${MARK}` }];
		assert.equal(findPriorAuditRejection(comments), undefined);
	});

	it("returns the newest supervisor rejection comment with its id", () => {
		const comments = [
			{ id: "1", body: `## Audit Rejected\nold\n\n${MARK}` },
			{ id: "2", body: "## Audit Approved\nok" },
			{ id: "3", body: `## Audit Rejected\nnew\n\n${MARK}` },
		];
		assert.deepEqual(findPriorAuditRejection(comments), {
			id: "3",
			body: `## Audit Rejected\nnew\n\n${MARK}`,
		});
	});

	it("matches marked gate rejections as audit rejections", () => {
		const comments = [{ id: "9", body: `## Audit Score Gate Rejected\nlow score\n\n${MARK}` }];
		assert.deepEqual(findPriorAuditRejection(comments), {
			id: "9",
			body: `## Audit Score Gate Rejected\nlow score\n\n${MARK}`,
		});
	});

	it("never selects an unmarked comment, even with a rejection heading", () => {
		const comments = [
			{ id: "1", body: "## Audit Rejected\ncodeowner wrote this" },
			{ id: "2", body: "## Audit Score Gate Rejected\nunmarked gate" },
		];
		assert.equal(findPriorAuditRejection(comments), undefined);
	});

	it("ignores id-less rejection comments and quoted headings", () => {
		const comments = [
			{ id: "1", body: "## Audit Approved" },
			{ id: "2", body: `no "## Audit Rejected" verdict comment\n${MARK}` },
		];
		assert.equal(findPriorAuditRejection(comments), undefined);
	});
});

// ─── countAuditRejections() ──────────────────────────────────────

describe("countAuditRejections()", () => {
	it("uses the label count when labels are ahead", () => {
		assert.equal(countAuditRejections(["reject-5"], 1), 5);
	});

	it("falls back to the legacy count for pre-label issues", () => {
		assert.equal(countAuditRejections([], 2), 2);
	});

	it("uses the label count when the legacy count is higher", () => {
		assert.equal(countAuditRejections(["reject-7"], 2), 7);
	});

	it("returns 0 with no labels and no legacy count", () => {
		assert.equal(countAuditRejections([], 0), 0);
	});
});
