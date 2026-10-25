/**
 * Tests for Ripgrep Search (ripgrep literal text search)
 *
 * Pure function tests import from .pi/extensions/ripgrep-search/ modules
 * instead of maintaining inline copies (avoids divergence risk).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ripgrep-search/test/ripgrep-search.test.mts
 *
 * Integration test runs real rg against .pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/
 * (skipped if rg binary not installed).
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { loadSearchConfig, resolveBackend } from "../config.ts";
import { parseVimgrepOutput } from "../backends.ts";
import { registerTempDir, cleanupTrackedTempDirs, trackedTempDirs } from "../internal.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
describe("loadSearchConfig", () => {
	// We manage temp dirs per test instead of using beforeEach/afterEach
	// since Node test runner doesn't support those in describe blocks directly.
	function setupTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ripgrep-test-"));
		// Create .pi directory
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		return dir;
	}

	function cleanupTmpDir(dir: string) {
		for (const d of [dir]) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	it("returns defaults when .pi/settings.json is missing entirely", () => {
		const noPiDir = mkdtempSync(join(tmpdir(), "ripgrep-test-nopi-"));
		try {
			const result = loadSearchConfig(noPiDir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(noPiDir);
		}
	});

	it("returns defaults when .pi/settings.json exists but has no search key", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ other: true }));
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("returns defaults when .pi/settings.json is malformed JSON", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(join(dir, ".pi", "settings.json"), "not json");
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses searchBackend: auto", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "auto" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses searchBackend: ripgrep", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "ripgrep" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "ripgrep");
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses searchBackend: grep", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "grep" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "grep");
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("falls back to auto for invalid searchBackend", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "invalid" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses maxLineLength: 100", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 100 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 100);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("rejects maxLineLength: 0 (must be positive)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 0 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("rejects maxLineLength: -50 (negative)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: -50 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("clamps maxLineLength: 5000 to 2000", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 5000 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 2000);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("rejects maxLineLength: 'abc' (non-numeric)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: "abc" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("accepts maxLineLength at upper bound: 2000", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 2000 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 2000);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("handles both searchBackend and maxLineLength together", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "grep", maxLineLength: 150 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "grep");
			assert.strictEqual(result.maxLineLength, 150);
		} finally {
			cleanupTmpDir(dir);
		}
	});
});

describe("resolveBackend", () => {
	it("auto + rg available → ripgrep", () => {
		const result = resolveBackend({ searchBackend: "auto", maxLineLength: 200 }, true);
		assert.strictEqual(result.backend, "ripgrep");
		assert.strictEqual(result.error, undefined);
	});

	it("auto + rg not available → grep", () => {
		const result = resolveBackend({ searchBackend: "auto", maxLineLength: 200 }, false);
		assert.strictEqual(result.backend, "grep");
		assert.strictEqual(result.error, undefined);
	});

	it("ripgrep + rg available → ripgrep", () => {
		const result = resolveBackend({ searchBackend: "ripgrep", maxLineLength: 200 }, true);
		assert.strictEqual(result.backend, "ripgrep");
		assert.strictEqual(result.error, undefined);
	});

	it("ripgrep + rg not available → error", () => {
		const result = resolveBackend({ searchBackend: "ripgrep", maxLineLength: 200 }, false);
		assert.strictEqual(result.backend, "ripgrep");
		assert.ok(result.error !== undefined, "Should return an error message");
		assert.ok(
			result.error!.includes("ripgrep not found"),
			"Error should mention ripgrep not found",
		);
	});

	it("grep + rg available → grep (skips detection)", () => {
		const result = resolveBackend({ searchBackend: "grep", maxLineLength: 200 }, true);
		assert.strictEqual(result.backend, "grep");
		assert.strictEqual(result.error, undefined);
	});

	it("grep + rg not available → grep (no error)", () => {
		const result = resolveBackend({ searchBackend: "grep", maxLineLength: 200 }, false);
		assert.strictEqual(result.backend, "grep");
		assert.strictEqual(result.error, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Temp directory tracking lifecycle (imported from temp.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("temp dir tracking", () => {
	beforeEach(() => {
		trackedTempDirs.clear();
	});

	// ── Phase 1: Unit tests for tracking functions ──

	describe("registerTempDir", () => {
		it("adds path to set", () => {
			registerTempDir("/tmp/pi-ripgrep-abc123");
			assert.strictEqual(trackedTempDirs.size, 1);
			assert.ok(trackedTempDirs.has("/tmp/pi-ripgrep-abc123"));
		});

		it("same path twice is idempotent", () => {
			registerTempDir("/tmp/pi-ripgrep-abc123");
			registerTempDir("/tmp/pi-ripgrep-abc123");
			assert.strictEqual(trackedTempDirs.size, 1);
		});

		it("multiple dirs registered", () => {
			registerTempDir("/tmp/pi-ripgrep-001");
			registerTempDir("/tmp/pi-ripgrep-002");
			assert.strictEqual(trackedTempDirs.size, 2);
		});
	});

	describe("cleanupTrackedTempDirs", () => {
		it("calls rm for each tracked dir with recursive+force", async () => {
			const calls: Array<{ path: string; opts: unknown }> = [];
			const mockRm = async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
				calls.push({ path, opts });
			};

			registerTempDir("/tmp/dir1");
			registerTempDir("/tmp/dir2");
			await cleanupTrackedTempDirs(mockRm);

			assert.strictEqual(calls.length, 2);
			assert.strictEqual(calls[0]!.path, "/tmp/dir1");
			assert.deepStrictEqual(calls[0]!.opts, { recursive: true, force: true });
			assert.strictEqual(calls[1]!.path, "/tmp/dir2");
			assert.deepStrictEqual(calls[1]!.opts, { recursive: true, force: true });
		});

		it("clears set after cleanup", async () => {
			registerTempDir("/tmp/dir1");
			registerTempDir("/tmp/dir2");
			const mockRm = async () => {};
			await cleanupTrackedTempDirs(mockRm);
			assert.strictEqual(trackedTempDirs.size, 0);
		});

		it("empty set — no throw, no calls", async () => {
			let callCount = 0;
			const mockRm = async () => {
				callCount++;
			};
			await cleanupTrackedTempDirs(mockRm);
			assert.strictEqual(callCount, 0);
			assert.strictEqual(trackedTempDirs.size, 0);
		});

		it("rm with force:true suppresses ENOENT", async () => {
			registerTempDir("/tmp/nonexistent");
			const mockRm = async (_path: string, opts?: { force?: boolean }) => {
				if (!opts?.force) throw new Error("ENOENT: no such file");
				// force:true — rm suppresses error, resolve normally
			};
			// Should not reject
			await cleanupTrackedTempDirs(mockRm);
			assert.strictEqual(trackedTempDirs.size, 0);
		});

		it("multiple dirs — each correct path passed to rm", async () => {
			const removed: string[] = [];
			const mockRm = async (path: string) => {
				removed.push(path);
			};

			registerTempDir("/tmp/a");
			registerTempDir("/tmp/b");
			registerTempDir("/tmp/c");
			await cleanupTrackedTempDirs(mockRm);

			assert.strictEqual(removed.length, 3);
			assert.deepStrictEqual(removed.sort(), ["/tmp/a", "/tmp/b", "/tmp/c"]);
		});
	});

	// ── Phase 2: Mock-based lifecycle (tool executor-like) ──

	describe("full lifecycle (mock executor)", () => {
		it("temp dir created on truncation — fullOutputPath set", async () => {
			// Generate 600 lines to exceed MAX_TOTAL_RESULTS=500
			const lines: string[] = [];
			for (let i = 0; i < 600; i++) {
				lines.push(`file:${i + 1}:1:line ${i + 1}`);
			}
			const rawOutput = lines.join("\n");

			const searchResult = parseVimgrepOutput(rawOutput, 500);
			const resultsTruncated = searchResult.truncated ?? false;

			// Simulate the tool executor's temp dir creation
			let fullOutputPath: string | undefined;
			if (resultsTruncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-ripgrep-test-"));
				fullOutputPath = join(tempDir, "full-output.txt");
				writeFileSync(fullOutputPath, rawOutput, "utf8");
				registerTempDir(tempDir);
			}

			assert.ok(resultsTruncated, "Should be truncated (600 > 500)");
			assert.ok(fullOutputPath, "Should set fullOutputPath");
			assert.ok(fullOutputPath!.includes("pi-ripgrep-test-"), "Path should be in temp dir");

			// Verify file exists
			assert.ok(existsSync(fullOutputPath!), "Temp file should exist after tool call");
			const content = readFileSync(fullOutputPath!, "utf8");
			assert.strictEqual(content, rawOutput, "File should contain full raw stdout");

			// Verify dir is tracked
			assert.strictEqual(trackedTempDirs.size, 1);

			// Clean up test artifacts
			const parentDir = fullOutputPath!.replace("/full-output.txt", "");
			rmSync(parentDir, { recursive: true, force: true });
			trackedTempDirs.clear();
		});

		it("cleanup removes temp dir", async () => {
			// Create a real temp dir with a file
			const tempDir = mkdtempSync(join(tmpdir(), "pi-ripgrep-test-cleanup-"));
			const filePath = join(tempDir, "full-output.txt");
			writeFileSync(filePath, "test content", "utf8");
			registerTempDir(tempDir);

			assert.ok(existsSync(tempDir), "Temp dir should exist before cleanup");

			// Use real rm from test scope
			const { rm } = await import("node:fs/promises");
			await cleanupTrackedTempDirs(rm);

			assert.ok(!existsSync(tempDir), "Temp dir should be removed after cleanup");
			assert.strictEqual(trackedTempDirs.size, 0, "Set should be cleared");
		});

		it("no temp dir on non-truncated search", async () => {
			const rawOutput = "file:1:1:only one result";
			const searchResult = parseVimgrepOutput(rawOutput);
			const resultsTruncated = searchResult.truncated ?? false;

			assert.ok(!resultsTruncated, "Should not be truncated (1 result)");
			// This mimics the executor: no temp dir created when not truncated
			assert.strictEqual(trackedTempDirs.size, 0);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// verifyDirectory — path containment guard
// ═══════════════════════════════════════════════════════════════════════
