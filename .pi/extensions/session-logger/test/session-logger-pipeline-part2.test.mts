/**
 * Tests for session-logger/pipeline.ts — LoggerPipeline class
 *
 * Verifies that event handlers delegate correctly to stats/file tracking.
 * Uses real temp directories for filesystem assertions.
 * Stats aggregation is tested in session-logger-stats.test.mts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-pipeline.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { LoggerPipeline } from "../pipeline.ts";
import type { SessionLoggerGate } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGate(enabled = true): SessionLoggerGate {
	return { enabledForNextSession: enabled, sessionEnabled: enabled };
}

/**
 * Create a mock sessionManager with a real temp dir backing.
 * Writes an empty session file at the returned path.
 */
function createSessionManager(
	tmpDir: string,
	overrides?: {
		sessionFile?: string;
		cwd?: string;
		entries?: any[];
	},
): any {
	const sessionsDir = path.join(tmpDir, ".pi", "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const sessionFile = overrides?.sessionFile ?? path.join(sessionsDir, "session-test.jsonl");
	if (!fs.existsSync(sessionFile)) {
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				id: "test",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
				version: 1,
			}) + "\n",
		);
	}

	return {
		getSessionFile: () => sessionFile,
		getCwd: () => overrides?.cwd ?? tmpDir,
		getBranch: () => overrides?.entries ?? [],
	};
}

// ---------------------------------------------------------------------------
// beginSession
// ---------------------------------------------------------------------------

// Split from session-logger-pipeline.test.mts (issue #2035 Long File refactor).
describe("LoggerPipeline onSessionShutdown — FS assertions", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-pipeline-shutdown-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("with valid session — produces .md, .metadata.json and symlinks on disk", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		// First start a session
		const ctx = {
			sessionManager: createSessionManager(tmpDir),
		};
		await pipeline.onSessionStart({}, ctx as any);

		const shutdownCtx = {
			sessionManager: {
				getSessionFile: () => ctx.sessionManager.getSessionFile(),
			},
		};

		// Call some handlers to generate stats data
		pipeline.onSessionCompact();
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });

		// Shutdown
		await pipeline.onSessionShutdown({}, shutdownCtx as any);

		// Verify files exist on disk
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = path.dirname(sessionFile);
		const sessionPrefix = path.basename(sessionFile, ".jsonl");

		const metaPath = path.join(sessionDir, `${sessionPrefix}.metadata.json`);
		const mdPath = path.join(sessionDir, `${sessionPrefix}.md`);

		assert.ok(fs.existsSync(metaPath), "metadata.json should exist on disk");
		assert.ok(fs.existsSync(mdPath), ".md report should exist on disk");

		// Verify symlinks
		const latestMd = path.join(sessionDir, "latest.md");
		const latestMeta = path.join(sessionDir, "latest.metadata.json");
		assert.ok(fs.lstatSync(latestMd).isSymbolicLink(), "latest.md should be symlink");
		assert.ok(fs.lstatSync(latestMeta).isSymbolicLink(), "latest.metadata.json should be symlink");

		// Verify metadata content
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.ok(meta.sessionId, "metadata should have sessionId");
		assert.ok(Array.isArray(meta.modelChanges), "metadata should have modelChanges");
	});

	it("gate disabled — no files generated", async () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);

		const sessionFile = path.join(tmpDir, "session-test.jsonl");
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				id: "test",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
				version: 1,
			}) + "\n",
		);

		const shutdownCtx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
			},
		};

		await pipeline.onSessionShutdown({}, shutdownCtx as any);

		const sessionDir = path.dirname(sessionFile);
		const sessionPrefix = path.basename(sessionFile, ".jsonl");
		assert.ok(
			!fs.existsSync(path.join(sessionDir, `${sessionPrefix}.metadata.json`)),
			"metadata should NOT exist",
		);
		assert.ok(!fs.existsSync(path.join(sessionDir, `${sessionPrefix}.md`)), "md should NOT exist");
	});

	it("sessionFile undefined — graceful no-op", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		const shutdownCtx = {
			sessionManager: {
				getSessionFile: () => undefined,
			},
		};

		await pipeline.onSessionShutdown({}, shutdownCtx as any);
		// Should not throw
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — full lifecycle integration with tmpdir
// ---------------------------------------------------------------------------

describe("LoggerPipeline — full lifecycle", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-lifecycle-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("start -> handlers -> shutdown produces all session files", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-lifecycle.jsonl");
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				id: "lifecycle-test",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
				version: 1,
			}) + "\n",
		);

		const ctx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getCwd: () => tmpDir,
				getBranch: () => [],
			},
		};

		// Start session
		await pipeline.onSessionStart({}, ctx as any);

		// Verify latest.jsonl symlink
		const latestJsonl = path.join(sessionsDir, "latest.jsonl");
		assert.ok(
			fs.lstatSync(latestJsonl).isSymbolicLink(),
			"latest.jsonl symlink exists after start",
		);

		// Call various handlers
		pipeline.onSessionCompact();
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });
		pipeline.onThinkingLevelSelect({ level: "high" });
		pipeline.onTurnStart({ turnIndex: 0 });
		pipeline.onMessageEnd({
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.002 } },
			},
		});
		pipeline.onToolExecutionStart({ toolCallId: "call-1", toolName: "bash" });
		pipeline.onToolExecutionEnd({
			toolCallId: "call-1",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		pipeline.onTurnEnd();

		// Shutdown
		const shutdownCtx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
			},
		};
		await pipeline.onSessionShutdown({}, shutdownCtx as any);

		// Verify all files exist
		const prefix = path.join(sessionsDir, "session-lifecycle");
		assert.ok(fs.existsSync(`${prefix}.jsonl`), "jsonl exists");
		assert.ok(fs.existsSync(`${prefix}.metadata.json`), "metadata.json exists");
		assert.ok(fs.existsSync(`${prefix}.md`), ".md exists");

		// Verify symlinks
		assert.ok(
			fs.lstatSync(path.join(sessionsDir, "latest.jsonl")).isSymbolicLink(),
			"latest.jsonl symlink",
		);
		assert.ok(
			fs.lstatSync(path.join(sessionsDir, "latest.md")).isSymbolicLink(),
			"latest.md symlink",
		);
		assert.ok(
			fs.lstatSync(path.join(sessionsDir, "latest.metadata.json")).isSymbolicLink(),
			"latest.metadata.json symlink",
		);

		// No tmp leftovers
		const tmpFiles = fs.readdirSync(sessionsDir).filter((f) => f.includes(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files left");
	});

	it("with overrides (sessionName, mode) — metadata.json contains name and mode", async () => {
		const gate = createGate(true);
		const pipeline = new LoggerPipeline(gate);

		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-override.jsonl");
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				id: "override-test",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
				version: 1,
			}) + "\n",
		);

		const ctx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getCwd: () => tmpDir,
				getBranch: () => [],
			},
		};

		// Start with overrides
		await pipeline.onSessionStart({}, ctx as any, {
			sessionName: "fix-bug-123",
			mode: "tui",
		});

		// Shutdown
		const shutdownCtx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
			},
		};
		await pipeline.onSessionShutdown({}, shutdownCtx as any);

		// Verify metadata contains overrides
		const metaPath = path.join(sessionsDir, "session-override.metadata.json");
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.strictEqual(meta.name, "fix-bug-123", "metadata should have session name from override");
		assert.strictEqual(meta.mode, "tui", "metadata should have mode from override");
	});

	it("gate disabled — no files created during lifecycle", async () => {
		const gate = createGate(false);
		const pipeline = new LoggerPipeline(gate);

		const sessionFile = path.join(tmpDir, "session-disabled.jsonl");

		const ctx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getCwd: () => tmpDir,
				getBranch: () => [],
			},
		};

		await pipeline.onSessionStart({}, ctx as any);
		pipeline.onSessionCompact();
		pipeline.onModelSelect({ model: { provider: "openai", id: "gpt-4" } });

		const shutdownCtx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
			},
		};
		await pipeline.onSessionShutdown({}, shutdownCtx as any);

		// No files should be created
		const sessionDir = path.dirname(sessionFile);
		const entries = fs.readdirSync(sessionDir);
		assert.strictEqual(entries.length, 0, "No files should exist when gate is disabled");
	});
});

// ---------------------------------------------------------------------------
// LoggerPipeline — nested call attribution (id-derived) + file-mod guard
// ---------------------------------------------------------------------------

describe("LoggerPipeline — nested call attribution and file-mod guard", () => {
	function snapshot(pipeline: LoggerPipeline) {
		return (pipeline as any).stats.getSnapshot();
	}

	it("tracks a top-level file read in fileModifications", () => {
		const pipeline = new LoggerPipeline(createGate(true));
		pipeline.onToolCall({ toolName: "read", input: { path: "/a" } });
		const mods = snapshot(pipeline).fileModifications;
		assert.strictEqual(mods.length, 1);
		assert.strictEqual(mods[0].action, "read");
		assert.strictEqual(mods[0].path, "/a");
	});

	it("skips nested file ops (parentToolCallId set) — no phantom file rows", () => {
		const pipeline = new LoggerPipeline(createGate(true));
		pipeline.onToolCall({ toolName: "read", input: { path: "/a" } });
		pipeline.onToolCall({
			toolName: "read",
			input: { path: "/b" },
			parentToolCallId: "codemode_1",
		});
		const mods = snapshot(pipeline).fileModifications;
		assert.strictEqual(mods.length, 1, "only the top-level read is recorded");
		assert.strictEqual(mods[0].path, "/a");
	});

	it("tags a nested exec with its derived parent even though the event carries no parentToolCallId", () => {
		const pipeline = new LoggerPipeline(createGate(true));
		pipeline.onToolExecutionStart({ toolCallId: "codemode_1/1", toolName: "read" });
		const execs = snapshot(pipeline).toolExecutions;
		assert.strictEqual(execs.length, 1);
		assert.strictEqual(execs[0].parentToolCallId, "codemode_1");
	});
});
