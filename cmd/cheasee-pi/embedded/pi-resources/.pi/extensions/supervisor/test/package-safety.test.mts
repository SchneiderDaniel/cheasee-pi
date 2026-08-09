// ─── Tests: package-safety.ts — checkPackageAge ────────────────────
// Pure function tests — no infra needed.
// Tests the deterministic package age validation logic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPackageAge, SAFETY_THRESHOLD_DAYS } from "../checks/package-safety.ts";

// ─── Tests: constants ──────────────────────────────────────────────

describe("SAFETY_THRESHOLD_DAYS", () => {
	it("is 14 days", () => {
		assert.equal(SAFETY_THRESHOLD_DAYS, 14);
	});
});

// ─── Tests: checkPackageAge — parseDate helper ────────────────────

describe("checkPackageAge — parseDate", () => {
	it("returns null for null input", () => {
		const result = checkPackageAge.parseDate(null);
		assert.equal(result, null);
	});

	it("returns null for undefined input", () => {
		const result = checkPackageAge.parseDate(undefined);
		assert.equal(result, null);
	});

	it("returns null for empty string", () => {
		const result = checkPackageAge.parseDate("");
		assert.equal(result, null);
	});

	it("returns null for unparseable date string", () => {
		const result = checkPackageAge.parseDate("not-a-date");
		assert.equal(result, null);
	});

	it("parses ISO date string", () => {
		const result = checkPackageAge.parseDate("2025-01-15T10:30:00.000Z");
		assert.ok(result instanceof Date);
		assert.equal(result.toISOString(), "2025-01-15T10:30:00.000Z");
	});

	it("parses npm-style date string", () => {
		const result = checkPackageAge.parseDate("2025-01-15T10:30:00.000Z");
		assert.ok(result instanceof Date);
	});

	it("parses date-only string", () => {
		const result = checkPackageAge.parseDate("2025-01-15");
		assert.ok(result instanceof Date);
		assert.equal(result.getUTCFullYear(), 2025);
		assert.equal(result.getUTCMonth(), 0); // January is 0
		assert.equal(result.getUTCDate(), 15);
	});
});

// ─── Tests: checkPackageAge ────────────────────────────────────────

describe("checkPackageAge", () => {
	it("returns safe=true for package older than threshold", () => {
		// Create a date 30 days ago
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const result = checkPackageAge.calculate(thirtyDaysAgo.toISOString());
		assert.equal(result.safe, true);
		assert.equal(result.blocked, false);
		assert.ok(result.ageDays >= 30);
	});

	it("returns safe=false, blocked=true for package newer than threshold", () => {
		// Create a date 3 days ago
		const threeDaysAgo = new Date();
		threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
		const result = checkPackageAge.calculate(threeDaysAgo.toISOString());
		assert.equal(result.safe, false);
		assert.equal(result.blocked, true);
		assert.ok(result.ageDays < SAFETY_THRESHOLD_DAYS);
	});

	it("returns safe=true for package exactly at threshold", () => {
		// Create a date exactly 14 days ago
		const fourteenDaysAgo = new Date();
		fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
		const result = checkPackageAge.calculate(fourteenDaysAgo.toISOString());
		assert.equal(result.safe, true);
		assert.equal(result.blocked, false);
		assert.ok(result.ageDays >= 14);
	});

	it("returns safe=false, blocked=true for package 1 day old", () => {
		const oneDayAgo = new Date();
		oneDayAgo.setDate(oneDayAgo.getDate() - 1);
		const result = checkPackageAge.calculate(oneDayAgo.toISOString());
		assert.equal(result.safe, false);
		assert.equal(result.blocked, true);
	});

	it("returns safe=false, blocked=true for package 13 days old", () => {
		const thirteenDaysAgo = new Date();
		thirteenDaysAgo.setDate(thirteenDaysAgo.getDate() - 13);
		const result = checkPackageAge.calculate(thirteenDaysAgo.toISOString());
		assert.equal(result.safe, false);
		assert.equal(result.blocked, true);
	});

	it("returns safe=false, blocked=true when date is invalid (fail closed)", () => {
		const result = checkPackageAge.calculate("invalid-date");
		assert.equal(result.safe, false);
		assert.equal(result.blocked, true);
	});

	it("returns safe=false, blocked=true when date is null/undefined (fail closed)", () => {
		const result1 = checkPackageAge.calculate(null);
		assert.equal(result1.safe, false);
		assert.equal(result1.blocked, true);

		const result2 = checkPackageAge.calculate(undefined);
		assert.equal(result2.safe, false);
		assert.equal(result2.blocked, true);
	});

	it("returns safe=false, blocked=true when date is empty string (fail closed)", () => {
		const result = checkPackageAge.calculate("");
		assert.equal(result.safe, false);
		assert.equal(result.blocked, true);
	});

	it("returns ageDays as whole number", () => {
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const result = checkPackageAge.calculate(thirtyDaysAgo.toISOString());
		assert.ok(Number.isInteger(result.ageDays));
	});

	it("considers timezone when computing age difference", () => {
		// Package published 15 days ago at midnight UTC
		const fifteenDaysAgo = new Date();
		fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
		fifteenDaysAgo.setUTCHours(0, 0, 0, 0);
		const result = checkPackageAge.calculate(fifteenDaysAgo.toISOString());
		assert.equal(result.safe, true);
		assert.equal(result.blocked, false);
	});
});

// ─── Tests: buildBlockedMessage ────────────────────────────────────

describe("checkPackageAge.buildBlockedMessage", () => {
	it("builds blocked message with package name and age", () => {
		const msg = checkPackageAge.buildBlockedMessage("some-package", 3);
		assert.ok(msg.includes("some-package"));
		assert.ok(msg.includes("3"));
		assert.ok(msg.includes("safety threshold"));
	});

	it("handles scoped package names", () => {
		const msg = checkPackageAge.buildBlockedMessage("@scope/pkg", 5);
		assert.ok(msg.includes("@scope/pkg"));
	});
});

// ─── Tests: isExempt ──────────────────────────────────────────────

describe("checkPackageAge.isExempt", () => {
	it("returns true for git URL", () => {
		assert.equal(checkPackageAge.isExempt("git+https://github.com/user/repo.git"), true);
	});

	it("returns true for tarball URL", () => {
		assert.equal(checkPackageAge.isExempt("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"), true);
	});

	it("returns true for local path", () => {
		assert.equal(checkPackageAge.isExempt("../local-package"), true);
		assert.equal(checkPackageAge.isExempt("./dist"), true);
	});

	it("returns false for simple package name", () => {
		assert.equal(checkPackageAge.isExempt("lodash"), false);
	});

	it("returns false for scoped package name", () => {
		assert.equal(checkPackageAge.isExempt("@scope/pkg"), false);
	});

	it("returns true for file:// protocol", () => {
		assert.equal(checkPackageAge.isExempt("file:./local.tar.gz"), true);
	});
});
