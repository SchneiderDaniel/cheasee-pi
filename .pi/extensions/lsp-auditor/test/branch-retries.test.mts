/**
 * Phase 1: branch-retries.ts — retry budget scoped to the active branch.
 *
 * The defect: retry counts previously read the whole session tree
 * (getEntries()), so retries recorded on abandoned sibling branches could
 * exhaust the active branch's budget. countBranchRetryAttempts() must read
 * only getBranch() and never fall back to getEntries().
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/lsp-auditor/test/branch-retries.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	mapSessionEntriesToRetryEntries,
	countBranchRetryAttempts,
} from "../branch-retries.ts";

// ─── Fixtures ────────────────────────────────────────────────────────

function retryEntry(issueNum: unknown, attempt = 1) {
	return { type: "custom", customType: "lsp-audit-retry", data: { issueNum, attempt } };
}

/** Fake session manager exposing independent branch/entries accessors. */
function fakeSm(branch: unknown, entries: unknown = []) {
	const calls = { branch: 0, entries: 0 };
	const sm = {
		getBranch: () => {
			calls.branch++;
			return branch;
		},
		getEntries: () => {
			calls.entries++;
			return entries;
		},
	};
	return { sm, calls };
}

describe("countBranchRetryAttempts — active-branch scope", () => {
	it("counts matching retry entries on the branch", () => {
		const { sm } = fakeSm([retryEntry(35), retryEntry(35, 2)]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 2);
	});

	it("ignores retries that exist only on abandoned sibling branches", () => {
		const siblingOnly = [retryEntry(35), retryEntry(35), retryEntry(35)];
		const { sm, calls } = fakeSm([], siblingOnly);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 0);
		assert.strictEqual(calls.entries, 0, "getEntries() must never be consulted");
	});

	it("counts only branch retries when siblings also match (mixed)", () => {
		const { sm, calls } = fakeSm([retryEntry(35)], [
			retryEntry(35),
			retryEntry(35),
			retryEntry(35),
			retryEntry(35),
		]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 1);
		assert.strictEqual(calls.entries, 0);
	});

	it("returns branch count even when getEntries() would throw", () => {
		const sm = {
			getBranch: () => [retryEntry(35)],
			getEntries: () => {
				throw new Error("getEntries must not be called");
			},
		};
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 1);
	});

	it("empty branch → 0", () => {
		const { sm } = fakeSm([]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 0);
	});

	it("entries for a different issue number are not counted", () => {
		const { sm } = fakeSm([retryEntry(99), retryEntry(99)]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 0);
	});

	it("non-retry entries on the branch are ignored", () => {
		const { sm } = fakeSm([
			{ type: "custom", customType: "phase-change", data: { issueNum: 35 } },
			{ type: "message", issueNum: 35 },
			retryEntry(35),
		]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 1);
	});

	it("retry entries with missing or non-object data are ignored", () => {
		const { sm } = fakeSm([
			{ type: "custom", customType: "lsp-audit-retry" },
			{ type: "custom", customType: "lsp-audit-retry", data: null },
			{ type: "custom", customType: "lsp-audit-retry", data: "35" },
		]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 0);
	});

	it("string issueNum is not counted (strict equality)", () => {
		const { sm } = fakeSm([retryEntry("35")]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 0);
	});

	it("pre-fork ancestors stay counted after a fork (shared lineage)", () => {
		// getBranch() returns the leaf lineage, which includes pre-fork ancestors.
		const { sm } = fakeSm([retryEntry(35), retryEntry(35, 2), retryEntry(35, 3)]);
		assert.strictEqual(countBranchRetryAttempts(sm as never, 35), 3);
	});

	it("null/undefined branch → 0, no throw (defensive)", () => {
		assert.strictEqual(countBranchRetryAttempts(fakeSm(null).sm as never, 35), 0);
		assert.strictEqual(countBranchRetryAttempts(fakeSm(undefined).sm as never, 35), 0);
	});
});

describe("mapSessionEntriesToRetryEntries — re-exported adapter", () => {
	it("maps custom entries to {type: customType, payload: data}", () => {
		const mapped = mapSessionEntriesToRetryEntries([
			{ type: "custom", customType: "lsp-audit-retry", data: { issueNum: 35 } },
		]);
		assert.deepStrictEqual(mapped, [{ type: "lsp-audit-retry", payload: { issueNum: 35 } }]);
	});

	it("passes non-custom entries through with the entry as payload", () => {
		const mapped = mapSessionEntriesToRetryEntries([{ type: "message", text: "hi" }]);
		assert.strictEqual(mapped[0]!.type, "message");
		assert.deepStrictEqual(mapped[0]!.payload, { type: "message", text: "hi" });
	});
});
