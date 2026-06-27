// ─── Tests: pipeline/replay-session.ts — replaySessionFile ─────────
// Phase 0 + Phase 2: verifies that captured session JSONL files are
// replayed through pi.sendMessage with eventType "subagent-result".

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Import the module under test ──────────────────────────────────

const replayModule = await import("../../pipeline/replay-session.ts");
const { replaySessionFile } = replayModule;

// ─── Helpers ───────────────────────────────────────────────────────

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
	return dir;
}

function createSessionFile(dir: string, lines: string[]): string {
	const filePath = join(dir, "session.jsonl");
	writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
	return filePath;
}

function createMockPi() {
	const sendMessageCalls: any[] = [];
	return {
		sendMessage: (msg: any) => {
			sendMessageCalls.push(msg);
		},
		sendMessageCalls,
	};
}

// ─── Fixtures ──────────────────────────────────────────────────────

/** A minimal session header entry */
const SESSION_HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "test-session",
	timestamp: Date.now(),
	cwd: "/repo",
});

/** A user message entry (included but typically not displayed in replay) */
const USER_MESSAGE = JSON.stringify({
	type: "message",
	role: "user",
	id: "msg-1",
	content: [{ type: "text", text: "Implement feature X" }],
});

/** An assistant message with text content and usage */
const ASSISTANT_MESSAGE = JSON.stringify({
	type: "message",
	role: "assistant",
	id: "msg-2",
	parentId: "msg-1",
	content: [{ type: "text", text: "Here is my implementation plan." }],
	usage: { input: 500, output: 150, cacheRead: 100, cacheWrite: 0, cost: { total: 0.002 } },
});

/** An assistant message with thinking + text blocks */
const ASSISTANT_THINKING_MESSAGE = JSON.stringify({
	type: "message",
	role: "assistant",
	id: "msg-3",
	parentId: "msg-2",
	content: [
		{ type: "thinking", thinking: "Let me think about this carefully." },
		{ type: "text", text: "I think the best approach is refactoring." },
	],
	usage: { input: 600, output: 200 },
});

/** A tool result message */
const TOOL_RESULT_MESSAGE = JSON.stringify({
	type: "message",
	role: "toolResult",
	id: "msg-4",
	parentId: "msg-2",
	toolName: "read",
	content: [{ type: "text", text: "File contents..." }],
});

/** A compaction entry (should be skipped) */
const COMPACTION_ENTRY = JSON.stringify({
	type: "compaction",
	summary: "Context truncated",
});

/** Malformed JSON line */
const MALFORMED_LINE = "not json at all";

// ─── Tests ─────────────────────────────────────────────────────────

await describe("replaySessionFile", async () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// cleanup best-effort
			}
		}
	});

	await it("reads a session JSONL file and sends replay message", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [SESSION_HEADER, USER_MESSAGE, ASSISTANT_MESSAGE]);
		const pi = createMockPi();

		const result = await replaySessionFile(filePath, pi, "developer");

		assert.equal(result, true);
		assert.equal(pi.sendMessageCalls.length, 1);
		const msg = pi.sendMessageCalls[0];
		assert.equal(msg.customType, "supervisor");
		assert.equal(msg.details.eventType, "subagent-result");
		assert.ok(msg.content.includes("Replay: developer session"));
		assert.ok(msg.content.includes("Here is my implementation plan."));
	});

	await it("skips non-message entries (compaction, session header, etc.)", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			COMPACTION_ENTRY,
			ASSISTANT_MESSAGE,
		]);
		const pi = createMockPi();

		const result = await replaySessionFile(filePath, pi, "test-agent");

		assert.equal(result, true);
		assert.equal(pi.sendMessageCalls.length, 1);
		// Only one message entry, no compaction noise in output
		assert.ok(pi.sendMessageCalls[0].content.includes("Here is my implementation plan."));
	});

	await it("returns false for empty or missing session file", async () => {
		const pi = createMockPi();

		const result1 = await replaySessionFile(undefined, pi);
		assert.equal(result1, false);
		assert.equal(pi.sendMessageCalls.length, 0);

		const result2 = await replaySessionFile("/nonexistent/path.jsonl", pi);
		assert.equal(result2, false);
		assert.equal(pi.sendMessageCalls.length, 0);
	});

	await it("returns false when session file has no message entries", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			COMPACTION_ENTRY,
			JSON.stringify({ type: "model_change", model: "claude" }),
		]);
		const pi = createMockPi();

		const result = await replaySessionFile(filePath, pi);
		assert.equal(result, false);
		assert.equal(pi.sendMessageCalls.length, 0);
	});

	await it("skips malformed JSON lines gracefully", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			MALFORMED_LINE,
			ASSISTANT_MESSAGE,
			MALFORMED_LINE,
		]);
		const pi = createMockPi();

		const result = await replaySessionFile(filePath, pi, "dev");
		assert.equal(result, true);
		assert.equal(pi.sendMessageCalls.length, 1);
	});

	await it("handles assistant messages with thinking blocks", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [SESSION_HEADER, ASSISTANT_THINKING_MESSAGE]);
		const pi = createMockPi();

		const result = await replaySessionFile(filePath, pi, "architect");

		assert.equal(result, true);
		assert.equal(pi.sendMessageCalls.length, 1);
		const content = pi.sendMessageCalls[0].content;
		assert.ok(content.includes("Let me think about this carefully") || content.includes("💭"));
		assert.ok(content.includes("refactoring"));
	});

	await it("handles user and toolResult messages", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			USER_MESSAGE,
			ASSISTANT_MESSAGE,
			TOOL_RESULT_MESSAGE,
		]);
		const pi = createMockPi();

		const result = await replaySessionFile(filePath, pi, "developer");
		assert.equal(result, true);
		// Should have assistant message content
		assert.ok(pi.sendMessageCalls[0].content.includes("Here is my implementation plan."));
	});

	await it("extracts usage stats and includes them in the replay header", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [SESSION_HEADER, ASSISTANT_MESSAGE]);
		const pi = createMockPi();

		await replaySessionFile(filePath, pi, "developer");

		const content = pi.sendMessageCalls[0].content;
		assert.ok(content.includes("1 turn"));
		assert.ok(content.includes("↑500 ↓150"));
	});

	await it("uses empty agentName when not provided", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [SESSION_HEADER, ASSISTANT_MESSAGE]);
		const pi = createMockPi();

		await replaySessionFile(filePath, pi);

		const content = pi.sendMessageCalls[0].content;
		assert.ok(!content.includes("Replay: replay"));
	});

	await it("respects maxLines limit", async () => {
		tmpDir = createTempDir();
		// Create many message entries to exceed the line limit
		const entries = [SESSION_HEADER];
		for (let i = 0; i < 10; i++) {
			entries.push(
				JSON.stringify({
					type: "message",
					role: "assistant",
					id: `msg-${i}`,
					content: [{ type: "text", text: `Line ${i}\ncontinuation` }],
				}),
			);
		}
		const filePath = createSessionFile(tmpDir, entries);
		const pi = createMockPi();

		await replaySessionFile(filePath, pi, "dev", 3);

		const content = pi.sendMessageCalls[0].content;
		// Should have at most 3 lines worth of content in the replay parts
		const lines = content.split("\n");
		const replaySectionIdx = lines.findIndex((l: string) => l.startsWith("📋 Replay:"));
		const replayLines = lines.slice(replaySectionIdx + 1);
		assert.ok(replayLines.filter((l: string) => l.trim()).length < 30, "should be limited");
	});
});
