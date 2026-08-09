/**
 * Tests for session-logger/files.ts — non-blocking symlink creation
 *
 * Phase 4: ensureLatestLink creates symlink immediately (may dangle),
 * background retry fixes it when target appears.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-dangling.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { ensureSymlink } from "../files.ts";

// ---------------------------------------------------------------------------
// Phase 4: non-blocking ensureSymlink background retry
// ---------------------------------------------------------------------------

describe("ensureSymlink background retry (non-blocking)", () => {
	let tmpDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-dangling-"));
		sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ensureSymlink with target file already present creates symlink immediately", async () => {
		const sessionFile = path.join(sessionsDir, "session-present.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		await ensureSymlink(sessionsDir, sessionFile, "latest.jsonl");

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "should be symlink");
		assert.ok(fs.existsSync(latestLink), "target should be reachable");
	});

	it("ensureSymlink with target file created after delay: non-blocking, background retry resolves symlink", async () => {
		const sessionFile = path.join(sessionsDir, "session-delayed.jsonl");

		// ensureSymlink returns immediately (non-blocking)
		await ensureSymlink(sessionsDir, sessionFile, "latest.jsonl");

		// Symlink exists but is dangling
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "should be symlink");
		assert.ok(!fs.existsSync(latestLink), "symlink initially dangling");

		// Create file — background retry will fix symlink
		fs.writeFileSync(sessionFile, "{}");

		// Wait for background retry (interval 200ms, retries every 200ms)
		await new Promise<void>((resolve) => setTimeout(resolve, 500));

		assert.ok(fs.existsSync(latestLink), "symlink resolved after background retry");
	});

	it("ensureSymlink with target file that never appears: creates dangling symlink, no throw", async () => {
		const sessionFile = path.join(sessionsDir, "session-never-exists.jsonl");

		// Returns immediately (non-blocking), no error
		await ensureSymlink(sessionsDir, sessionFile, "latest.jsonl");

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "dangling symlink created");
		assert.ok(!fs.existsSync(latestLink), "symlink remains dangling");
	});

	it("ensureSymlink concurrent calls: both return immediately, background retry resolves", async () => {
		const sessionFile = path.join(sessionsDir, "session-concurrent.jsonl");

		// Both return immediately
		await Promise.all([
			ensureSymlink(sessionsDir, sessionFile, "latest.jsonl"),
			ensureSymlink(sessionsDir, sessionFile, "latest.jsonl"),
		]);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink exists after concurrent calls");

		// Create file
		fs.writeFileSync(sessionFile, "{}");

		// Wait for background retry
		await new Promise<void>((resolve) => setTimeout(resolve, 500));

		assert.ok(fs.existsSync(latestLink), "symlink resolved after background retry");
	});

	it("ensureSymlink full lifecycle: session_start non-blocking + session_shutdown (file exists) creates valid symlink", async () => {
		const sessionFile = path.join(sessionsDir, "session-lifecycle.jsonl");

		// Simulate session_start: ensureSymlink called before file exists
		await ensureSymlink(sessionsDir, sessionFile, "latest.jsonl");

		// Simulate subprocess writing file
		fs.writeFileSync(sessionFile, "{}");

		// Wait for background retry
		await new Promise<void>((resolve) => setTimeout(resolve, 500));

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "latest.jsonl should be symlink");
		assert.ok(fs.existsSync(latestLink), "latest.jsonl target should resolve");

		// Simulate session_shutdown: create .md file and its symlink
		const mdFile = path.join(sessionsDir, "session-lifecycle.md");
		fs.writeFileSync(mdFile, "# Lifecycle Report");
		await ensureSymlink(sessionsDir, mdFile, "latest.md");

		const latestMd = path.join(sessionsDir, "latest.md");
		assert.ok(fs.lstatSync(latestMd).isSymbolicLink(), "latest.md should be symlink");
		assert.ok(fs.existsSync(latestMd), "latest.md target should resolve");
	});

	it("ensureSymlink with delayed md file creation: non-blocking, background retry resolves", async () => {
		const mdFile = path.join(sessionsDir, "session-delayed.md");

		await ensureSymlink(sessionsDir, mdFile, "latest.md");

		const latestLink = path.join(sessionsDir, "latest.md");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink created");
		assert.ok(!fs.existsSync(latestLink), "symlink initially dangling");

		fs.writeFileSync(mdFile, "# Delayed report");

		await new Promise<void>((resolve) => setTimeout(resolve, 500));

		assert.ok(fs.existsSync(latestLink), "symlink resolved after retry");
	});

	it("ensureSymlink with delayed metadata file: non-blocking, background retry resolves", async () => {
		const metaFile = path.join(sessionsDir, "session-delayed.metadata.json");

		await ensureSymlink(sessionsDir, metaFile, "latest.metadata.json");

		const latestLink = path.join(sessionsDir, "latest.metadata.json");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink created");
		assert.ok(!fs.existsSync(latestLink), "symlink initially dangling");

		fs.writeFileSync(metaFile, "{}");

		await new Promise<void>((resolve) => setTimeout(resolve, 500));

		assert.ok(fs.existsSync(latestLink), "symlink resolved after retry");
	});

	it("ensureSymlink creates sessions dir if missing", async () => {
		const freshDir = path.join(tmpDir, "fresh", "sessions");
		const sessionFile = path.join(freshDir, "session.jsonl");

		// Dir doesn't exist yet — create dir, write file, then test ensureSymlink creates link dir
		fs.mkdirSync(freshDir, { recursive: true });
		fs.writeFileSync(sessionFile, "{}");

		const otherDir = path.join(tmpDir, "other", "sessions");
		assert.ok(!fs.existsSync(otherDir), "other dir should not exist before call");
		await ensureSymlink(otherDir, sessionFile, "latest.jsonl");
		assert.ok(fs.existsSync(otherDir), "other dir should exist after call");

		const latestLink = path.join(otherDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink created");
		assert.ok(fs.existsSync(latestLink), "target reachable");
	});

	it("background retry fixes symlink when file appears before first retry", async () => {
		const sessionFile = path.join(sessionsDir, "session-early.jsonl");

		await ensureSymlink(sessionsDir, sessionFile, "latest.jsonl");

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(!fs.existsSync(latestLink), "dangling initially");

		// Create file before retry fires (retry interval is 200ms)
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		fs.writeFileSync(sessionFile, "{}");

		// Wait for retry to pick it up
		await new Promise<void>((resolve) => setTimeout(resolve, 400));

		assert.ok(fs.existsSync(latestLink), "symlink resolved");
	});
});
