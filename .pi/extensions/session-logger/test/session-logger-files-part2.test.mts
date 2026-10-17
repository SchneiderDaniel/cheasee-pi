import assert from "node:assert";

import fs from "node:fs";

import os from "node:os";

import path from "node:path";

import { describe, it, beforeEach, afterEach } from "node:test";

import { ensureSymlink, writeMetadata, writeSessionReport } from "../files.ts";

import type { Metadata } from "../types.ts";

describe("files.ts module functions", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-files-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	it("old stale sessions.md (derived from dir basename) is NOT created", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		// sessionDir basename is "sessions" — old code would create "sessions.md"

		await writeSessionReport(sessionDir, "sid-d", "markdown content");

		const stalePath = path.join(sessionDir, "sessions.md");
		assert.ok(!fs.existsSync(stalePath), "sessions.md (from dir basename) should NOT exist");
	});
	it("writeMetadata with empty-string sessionId produces .metadata.json", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta: Metadata = {
			sessionId: "",
			messages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};

		await writeMetadata(sessionDir, "", meta);

		const metaPath = path.join(sessionDir, ".metadata.json");
		assert.ok(fs.existsSync(metaPath), "Empty sessionId should produce .metadata.json");
	});
	it("writeSessionReport with empty-string sessionId produces .md", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		await writeSessionReport(sessionDir, "", "empty-id");

		const mdPath = path.join(sessionDir, ".md");
		assert.ok(fs.existsSync(mdPath), "Empty sessionId should produce .md");
		assert.strictEqual(fs.readFileSync(mdPath, "utf-8"), "empty-id");
	});
	it("writeMetadata JSON roundtrips with full Metadata object", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionId = "roundtrip-test";

		const meta: Metadata = {
			sessionId,
			name: "Round Trip",
			messages: 42,
			tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, total: 1650 },
			cost: 0.025,
			compactions: 3,
			modelChanges: [
				{ time: "2025-01-01T00:00:00Z", model: "openai/gpt-4" },
				{ time: "2025-01-01T01:00:00Z", model: "anthropic/claude-3" },
			],
			thinkingChanges: [
				{ time: "2025-01-01T00:00:00Z", level: "low" },
				{ time: "2025-01-01T01:00:00Z", level: "high" },
			],
			perTurnTokens: [
				{ turnIndex: 0, tokens: 500, cost: 0.005, toolCount: 2, errorCount: 0 },
				{ turnIndex: 1, tokens: 1000, cost: 0.015, toolCount: 3, errorCount: 1 },
			],
			toolStats: {
				read: { calls: 5, errors: 0, totalDurationMs: 1200 },
				write: { calls: 3, errors: 1, totalDurationMs: 800 },
			},
			fileModifications: [
				{ action: "read", path: "/file1", timestamp: "2025-01-01T00:00:00Z" },
				{ action: "write", path: "/file2", timestamp: "2025-01-01T00:01:00Z", size: 500 },
			],
		};

		await writeMetadata(sessionDir, sessionId, meta);

		const metaPath = path.join(sessionDir, `${sessionId}.metadata.json`);
		const loaded: Metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.deepStrictEqual(loaded, meta);
	});
	it("ensureSymlink creates non-existent sessionsDir", async () => {
		const targetDir = path.join(tmpDir, "target");
		const linkDir = path.join(tmpDir, "nonexistent");
		const sessionFile = path.join(targetDir, "session.jsonl");
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(sessionFile, "{}");

		assert.ok(!fs.existsSync(linkDir), "dir should not exist before");
		await ensureSymlink(linkDir, sessionFile, "latest.jsonl");
		assert.ok(fs.existsSync(linkDir), "dir should exist after");

		const latestLink = path.join(linkDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink should exist");
		assert.ok(fs.existsSync(latestLink), "target should be reachable");
	});
	it("ensureSymlink creates non-existent dir for latest.md", async () => {
		const targetDir = path.join(tmpDir, "target");
		const linkDir = path.join(tmpDir, "nonexistent");
		const mdFile = path.join(targetDir, "session.md");
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(mdFile, "# test");

		assert.ok(!fs.existsSync(linkDir), "dir should not exist before");
		await ensureSymlink(linkDir, mdFile, "latest.md");
		assert.ok(fs.existsSync(linkDir), "dir should exist after");

		const latestLink = path.join(linkDir, "latest.md");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink should exist");
		assert.ok(fs.existsSync(latestLink), "target should be reachable");
	});
	it("ensureSymlink creates non-existent dir for latest.metadata.json", async () => {
		const targetDir = path.join(tmpDir, "target");
		const linkDir = path.join(tmpDir, "nonexistent");
		const metaFile = path.join(targetDir, "session.metadata.json");
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(metaFile, "{}");

		assert.ok(!fs.existsSync(linkDir), "dir should not exist before");
		await ensureSymlink(linkDir, metaFile, "latest.metadata.json");
		assert.ok(fs.existsSync(linkDir), "dir should exist after");

		const latestLink = path.join(linkDir, "latest.metadata.json");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink should exist");
		assert.ok(fs.existsSync(latestLink), "target should be reachable");
	});
	it("ensureSymlink creates relative symlink (not absolute)", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-abc.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		await ensureSymlink(sessionsDir, sessionFile, "latest.jsonl");

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		const target = fs.readlinkSync(latestLink);
		// Target should be relative (not starting with /)
		assert.ok(!path.isAbsolute(target), `symlink target ${target} should be relative`);
	});
});
