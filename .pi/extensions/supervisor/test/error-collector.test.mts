// ─── Tests: pipeline/error-collector.ts — ErrorCollector class ───
// Phase 1: unit tests for push, flush, hasErrors, toNotificationBlock, singleton.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ErrorCollector,
	getErrorCollector,
	setErrorCollector,
	resetErrorCollector,
} from "../pipeline/error-collector.ts";
import type { ErrorRecord } from "../pipeline/error-collector.ts";
import {
	createDebugLogger,
	setDebugLogger,
	resetDebugLogger,
} from "../lib/debug.ts";

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Quick check that a value is a valid ErrorRecord.
 */
function assertErrorRecord(
	record: ErrorRecord,
	source: string,
	severity: "warn" | "error",
	message: string,
): void {
	assert.equal(typeof record.timestamp, "number", "timestamp should be a number");
	assert.ok(record.timestamp > 0, "timestamp should be > 0");
	assert.equal(record.source, source);
	assert.equal(record.severity, severity);
	assert.equal(record.message, message);
}

// ─── ErrorCollector: push ─────────────────────────────────────────

describe("ErrorCollector — push", () => {
	it("adds an ErrorRecord with correct source, severity, message, timestamp", () => {
		const collector = new ErrorCollector();
		collector.push("test-source", "warn", "test message");
		const records = collector.all;
		assert.equal(records.length, 1);
		assertErrorRecord(records[0]!, "test-source", "warn", "test message");
	});

	it("push with 2 records — hasErrors returns true, flush('source1') returns only source1 records", () => {
		const collector = new ErrorCollector();
		collector.push("source1", "warn", "msg1");
		collector.push("source2", "error", "msg2");

		assert.ok(collector.hasErrors(), "hasErrors should return true after pushes");

		const flushed = collector.flush("source1");
		assert.equal(flushed.length, 1);
		assert.equal(flushed[0]!.source, "source1");
		assert.equal(flushed[0]!.message, "msg1");

		// source2 records should remain
		assert.equal(collector.size, 1, "source2 record should remain");
		assert.equal(collector.all[0]!.source, "source2");
	});

	it("flush returns shifted records, subsequent flush returns empty array", () => {
		const collector = new ErrorCollector();
		collector.push("src", "warn", "a");
		collector.push("src", "warn", "b");

		const first = collector.flush("src");
		assert.equal(first.length, 2);
		assert.equal(first[0]!.message, "a");
		assert.equal(first[1]!.message, "b");

		// Second flush should return empty
		const second = collector.flush("src");
		assert.equal(second.length, 0);
	});

	it("hasErrors returns false when empty, true after push", () => {
		const collector = new ErrorCollector();
		assert.equal(collector.hasErrors(), false);
		collector.push("src", "warn", "test");
		assert.equal(collector.hasErrors(), true);
	});
});

// ─── ErrorCollector: toNotificationBlock ──────────────────────────

describe("ErrorCollector — toNotificationBlock", () => {
	it("returns empty string when no errors", () => {
		const collector = new ErrorCollector();
		assert.equal(collector.toNotificationBlock(), "");
	});

	it('contains "⚠️ Warnings" heading, groups by source, lists messages, shows totals per source', () => {
		const collector = new ErrorCollector();
		collector.push("source1", "warn", "warning from source1");
		collector.push("source2", "error", "error from source2");
		collector.push("source1", "warn", "another warning from source1");

		const block = collector.toNotificationBlock();

		// Has main heading
		assert.ok(block.includes("⚠️ Warnings"), "should have warnings heading");

		// Groups by source
		const source1Idx = block.indexOf("### source1");
		const source2Idx = block.indexOf("### source2");
		assert.ok(source1Idx >= 0, "should have source1 group");
		assert.ok(source2Idx >= 0, "should have source2 group");
		assert.ok(source1Idx < source2Idx, "source1 should appear before source2 (insertion order)");

		// Lists messages under each source
		assert.ok(block.includes("warning from source1"), "should list source1 warning");
		assert.ok(block.includes("another warning from source1"), "should list second source1 warning");
		assert.ok(block.includes("error from source2"), "should list source2 error");

		// Shows totals
		assert.ok(block.includes("1 error(s)"), "should show 1 error");
		assert.ok(block.includes("2 warning(s)"), "should show 2 warnings");
	});

	it("truncates message to 200 chars per line, appends '...' for truncated lines", () => {
		const collector = new ErrorCollector();
		const longMsg = "x".repeat(300);
		collector.push("src", "warn", longMsg);

		const block = collector.toNotificationBlock();
		const expectedTruncated = "x".repeat(200) + "...";
		assert.ok(block.includes(expectedTruncated), "message should be truncated to 200 chars");
		assert.ok(!block.includes("x".repeat(201)), "should not have more than 200 chars");
	});

	it("keeps from the remediation: marker (action-first) for workflow-scope push rejections", () => {
		const collector = new ErrorCollector();
		const msg =
			"git push failed: (refusing to allow an OAuth App to create or update workflow `.github/workflows/tests.yml` without `workflow` scope) — remediation: run `cheasee-pi init --reauth` to mint a token with the workflow scope";
		collector.push("git", "error", msg);

		const block = collector.toNotificationBlock();
		assert.ok(
			block.includes("remediation: run `cheasee-pi init --reauth`"),
			`panel should show action-first hint: ${block}`,
		);
		assert.ok(!block.includes("refusing to allow"), "head of the message should be dropped");
		assert.ok(!block.includes("..."), "remediation hint must not be head-truncated");
	});

	it("long remote-rejected message — trailing parenthesized clause survives instead of the head", () => {
		const collector = new ErrorCollector();
		// The GitHub reason lands past MAX_MESSAGE_LENGTH=200 (branch names alone
		// consume ~71 chars before the parenthesized reason prints).
		const msg =
			"git push failed: To https://github.com/SchneiderDaniel/cheasee-pi.git\n ! [remote rejected] abc123 -> worktree-git-issue-1519-feature-ci-workflow-running-the-full-test-suite (protected branch hook declined)";
		collector.push("git", "error", msg);

		const block = collector.toNotificationBlock();
		assert.ok(
			block.includes("(protected branch hook declined)"),
			`panel should keep the trailing reason clause: ${block}`,
		);
		assert.ok(!block.includes("To https://github.com"), "head should be dropped");
	});

	it("message longer than 200 chars is persisted in full to the debug log", () => {
		const logDir = mkdtempSync(join(tmpdir(), "error-collector-trunc-"));
		const logger = createDebugLogger(logDir);
		setDebugLogger(logger);
		try {
			const collector = new ErrorCollector();
			const longMsg = "y".repeat(300);
			collector.push("src", "error", longMsg);
			collector.toNotificationBlock();

			const logLines = readFileSync(logger.getLogPath(), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean);
			const hit = logLines.find((l) => {
				try {
					return (JSON.parse(l) as { message: string }).message === "notification message truncated";
				} catch {
					return false;
				}
			});
			assert.ok(hit, "truncation must be logged to the debug log");
			const entry = JSON.parse(hit) as { data: { source: string; message: string } };
			assert.equal(entry.data.source, "src");
			assert.equal(entry.data.message, longMsg);
		} finally {
			resetDebugLogger();
			rmSync(logDir, { recursive: true, force: true });
		}
	});

	it("short message with remediation: marker is still extracted (marker wins over length)", () => {
		const collector = new ErrorCollector();
		collector.push("git", "error", "something failed — remediation: run `cheasee-pi init --reauth`");
		const block = collector.toNotificationBlock();
		assert.ok(block.includes("remediation: run `cheasee-pi init --reauth`"));
		assert.ok(!block.includes("something failed"));
	});

	it("no debug log write for short messages (nothing truncated)", () => {
		const logDir = mkdtempSync(join(tmpdir(), "error-collector-short-"));
		const logger = createDebugLogger(logDir);
		setDebugLogger(logger);
		try {
			const collector = new ErrorCollector();
			collector.push("src", "warn", "short message");
			collector.toNotificationBlock();
			let contents = "";
			try {
				contents = readFileSync(logger.getLogPath(), "utf8");
			} catch {
				// no log file yet — nothing was written, which is the point
			}
			const logLines = contents.trim().split("\n").filter(Boolean);
			const hit = logLines.find((l) => l.includes("notification message truncated"));
			assert.equal(hit, undefined, "no truncation log for short messages");
		} finally {
			resetDebugLogger();
			rmSync(logDir, { recursive: true, force: true });
		}
	});

	it("renders ERROR severity messages before warn within same source group", () => {
		const collector = new ErrorCollector();
		collector.push("src", "warn", "first warn msg");
		collector.push("src", "error", "first error msg");
		collector.push("src", "warn", "second warn msg");

		const block = collector.toNotificationBlock();
		const errorIdx = block.indexOf("first error msg");
		const firstWarnIdx = block.indexOf("first warn msg");
		const secondWarnIdx = block.indexOf("second warn msg");

		assert.ok(errorIdx >= 0, "error message should be present");
		assert.ok(firstWarnIdx >= 0, "first warn message should be present");
		assert.ok(secondWarnIdx >= 0, "second warn message should be present");

		// Error should appear before both warnings
		assert.ok(errorIdx < firstWarnIdx, "error should come before first warning");
		assert.ok(errorIdx < secondWarnIdx, "error should come before second warning");
	});

	it("Dedup: 2 identical pushes produce 2 records (no dedup unless architecture specifies it)", () => {
		const collector = new ErrorCollector();
		collector.push("src", "warn", "duplicate message");
		collector.push("src", "warn", "duplicate message");

		assert.equal(collector.size, 2);
		const block = collector.toNotificationBlock();
		// Both should appear in the block
		const matches = block.match(/duplicate message/g);
		assert.equal(matches?.length, 2, "both duplicate messages should appear in block");
	});
});

// ─── Singleton ────────────────────────────────────────────────────

describe("ErrorCollector — singleton", () => {
	beforeEach(() => {
		resetErrorCollector();
	});

	afterEach(() => {
		resetErrorCollector();
	});

	it("getErrorCollector returns a no-op collector by default", () => {
		const collector = getErrorCollector();
		assert.ok(collector instanceof ErrorCollector);
		// Should be a no-op that does nothing but doesn't throw
		collector.push("src", "warn", "test");
		assert.equal(collector.hasErrors(), false);
		assert.equal(collector.size, 0);
		assert.equal(collector.toNotificationBlock(), "");
		assert.equal(collector.flush("src").length, 0);
	});

	it("setErrorCollector replaces the singleton", () => {
		const real = new ErrorCollector();
		setErrorCollector(real);
		const retrieved = getErrorCollector();
		assert.equal(retrieved, real);

		// Pushing to the singleton should work
		retrieved.push("src", "warn", "hello from singleton");
		assert.ok(retrieved.hasErrors());
		assert.equal(retrieved.size, 1);
	});

	it("resetErrorCollector clears to a fresh no-op instance", () => {
		const real = new ErrorCollector();
		real.push("src", "error", "test");
		setErrorCollector(real);

		resetErrorCollector();
		const after = getErrorCollector();
		assert.notEqual(after, real);
		assert.equal(after.hasErrors(), false);
		assert.equal(after.size, 0);
	});
});
