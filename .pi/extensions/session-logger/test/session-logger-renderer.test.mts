/**
 * Tests for session-logger/renderer.ts — supervisor custom message details
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-renderer.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { renderSessionToMarkdown } from "../renderer.ts";

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — supervisor custom entry rendering
// ---------------------------------------------------------------------------

describe("renderSessionToMarkdown — supervisor custom entries", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-renderer-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("renders supervisor custom entry with full details (developer agent)", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-session-001",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:01:00Z",
				data: {},
				details: {
					agentName: "developer",
					statusLabel: "SUCCESS",
					toolCount: 3,
					tokenCount: 12000,
					durationMs: 84000,
					thinkingOutput: "First thinking block line 1\nFirst thinking block line 2",
					hasThinking: true,
					textOutput:
						"read(path=src/main.py)\nsrc/main.py -- 2KB\n\nedit(path=src/main.py)\nsrc/main.py -- edit applied",
					rawOutput: "Full raw session output here with many lines...",
					hasRawOutput: true,
					auditScore: 4.5,
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);

		// Agent header with name, status, tool count, token count, duration
		assert.ok(md.includes("### Agent: developer"), "Should include agent name header");
		assert.ok(md.includes("SUCCESS"), "Should include status label");
		assert.ok(md.includes("3 tools") || md.includes("3 tool"), "Should include tool count");
		assert.ok(md.includes("12K"), "Should include token count");

		// Thinking blocks visible
		assert.ok(md.includes("First thinking block line 1"), "Should include thinking block lines");
		assert.ok(
			md.includes("First thinking block line 2"),
			"Should include second thinking block line",
		);

		// Tool calls and results visible
		assert.ok(
			md.includes("read") && md.includes("src/main.py"),
			"Should include tool output with file paths",
		);
		assert.ok(
			md.includes("edit") && md.includes("edit applied"),
			"Should include edit tool result",
		);

		// Raw output — collapsed section or preview
		assert.ok(
			md.includes("raw") || md.includes("Raw") || md.includes("rawOutput"),
			"Should include raw output section",
		);

		// Audit score
		assert.ok(md.includes("4.5"), "Should include audit score");
	});

	it("renders supervisor custom entry with failed agent", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-session-002",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:02:00Z",
				details: {
					agentName: "test-designer",
					statusLabel: "FAILED",
					toolCount: 1,
					tokenCount: 5000,
					durationMs: 30000,
					thinkingOutput: "",
					hasThinking: false,
					textOutput: "Error: test assertion failed",
					rawOutput: "",
					hasRawOutput: false,
					auditScore: 0,
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);

		assert.ok(md.includes("### Agent: test-designer"), "Should include agent name");
		assert.ok(md.includes("FAILED"), "Should include FAILED status");
		assert.ok(md.includes("Error"), "Should include error output");
	});

	it("renders non-supervisor custom entries unchanged (fallthrough)", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-session-003",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "my-plugin",
				timestamp: "2025-06-01T10:03:00Z",
				data: { key: "value" },
			},
		]);

		const md = renderSessionToMarkdown(filepath);

		// Non-supervisor custom entries should render as before
		assert.ok(
			md.includes("> *my-plugin*"),
			"Non-supervisor custom entry should render with customType marker",
		);
		assert.ok(
			md.includes("value") || md.includes('"key"'),
			"Non-supervisor custom entry should include data",
		);
	});

	it("renders supervisor custom entry without details gracefully", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-session-004",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:04:00Z",
				// No details field — should fall through to default custom handling
			},
		]);

		const md = renderSessionToMarkdown(filepath);

		// Should fall through to default custom handling
		assert.ok(
			md.includes("> *supervisor*"),
			"Supervisor without details should render as regular custom entry",
		);
	});

	it("renders supervisor entry with minimal details (only agentName)", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-session-005",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:05:00Z",
				details: {
					agentName: "auditor",
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);

		assert.ok(
			md.includes("### Agent: auditor"),
			"Should render agent name even with minimal details",
		);
		// Supervisor context is distinguished by ### Agent: heading level
		assert.ok(
			md.includes("### Agent:"),
			"Should use agent heading level to distinguish from primary turns",
		);
	});

	it("multiple supervisor entries all render with distinct agents", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-session-006",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:06:00Z",
				details: {
					agentName: "developer",
					statusLabel: "SUCCESS",
					toolCount: 2,
					tokenCount: 8000,
					durationMs: 60000,
					hasThinking: false,
					hasRawOutput: false,
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:07:00Z",
				details: {
					agentName: "auditor",
					statusLabel: "SUCCESS",
					toolCount: 1,
					tokenCount: 3000,
					durationMs: 20000,
					hasThinking: false,
					hasRawOutput: false,
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);

		assert.ok(md.includes("### Agent: developer"), "First agent should render");
		assert.ok(md.includes("### Agent: auditor"), "Second agent should render");
	});

	it("primary conversation turns still render correctly alongside supervisor entries", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-session-007",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:01:00Z",
				details: {
					agentName: "developer",
					statusLabel: "SUCCESS",
					toolCount: 1,
					tokenCount: 1000,
					durationMs: 10000,
					hasThinking: false,
					hasRawOutput: false,
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);

		assert.ok(md.includes("### Agent: developer"), "Supervisor agent should render");
		assert.ok(md.includes("Hello"), "User message should still render");
		assert.ok(md.includes("### Turn"), "Turn heading should still render");
	});
});

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — no-regression: existing custom message format
// ---------------------------------------------------------------------------

describe("renderSessionToMarkdown — existing custom message handling (no regression)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-renderer-nr-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("custom entry with data renders as > *type* — data", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-nr-001",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "my-extension",
				data: { result: "ok" },
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("> *my-extension*"));
		assert.ok(md.includes("ok") || md.includes("result"));
	});

	it("custom entry without data still renders", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-nr-002",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "custom",
				customType: "quiet-plugin",
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("> *quiet-plugin*"));
	});

	it("model_change and thinking_level_change entries still render", () => {
		const filepath = writeJsonl([
			{
				type: "session",
				id: "test-nr-003",
				timestamp: "2025-06-01T10:00:00Z",
				cwd: "/tmp",
				version: "1.0",
			},
			{
				type: "model_change",
				timestamp: "t1",
				provider: "openai",
				modelId: "gpt-4",
			},
			{
				type: "thinking_level_change",
				timestamp: "t2",
				thinkingLevel: "high",
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("openai/gpt-4"));
		assert.ok(md.includes("high"));
	});

	it("empty session returns *Empty session*", () => {
		const filepath = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(filepath, "", "utf-8");
		const md = renderSessionToMarkdown(filepath);
		assert.strictEqual(md, "*Empty session*");
	});

	it("session with only whitespace returns *Empty session*", () => {
		const filepath = path.join(tmpDir, "whitespace.jsonl");
		fs.writeFileSync(filepath, "   \n  \n  ", "utf-8");
		const md = renderSessionToMarkdown(filepath);
		assert.strictEqual(md, "*Empty session*");
	});
});

// ---------------------------------------------------------------------------
// parseSessionStats — perTurnTokens characterization (migration safety)
// ---------------------------------------------------------------------------
