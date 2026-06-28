// ─── Tests: pipeline/thinking-mismatch.ts — detectThinkingLevelMismatch ─
// Phase 0 + Phase 2: verifies that configured vs effective thinking level
// mismatches are detected correctly from session JSONL files.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Import the module under test ──────────────────────────────────

const { detectThinkingLevelMismatch } = await import(
	"../../pipeline/thinking-mismatch.ts"
);

// ─── Helpers ───────────────────────────────────────────────────────

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "thinking-mismatch-test-"));
}

function createSessionFile(dir: string, lines: string[]): string {
	const filePath = join(dir, "session.jsonl");
	writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
	return filePath;
}

// ─── Fixtures ──────────────────────────────────────────────────────

const SESSION_HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "test-session",
	timestamp: new Date().toISOString(),
	cwd: "/repo",
});

function thinkingChange(level: string, id = "tc-1"): string {
	return JSON.stringify({
		type: "thinking_level_change",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		thinkingLevel: level,
	});
}

const USER_MESSAGE = JSON.stringify({
	type: "message",
	role: "user",
	id: "msg-1",
	parentId: null,
	timestamp: new Date().toISOString(),
	content: [{ type: "text", text: "Hello" }],
});

const MODEL_CHANGE = JSON.stringify({
	type: "model_change",
	id: "mc-1",
	parentId: null,
	timestamp: new Date().toISOString(),
	provider: "anthropic",
	modelId: "claude-sonnet-4-20250514",
});

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

await describe("detectThinkingLevelMismatch", async () => {
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

	await it("returns null when sessionPath is undefined", async () => {
		const result = detectThinkingLevelMismatch(undefined, "medium");
		assert.equal(result, null);
	});

	await it("returns null when sessionPath file doesn't exist", async () => {
		const result = detectThinkingLevelMismatch("/nonexistent/path.jsonl", "medium");
		assert.equal(result, null);
	});

	await it("returns null when configuredLevel is undefined", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			thinkingChange("high"),
		]);
		const result = detectThinkingLevelMismatch(filePath, undefined);
		assert.equal(result, null);
	});

	await it("returns null when configured level matches effective level", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			thinkingChange("high"),
		]);
		const result = detectThinkingLevelMismatch(filePath, "high");
		assert.equal(result, null);
	});

	await it("returns mismatch when configured level differs from effective level", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			thinkingChange("high"),
		]);
		const result = detectThinkingLevelMismatch(filePath, "medium");
		assert.notEqual(result, null);
		assert.equal(result!.configured, "medium");
		assert.equal(result!.effective, "high");
	});

	await it("returns mismatch for medium → off clamping", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			thinkingChange("off"),
		]);
		const result = detectThinkingLevelMismatch(filePath, "medium");
		assert.notEqual(result, null);
		assert.equal(result!.configured, "medium");
		assert.equal(result!.effective, "off");
	});

	await it("uses the first thinking_level_change entry (session start level)", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			thinkingChange("high", "tc-1"),
			USER_MESSAGE,
			// A second change mid-session — not relevant for start-level check
			thinkingChange("xhigh", "tc-2"),
		]);
		const result = detectThinkingLevelMismatch(filePath, "medium");
		assert.notEqual(result, null);
		assert.equal(result!.configured, "medium");
		assert.equal(result!.effective, "high");
	});

	await it("returns null when no thinking_level_change entry exists", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			MODEL_CHANGE,
			USER_MESSAGE,
		]);
		const result = detectThinkingLevelMismatch(filePath, "medium");
		assert.equal(result, null);
	});

	await it("returns null for empty session file", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, []);
		const result = detectThinkingLevelMismatch(filePath, "medium");
		assert.equal(result, null);
	});

	await it("handles session file with only a header (no thinking_level_change)", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [SESSION_HEADER]);
		const result = detectThinkingLevelMismatch(filePath, "medium");
		assert.equal(result, null);
	});

	await it("detects mismatch when effective level appears after model change", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			MODEL_CHANGE,
			thinkingChange("xhigh"),
		]);
		const result = detectThinkingLevelMismatch(filePath, "high");
		assert.notEqual(result, null);
		assert.equal(result!.configured, "high");
		assert.equal(result!.effective, "xhigh");
	});

	await it("returns ThinkingMismatch with correct shape", async () => {
		tmpDir = createTempDir();
		const filePath = createSessionFile(tmpDir, [
			SESSION_HEADER,
			thinkingChange("off"),
		]);
		const result = detectThinkingLevelMismatch(filePath, "medium");
		assert.notEqual(result, null);
		assert.ok(typeof result!.configured === "string");
		assert.ok(typeof result!.effective === "string");
	});
});
