// ─── Tests: pipeline/error-panel.ts (issue #2098) ────────────────
// Phase 6 — rendering is pure and side-effect free; the truncation log moved
// to ingestion (`ErrorCollector.push`) so repeated renders cannot duplicate it.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/error-panel.test.mts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderErrorPanel, summarizeForPanel } from "../pipeline/error-panel.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";
import type { ErrorRecord } from "../pipeline/error-collector.ts";
import type { DebugLogger } from "../lib/debug.ts";
import { setDebugLogger, resetDebugLogger } from "../lib/debug.ts";

// ─── Recording logger ─────────────────────────────────────────────

interface LogEntry {
	level: "debug" | "info" | "warn" | "error";
	component: string;
	message: string;
	data?: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[]): DebugLogger {
	const make = (): DebugLogger => ({
		debug: (component, message, data) => entries.push({ level: "debug", component, message, data }),
		info: (component, message, data) => entries.push({ level: "info", component, message, data }),
		warn: (component, message, data) => entries.push({ level: "warn", component, message, data }),
		error: (component, message, data) => entries.push({ level: "error", component, message, data }),
		child: () => make(),
		getSessionId: () => "",
		getLogPath: () => "",
	});
	return make();
}

function record(
	source: string,
	severity: "warn" | "error",
	message: string,
	timestamp = 1,
): ErrorRecord {
	return { source, severity, message, timestamp };
}

const LONG_MESSAGE = "y".repeat(300);

let entries: LogEntry[] = [];

beforeEach(() => {
	entries = [];
	setDebugLogger(recordingLogger(entries));
});

afterEach(() => {
	resetDebugLogger();
});

// ═══════════════════════════════════════════════════════════════════
// renderErrorPanel — pure presentation
// ═══════════════════════════════════════════════════════════════════

describe("renderErrorPanel()", () => {
	it("returns an empty string for no records", () => {
		assert.equal(renderErrorPanel([]), "");
	});

	it("renders the canonical mixed panel byte-for-byte", () => {
		const block = renderErrorPanel([
			record("source1", "warn", "warning from source1", 1),
			record("source2", "error", "error from source2", 2),
			record("source1", "warn", "another warning from source1", 3),
		]);

		assert.equal(
			block,
			[
				"## ⚠️ Warnings",
				"",
				"### source1",
				"",
				"- **`[WARN]`** warning from source1",
				"- **`[WARN]`** another warning from source1",
				"",
				"### source2",
				"",
				"- **`[ERROR]`** error from source2",
				"",
				"**1 error(s), 2 warning(s)** — see above for details.",
			].join("\n"),
		);
	});

	it("renders errors before warnings within a source group", () => {
		const block = renderErrorPanel([
			record("src", "warn", "first warn msg", 1),
			record("src", "error", "first error msg", 2),
			record("src", "warn", "second warn msg", 3),
		]);

		const errorIdx = block.indexOf("first error msg");
		assert.ok(errorIdx < block.indexOf("first warn msg"));
		assert.ok(errorIdx < block.indexOf("second warn msg"));
	});

	it("touches no logger", () => {
		renderErrorPanel([record("src", "error", LONG_MESSAGE)]);
		assert.deepEqual(entries, [], "presentation must not write log side effects");
	});

	it("never mutates the records it renders", () => {
		const collector = new ErrorCollector();
		collector.push("src", "error", LONG_MESSAGE);
		const before = collector.all.map((r) => ({ ...r }));

		renderErrorPanel(collector.all);
		renderErrorPanel(collector.all);

		assert.equal(collector.size, 1);
		assert.deepEqual(collector.all, before);
	});
});

// ═══════════════════════════════════════════════════════════════════
// summarizeForPanel — actionable tail survives
// ═══════════════════════════════════════════════════════════════════

describe("summarizeForPanel()", () => {
	it("keeps from the remediation: marker onward", () => {
		const message =
			"git push failed: (refusing to allow an OAuth App to create or update workflow `.github/workflows/tests.yml` without `workflow` scope) — remediation: run `cheasee-pi init --reauth` to mint a token with the workflow scope";
		const summary = summarizeForPanel(message);
		assert.ok(summary.startsWith("remediation: run `cheasee-pi init --reauth`"), summary);
		assert.ok(!summary.includes("refusing to allow"), summary);
	});

	it("keeps the trailing parenthesized clause of a long message", () => {
		const message =
			"git push failed: To https://github.com/SchneiderDaniel/cheasee-pi.git\n ! [remote rejected] abc123 -> worktree-git-issue-1519-feature-ci-workflow-running-the-full-test-suite (protected branch hook declined)";
		assert.equal(summarizeForPanel(message), "(protected branch hook declined)");
	});

	it("head-truncates to 200 chars plus an ellipsis", () => {
		assert.equal(summarizeForPanel(LONG_MESSAGE), "y".repeat(200) + "...");
	});

	it("leaves messages at or under 200 chars unchanged", () => {
		const exact = "z".repeat(200);
		assert.equal(summarizeForPanel(exact), exact);
		assert.equal(summarizeForPanel("short"), "short");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Ingestion logging — exactly once, at push
// ═══════════════════════════════════════════════════════════════════

describe("ErrorCollector — truncation log at ingestion", () => {
	function truncationEntries(): LogEntry[] {
		return entries.filter((e) => e.message === "notification message truncated");
	}

	it("push(longMessage) logs one entry carrying the full record", () => {
		const collector = new ErrorCollector();
		collector.push("src", "error", LONG_MESSAGE);

		const hits = truncationEntries();
		assert.equal(hits.length, 1);
		assert.deepEqual(hits[0]!.data, { source: "src", message: LONG_MESSAGE });
	});

	it("push(shortMessage) logs nothing", () => {
		new ErrorCollector().push("src", "warn", "short message");
		assert.deepEqual(truncationEntries(), []);
	});

	it("repeated renders do not duplicate the log entry", () => {
		const collector = new ErrorCollector();
		collector.push("src", "error", LONG_MESSAGE);

		collector.toNotificationBlock();
		renderErrorPanel(collector.all);
		collector.toNotificationBlock();

		assert.equal(truncationEntries().length, 1);
	});

	it("flush() then render adds no further log entry", () => {
		const collector = new ErrorCollector();
		collector.push("src", "error", LONG_MESSAGE);

		const flushed = collector.flush("src");
		assert.equal(flushed.length, 1);
		collector.toNotificationBlock();

		assert.equal(truncationEntries().length, 1);
	});

	it("a disabled collector is silent and empty", () => {
		const collector = new ErrorCollector({ enabled: false });
		collector.push("src", "error", LONG_MESSAGE);

		assert.equal(truncationEntries().length, 0, "no-op collection must not log");
		assert.equal(collector.hasErrors(), false);
		assert.equal(collector.size, 0);
		assert.equal(collector.toNotificationBlock(), "");
		assert.deepEqual(collector.flush("src"), []);
		assert.deepEqual(collector.all, []);
	});
});
