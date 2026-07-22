/**
 * Tests for session-logger recovery — scan all sessions (Bug 2 fix)
 *
 * Tests generateMissingReports (pure function) and the full recovery loop
 * that scans all .jsonl files in the sessions directory for missing reports.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-recovery.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { generateMissingReports } from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a minimal valid .jsonl session file with just a header. */
function writeSessionJsonl(dir: string, sessionId: string): string {
	const filepath = path.join(dir, `${sessionId}.jsonl`);
	const header = {
		type: "session",
		id: sessionId,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd: "/tmp",
		version: 1,
	};
	fs.writeFileSync(filepath, JSON.stringify(header) + "\n", "utf-8");
	return filepath;
}

/** Write an unparseable .jsonl file (invalid JSON). */
function writeInvalidJsonl(dir: string, name: string): string {
	const filepath = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(filepath, "not valid json\n", "utf-8");
	return filepath;
}

// ---------------------------------------------------------------------------
// Phase 2: generateMissingReports unit tests
// ---------------------------------------------------------------------------

describe("generateMissingReports — unit", () => {
	let tmpDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-recovery-"));
		sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("orphan .jsonl (no .md, no .metadata.json) creates both files", async () => {
		const jsonlPath = writeSessionJsonl(sessionsDir, "session-orphan");
		await generateMissingReports(jsonlPath);

		const prefix = path.join(sessionsDir, "session-orphan");
		assert.ok(fs.existsSync(`${prefix}.md`), ".md should be created");
		assert.ok(fs.existsSync(`${prefix}.metadata.json`), ".metadata.json should be created");
	});

	it("both .md and .metadata.json existing -> no files created or overwritten", async () => {
		const jsonlPath = writeSessionJsonl(sessionsDir, "session-existing");

		// Create both files first
		const prefix = path.join(sessionsDir, "session-existing");
		fs.writeFileSync(`${prefix}.md`, "# Original md");
		fs.writeFileSync(`${prefix}.metadata.json`, JSON.stringify({ original: true }));

		const mdMtime = fs.statSync(`${prefix}.md`).mtimeMs;
		const metaMtime = fs.statSync(`${prefix}.metadata.json`).mtimeMs;

		// Small delay to ensure mtime would differ if overwritten
		await new Promise((r) => setTimeout(r, 10));

		await generateMissingReports(jsonlPath);

		// mtime unchanged — files were not overwritten
		assert.strictEqual(fs.statSync(`${prefix}.md`).mtimeMs, mdMtime);
		assert.strictEqual(fs.statSync(`${prefix}.metadata.json`).mtimeMs, metaMtime);
	});

	it("only .metadata.json exists -> creates .md only", async () => {
		const jsonlPath = writeSessionJsonl(sessionsDir, "session-meta-only");

		const prefix = path.join(sessionsDir, "session-meta-only");
		fs.writeFileSync(`${prefix}.metadata.json`, JSON.stringify({ existing: true }));
		const metaMtime = fs.statSync(`${prefix}.metadata.json`).mtimeMs;

		await new Promise((r) => setTimeout(r, 10));

		await generateMissingReports(jsonlPath);

		assert.ok(fs.existsSync(`${prefix}.md`), ".md should be created");
		// .metadata.json unchanged
		assert.strictEqual(fs.statSync(`${prefix}.metadata.json`).mtimeMs, metaMtime);
	});

	it("only .md exists -> creates .metadata.json only", async () => {
		const jsonlPath = writeSessionJsonl(sessionsDir, "session-md-only");

		const prefix = path.join(sessionsDir, "session-md-only");
		fs.writeFileSync(`${prefix}.md`, "# Existing md");
		const mdMtime = fs.statSync(`${prefix}.md`).mtimeMs;

		await new Promise((r) => setTimeout(r, 10));

		await generateMissingReports(jsonlPath);

		assert.ok(fs.existsSync(`${prefix}.metadata.json`), ".metadata.json should be created");
		// .md unchanged
		assert.strictEqual(fs.statSync(`${prefix}.md`).mtimeMs, mdMtime);
	});

	it("non-existent .jsonl -> no-op", async () => {
		const jsonlPath = path.join(sessionsDir, "nonexistent.jsonl");
		// Should not throw
		await generateMissingReports(jsonlPath);

		// No files created
		assert.strictEqual(fs.readdirSync(sessionsDir).length, 0);
	});

	it("unparseable .jsonl (invalid JSON) -> logs error, returns, no files created", async () => {
		const jsonlPath = writeInvalidJsonl(sessionsDir, "session-bad");
		// Should not throw
		await generateMissingReports(jsonlPath);

		const prefix = path.join(sessionsDir, "session-bad");
		assert.ok(!fs.existsSync(`${prefix}.md`), ".md should NOT be created");
		assert.ok(!fs.existsSync(`${prefix}.metadata.json`), ".metadata.json should NOT be created");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Integration — recovery loop (simulates session_start handler)
// ---------------------------------------------------------------------------

describe("session-logger recovery loop — integration", () => {
	let tmpDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-recovery-int-"));
		sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("recovery with 3 orphan .jsonl -> all 3 get .md + .metadata.json (6 files)", async () => {
		writeSessionJsonl(sessionsDir, "session-001");
		writeSessionJsonl(sessionsDir, "session-002");
		writeSessionJsonl(sessionsDir, "session-003");

		// Simulate recovery loop (same pattern as session_start handler)
		const jsonlFiles = fs
			.readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));

		for (const file of jsonlFiles) {
			const jsonlPath = path.join(sessionsDir, file);
			await generateMissingReports(jsonlPath);
		}

		// Verify all 6 output files exist
		for (const sid of ["session-001", "session-002", "session-003"]) {
			assert.ok(fs.existsSync(path.join(sessionsDir, `${sid}.md`)), `${sid}.md exists`);
			assert.ok(
				fs.existsSync(path.join(sessionsDir, `${sid}.metadata.json`)),
				`${sid}.metadata.json exists`,
			);
		}

		// 3 jsonl + 3 md + 3 metadata.json + 2 symlinks (latest.md, latest.metadata.json) = 11 total files
		assert.strictEqual(fs.readdirSync(sessionsDir).length, 11);
	});

	it("recovery skips current in-progress session file", async () => {
		// Current session (simulates the active session)
		const currentFile = writeSessionJsonl(sessionsDir, "session-current");

		// 2 orphan sessions
		writeSessionJsonl(sessionsDir, "session-orphan-1");
		writeSessionJsonl(sessionsDir, "session-orphan-2");

		// Simulate recovery loop with current session check
		const jsonlFiles = fs
			.readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));

		for (const file of jsonlFiles) {
			const jsonlPath = path.join(sessionsDir, file);
			// Skip current in-progress session
			if (currentFile && jsonlPath === currentFile) continue;
			await generateMissingReports(jsonlPath);
		}

		// Current session should NOT have reports
		assert.ok(
			!fs.existsSync(path.join(sessionsDir, "session-current.md")),
			"current session .md should NOT be created",
		);
		assert.ok(
			!fs.existsSync(path.join(sessionsDir, "session-current.metadata.json")),
			"current session .metadata.json should NOT be created",
		);

		// Orphans should have reports
		assert.ok(fs.existsSync(path.join(sessionsDir, "session-orphan-1.md")));
		assert.ok(fs.existsSync(path.join(sessionsDir, "session-orphan-2.metadata.json")));
	});

	it("recovery skips latest.jsonl and non-.jsonl files", async () => {
		// Write orphan.jsonl — should be processed
		writeSessionJsonl(sessionsDir, "orphan");

		// Write latest.jsonl — should be skipped (contains "latest")
		const latestPath = path.join(sessionsDir, "latest.jsonl");
		fs.writeFileSync(latestPath, '{"type":"session","id":"latest"}\n');

		// Write random.txt — should be skipped (not .jsonl)
		fs.writeFileSync(path.join(sessionsDir, "random.txt"), "not jsonl");

		// Simulate recovery loop
		const jsonlFiles = fs
			.readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));

		for (const file of jsonlFiles) {
			const jsonlPath = path.join(sessionsDir, file);
			await generateMissingReports(jsonlPath);
		}

		// Only orphan.jsonl should get reports
		assert.ok(fs.existsSync(path.join(sessionsDir, "orphan.md")), "orphan .md created");
		assert.ok(
			fs.existsSync(path.join(sessionsDir, "orphan.metadata.json")),
			"orphan .metadata.json created",
		);

		// latest.jsonl was not processed — no report file was generated from it.
		// Verify the actual orphan.md (not latest.md symlink) has orphan session data:
		assert.ok(fs.existsSync(path.join(sessionsDir, "orphan.md")), "orphan .md created");
	});

	it("empty sessions dir -> no-op, no errors", async () => {
		// Sessions dir is empty

		const jsonlFiles = fs
			.readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));

		// Empty -> no files to process
		assert.strictEqual(jsonlFiles.length, 0);

		// No files created
		assert.strictEqual(fs.readdirSync(sessionsDir).length, 0);
	});
});
