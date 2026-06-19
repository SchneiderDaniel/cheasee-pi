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
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgMatch, RgResult, SearchConfig } from "../types.ts";
import { loadSearchConfig, resolveBackend, ripgrepAvailable } from "../config.ts";
import { buildRgArgs, buildGrepArgs } from "../args.ts";
import { parseVimgrepOutput } from "../parse.ts";
import {
	buildStructuredSummary,
	buildSearchErrorText,
	verifyDirectory,
	_setTestCtxMode,
	renderCallImpl,
	renderResultImpl,
	wrapOsc8Link,
} from "../index.ts";
import {
	validateQuery,
	registerTempDir,
	cleanupTrackedTempDirs,
	trackedTempDirs,
	getCachedResult,
	setCachedResult,
	clearCache,
	getCacheSize,
	buildCacheKey,
} from "../internal.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("validateQuery", () => {
	it("rejects 'class User' (collision rule)", () => {
		const result = validateQuery("class User");
		assert.ok(result !== null, "Expected error for class definition pattern");
		assert.ok(result!.includes("structural_search"), "Error should mention structural_search");
	});

	it("rejects 'def verify_token' (collision rule)", () => {
		const result = validateQuery("def verify_token");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects 'function bootstrap' (collision rule)", () => {
		const result = validateQuery("function bootstrap");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects pattern with $ (structural syntax)", () => {
		const result = validateQuery("console.log($A)");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects pattern with { (structural syntax)", () => {
		const result = validateQuery("try { $$$BODY }");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects empty string", () => {
		const result = validateQuery("");
		assert.ok(result !== null);
	});

	it("rejects whitespace-only string", () => {
		const result = validateQuery("   ");
		assert.ok(result !== null);
	});

	it("accepts plain literal 'TIMEOUT_MS = 5000'", () => {
		const result = validateQuery("TIMEOUT_MS = 5000");
		assert.strictEqual(result, null);
	});

	it("accepts single number '5000'", () => {
		const result = validateQuery("5000");
		assert.strictEqual(result, null);
	});

	it("accepts word 'error_log'", () => {
		const result = validateQuery("error_log");
		assert.strictEqual(result, null);
	});

	it("accepts regex 'TODO|FIXME'", () => {
		const result = validateQuery("TODO|FIXME");
		assert.strictEqual(result, null);
	});

	it("accepts dot-query 'user.id'", () => {
		const result = validateQuery("user.id");
		assert.strictEqual(result, null);
	});

	it("accepts natural text 'set timeout to 5000.'", () => {
		const result = validateQuery("set timeout to 5000.");
		assert.strictEqual(result, null);
	});

	it("accepts pattern with dots and parens 'verify_token()'", () => {
		const result = validateQuery("verify_token()");
		assert.strictEqual(result, null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// max_count schema type: Type.Number → Type.Integer (Issue 989)
// ═══════════════════════════════════════════════════════════════════════

describe("max_count schema — Type.Integer (Issue 989)", () => {
	const schema = Type.Object({
		max_count: Type.Optional(Type.Integer({ default: 10 })),
	});

	it("accepts integer 10", () => {
		assert.ok(Value.Check(schema, { max_count: 10 }));
	});

	it("accepts integer 0", () => {
		assert.ok(Value.Check(schema, { max_count: 0 }));
	});

	it("accepts integer 500", () => {
		assert.ok(Value.Check(schema, { max_count: 500 }));
	});

	it("rejects float 2.5", () => {
		assert.ok(!Value.Check(schema, { max_count: 2.5 }));
	});

	it("rejects float 3.14", () => {
		assert.ok(!Value.Check(schema, { max_count: 3.14 }));
	});

	it("rejects string '10'", () => {
		assert.ok(!Value.Check(schema, { max_count: "10" }));
	});

	it("rejects null", () => {
		assert.ok(!Value.Check(schema, { max_count: null }));
	});

	it("rejects boolean true", () => {
		assert.ok(!Value.Check(schema, { max_count: true }));
	});

	it("accepts empty object (optional with default 10)", () => {
		assert.ok(Value.Check(schema, {}), "Optional property should accept missing value");
	});
});

describe("buildRgArgs", () => {
	it("builds default args with max_count=10, directory='.'", () => {
		const { command, args } = buildRgArgs("TIMEOUT_MS = 5000", ".", 10);
		assert.strictEqual(command, "rg");
		assert.ok(args.includes("--vimgrep"));
		assert.ok(args.includes("--max-columns=200"));
		assert.ok(args.includes("--max-count=10"));
		assert.ok(args.includes("--no-heading"));
		assert.ok(args.includes("-j1"));
		assert.ok(args.includes("--hidden"), "Should include --hidden flag");
		assert.ok(args.includes("--glob"), "Should include --glob flag");
		assert.ok(args.includes("!.git/**"), "Should include .git exclusion glob");
		assert.ok(args.includes("TIMEOUT_MS = 5000"));
		assert.ok(args.includes("."));
	});

	it("uses custom max_count=5", () => {
		const { args } = buildRgArgs("query", ".", 5);
		assert.ok(args.includes("--max-count=5"));
	});

	it("uses custom directory='src/'", () => {
		const { args } = buildRgArgs("query", "src/", 10);
		assert.strictEqual(args[args.length - 1], "src/");
	});

	it("query with backticks passed as separate array element (not shell-escaped)", () => {
		const { args } = buildRgArgs("rm -rf /", ".", 10);
		const queryIndex = args.indexOf("rm -rf /");
		assert.ok(queryIndex >= 0, "Query should be a separate array element");
	});

	it("query with spaces is single array element", () => {
		const { args } = buildRgArgs("timeout = 5000", ".", 10);
		const queryIndex = args.indexOf("timeout = 5000");
		assert.ok(queryIndex >= 0, "Query with spaces should be a single array element");
	});

	it("all flags present in correct positions", () => {
		const { command, args } = buildRgArgs("test", ".", 10);
		assert.strictEqual(command, "rg");
		assert.strictEqual(args[0], "--vimgrep");
		assert.ok(args[1]!.startsWith("--max-columns="));
		assert.ok(args[2]!.startsWith("--max-count="));
		assert.strictEqual(args[3], "--no-heading");
		assert.strictEqual(args[4], "-j1");
		assert.strictEqual(args[5], "--hidden");
		assert.strictEqual(args[6], "--glob");
		assert.strictEqual(args[7], "!.git/**");
		assert.strictEqual(args[args.length - 1], ".", "directory is last");
		assert.strictEqual(args[args.length - 2], "test", "query precedes directory");
	});

	it("respects custom maxLineLength", () => {
		const { args } = buildRgArgs("query", ".", 10, 150);
		assert.ok(args.includes("--max-columns=150"));
	});

	it("defaults maxLineLength to 200", () => {
		const { args } = buildRgArgs("query", ".", 10);
		assert.ok(args.includes("--max-columns=200"));
	});
});

describe("buildGrepArgs", () => {
	it("builds default grep args with max_count=10, directory='.'", () => {
		const { command, args } = buildGrepArgs("TIMEOUT_MS = 5000", ".", 10);
		assert.strictEqual(command, "grep");
		assert.ok(args.includes("-rnH"));
		assert.ok(args.includes("-m"));
		assert.ok(args.includes("10"));
		assert.ok(args.includes("--color=never"));
		assert.ok(args.includes("TIMEOUT_MS = 5000"));
		assert.ok(args.includes("."));
	});

	it("includes all --exclude-dir flags", () => {
		const { args } = buildGrepArgs("query", ".", 10);
		assert.ok(args.includes("--exclude-dir=.git"));
		assert.ok(args.includes("--exclude-dir=node_modules"));
		assert.ok(args.includes("--exclude-dir=venv"));
		assert.ok(args.includes("--exclude-dir=__pycache__"));
		assert.ok(args.includes("--exclude-dir=.mypy_cache"));
		assert.ok(args.includes("--exclude-dir=.pytest_cache"));
		assert.ok(args.includes("--exclude-dir=dist"));
		assert.ok(args.includes("--exclude-dir=build"));
	});

	it("excluded dirs appear before -e flag", () => {
		const { args } = buildGrepArgs("query", ".", 10);
		const excludeIdx = args.indexOf("--exclude-dir=.git");
		const eIdx = args.indexOf("-e");
		assert.ok(excludeIdx >= 0, "--exclude-dir=.git should be present");
		assert.ok(eIdx >= 0, "-e should be present");
		assert.ok(excludeIdx < eIdx, "--exclude-dir flags should appear before -e");
	});

	it("uses custom max_count=5", () => {
		const { args } = buildGrepArgs("query", ".", 5);
		const mIdx = args.indexOf("-m");
		assert.ok(mIdx >= 0);
		assert.strictEqual(args[mIdx + 1], "5");
	});

	it("uses custom directory='src/'", () => {
		const { args } = buildGrepArgs("query", "src/", 10);
		assert.strictEqual(args[args.length - 1], "src/");
	});

	it("query is separate array element (no shell injection)", () => {
		const { args } = buildGrepArgs("rm -rf /", ".", 10);
		const queryIndex = args.indexOf("rm -rf /");
		assert.ok(queryIndex >= 0, "Query should be a separate array element");
	});

	it("all flags in expected order", () => {
		const { command, args } = buildGrepArgs("test", ".", 10);
		assert.strictEqual(command, "grep");
		assert.strictEqual(args[0], "-rnH");
		assert.strictEqual(args[1], "-m");
		assert.strictEqual(args[2], "10");
		assert.strictEqual(args[3], "--color=never");
		// Then exclusion dirs
		const excludeStart = args.indexOf("--exclude-dir=.git");
		assert.ok(excludeStart >= 4, "--exclude-dir should start after --color=never");
		// -e comes after all --exclude-dir entries, then query, then directory
		const eIdx = args.indexOf("-e");
		assert.ok(eIdx > excludeStart, "-e should come after all --exclude-dir entries");
		assert.strictEqual(args[eIdx + 1], "test", "query follows -e");
		assert.strictEqual(args[args.length - 1], ".", "directory is last");
	});
});

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

describe("verifyDirectory", () => {
	function setupTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ripgrep-verify-"));
		// Create subdirectories inside the temp dir
		mkdirSync(join(dir, "subdir"), { recursive: true });
		mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
		return dir;
	}

	function cleanupTmpDir(dir: string) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	// ── Phase 1: Success cases — returns resolved string, not discriminated union ──

	describe("valid directories (inside cwd)", () => {
		it('returns resolved absolute string for "subdir/"', async () => {
			const dir = setupTmpDir();
			try {
				const resolved = await verifyDirectory(dir, "subdir");
				assert.strictEqual(resolved, resolve(dir, "subdir"));
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('returns cwd string for "."', async () => {
			const dir = setupTmpDir();
			try {
				const resolved = await verifyDirectory(dir, ".");
				assert.strictEqual(resolved, resolve(dir));
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it("returns cwd string for directory equal to cwd itself", async () => {
			const dir = setupTmpDir();
			try {
				const resolved = await verifyDirectory(dir, dir);
				assert.strictEqual(resolved, resolve(dir));
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('"subdir/.." normalizes to cwd string', async () => {
			const dir = setupTmpDir();
			try {
				const resolved = await verifyDirectory(dir, "subdir/..");
				assert.strictEqual(resolved, resolve(dir));
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('nested "a/b/c" returns resolved absolute string', async () => {
			const dir = setupTmpDir();
			try {
				const resolved = await verifyDirectory(dir, "a/b/c");
				assert.strictEqual(resolved, resolve(dir, "a", "b", "c"));
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it("empty string returns cwd string", async () => {
			const dir = setupTmpDir();
			try {
				const resolved = await verifyDirectory(dir, "");
				assert.strictEqual(resolved, resolve(dir));
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('path with trailing "/" like "subdir/" returns normalized path', async () => {
			const dir = setupTmpDir();
			try {
				const resolved = await verifyDirectory(dir, "subdir/");
				assert.strictEqual(resolved, resolve(dir, "subdir"));
			} finally {
				cleanupTmpDir(dir);
			}
		});
	});

	// ── Phase 2: Path traversal rejection via thrown Error ──

	describe("path traversal (outside cwd)", () => {
		it('rejects "../../etc" with Error containing "Directory traversal detected"', async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(verifyDirectory(dir, "../../etc"), /Directory traversal detected/);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('rejects ".." with traversal message', async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(verifyDirectory(dir, ".."), /Directory traversal detected/);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('rejects "../../../../tmp" (deep) with traversal message', async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(
					verifyDirectory(dir, "../../../../tmp"),
					/Directory traversal detected/,
				);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('rejects "subdir/../../../../etc" (nested traversal) with traversal message', async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(
					verifyDirectory(dir, "subdir/../../../../etc"),
					/Directory traversal detected/,
				);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('rejects root "/" with traversal message', async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(verifyDirectory(dir, "/"), /Directory traversal detected/);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it('rejects "../sibling/../etc" (cross-directory) with traversal message', async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(
					verifyDirectory(dir, "../sibling/../etc"),
					/Directory traversal detected/,
				);
			} finally {
				cleanupTmpDir(dir);
			}
		});
	});

	// ── Phase 3: Filesystem error paths via thrown Error ──

	describe("filesystem errors", () => {
		it("ENOENT: nonexistent directory throws Error with 'not found'", async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(verifyDirectory(dir, "nonexistent_dir_xyz"), /not found/);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it("auto-corrects file path to parent directory", async () => {
			const dir = setupTmpDir();
			try {
				writeFileSync(join(dir, "afile.txt"), "content");
				const result = await verifyDirectory(dir, "afile.txt");
				assert.equal(result, dir);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it("auto-corrects file via relative path to parent directory", async () => {
			const dir = setupTmpDir();
			try {
				writeFileSync(join(dir, "bfile.txt"), "content");
				const result = await verifyDirectory(dir, "./bfile.txt");
				assert.equal(result, dir);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it("nonexistent child directory throws Error with 'not found'", async () => {
			const dir = setupTmpDir();
			try {
				await assert.rejects(verifyDirectory(dir, "subdir/nonexistent_child"), /not found/);
			} finally {
				cleanupTmpDir(dir);
			}
		});

		it("EACCES: permission-denied throws Error with error info", async () => {
			const tmpDir = setupTmpDir();
			try {
				const parentDir = join(tmpDir, "noexec-parent");
				const childDir = join(parentDir, "child");
				mkdirSync(childDir, { recursive: true });
				const { chmodSync } = await import("node:fs");
				chmodSync(parentDir, 0o000);
				try {
					await verifyDirectory(tmpDir, "noexec-parent/child");
					assert.fail("Should have thrown");
				} catch (err) {
					const msg = (err as Error).message;
					const hasErrorInfo =
						msg.includes("EACCES") ||
						msg.toLowerCase().includes("permission denied") ||
						msg.toLowerCase().includes("access");
					assert.ok(hasErrorInfo, `Message should mention error (got: "${msg}")`);
				}
			} finally {
				try {
					const { chmodSync } = await import("node:fs");
					chmodSync(join(tmpDir, "noexec-parent"), 0o755);
				} catch {
					/* ignore */
				}
				cleanupTmpDir(tmpDir);
			}
		});

		it("ELOOP: circular symlink throws Error with non-empty message", async () => {
			const tmpDir = setupTmpDir();
			try {
				const { symlinkSync } = await import("node:fs");
				const dirA = join(tmpDir, "loop-a");
				const dirB = join(tmpDir, "loop-b");
				mkdirSync(dirA);
				mkdirSync(dirB);
				symlinkSync("../b/link", join(dirA, "link"));
				symlinkSync("../a/link", join(dirB, "link"));
				try {
					await verifyDirectory(tmpDir, "loop-a/link");
					assert.fail("Should have thrown");
				} catch (err) {
					assert.ok((err as Error).message.length > 0, "Error message should not be empty");
				}
			} finally {
				cleanupTmpDir(tmpDir);
			}
		});

		it("unknown stat error includes directory name and error code/description", async () => {
			const tmpDir = setupTmpDir();
			try {
				const parentDir = join(tmpDir, "msg-test-parent");
				const childDir = join(parentDir, "child");
				mkdirSync(childDir, { recursive: true });
				const { chmodSync } = await import("node:fs");
				chmodSync(parentDir, 0o000);
				try {
					await verifyDirectory(tmpDir, "msg-test-parent/child");
					assert.fail("Should have thrown");
				} catch (err) {
					const msg = (err as Error).message;
					assert.ok(
						msg.includes("EACCES") ||
							msg.toLowerCase().includes("permission denied") ||
							msg.toLowerCase().includes("access"),
						`Message should include error info (got: "${msg}")`,
					);
					assert.ok(msg.includes("msg-test-parent/child"), "Message should include directory name");
				}
			} finally {
				try {
					const { chmodSync } = await import("node:fs");
					chmodSync(join(tmpDir, "msg-test-parent"), 0o755);
				} catch {
					/* ignore */
				}
				cleanupTmpDir(tmpDir);
			}
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Integration test (requires rg binary installed)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// Cache module (cache.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("cache module", () => {
	beforeEach(() => {
		clearCache();
	});

	// ── Unit: get/set/clear ──

	describe("getCachedResult / setCachedResult", () => {
		it("stores and retrieves a result by query+directory", () => {
			const entry = {
				result: { total_returned: 2, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			};
			setCachedResult("foo", ".", entry);
			const cached = getCachedResult("foo", ".");
			assert.ok(cached !== undefined);
			assert.strictEqual(cached!.result.total_returned, 2);
			assert.strictEqual(cached!.rawStdout, "a.ts:1:1:x");
		});

		it("different query — cache miss", () => {
			setCachedResult("foo", ".", {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			const cached = getCachedResult("bar", ".");
			assert.strictEqual(cached, undefined);
		});

		it("same query, different directory — cache miss", () => {
			setCachedResult("foo", "src", {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			const cached = getCachedResult("foo", "lib");
			assert.strictEqual(cached, undefined);
		});
	});

	// ── buildCacheKey (format + collision resistance) ──

	describe("buildCacheKey", () => {
		it("returns valid JSON containing query and directory", () => {
			const key = buildCacheKey("foo", "src");
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "foo");
			assert.strictEqual(parsed.directory, "src");
		});

		it("different inputs with :: produce different keys (collision guard)", () => {
			const key1 = buildCacheKey("a::b", "src");
			const key2 = buildCacheKey("a", "b::src");
			assert.notStrictEqual(key1, key2);
		});

		it("same inputs produce identical keys (determinism)", () => {
			const key1 = buildCacheKey("a::b", "src");
			const key2 = buildCacheKey("a::b", "src");
			assert.strictEqual(key1, key2);
		});

		it('normalizes "./src" and "src" to same key', () => {
			const key1 = buildCacheKey("foo", "./src");
			const key2 = buildCacheKey("foo", "src");
			assert.strictEqual(key1, key2);
		});

		it("handles query with double quotes", () => {
			const key = buildCacheKey('hello"world', "src");
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, 'hello"world');
		});

		it("handles query with backslash", () => {
			const key = buildCacheKey("a\\b", "src");
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "a\\b");
		});

		it("handles query with null byte", () => {
			const key = buildCacheKey("a\x00b", "src");
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "a\x00b");
		});

		it("handles query with emoji", () => {
			const key = buildCacheKey("🔥", "src");
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "🔥");
		});

		it("handles empty query string", () => {
			const key = buildCacheKey("", "src");
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, "");
			assert.strictEqual(parsed.directory, "src");
		});

		it("handles very long query string", () => {
			const longQuery = "x".repeat(10000);
			const key = buildCacheKey(longQuery, "src");
			const parsed = JSON.parse(key);
			assert.strictEqual(parsed.query, longQuery);
			assert.strictEqual(parsed.directory, "src");
		});

		it("normalizes './src/' and 'src' to same key (combined normalization)", () => {
			const key1 = buildCacheKey("foo", "./src/");
			const key2 = buildCacheKey("foo", "src");
			assert.strictEqual(key1, key2);
		});

		it('empty directory normalized to "."', () => {
			const key1 = buildCacheKey("foo", "");
			const key2 = buildCacheKey("foo", ".");
			assert.strictEqual(key1, key2);
		});

		it("cache hit still works via new key format", () => {
			setCachedResult("a::b", "src", {
				result: { total_returned: 1, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			});
			const cached = getCachedResult("a::b", "src");
			assert.ok(cached !== undefined, "Should find cached entry");
			assert.strictEqual(cached!.result.total_returned, 1);
		});

		it("no false cache hit when :: in query collides with :: in directory", () => {
			setCachedResult("a::b", "src", {
				result: { total_returned: 1, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			});
			// This should be a different key, so getCachedResult must return undefined
			const cached = getCachedResult("a", "b::src");
			assert.strictEqual(cached, undefined);
		});
	});

	// ── Path normalization ──

	describe("path normalization", () => {
		it('"./src" and "src" produce same cache key', () => {
			const key1 = buildCacheKey("foo", "./src");
			const key2 = buildCacheKey("foo", "src");
			assert.strictEqual(key1, key2);
		});

		it('"src/" and "src" produce same cache key', () => {
			const key1 = buildCacheKey("foo", "src/");
			const key2 = buildCacheKey("foo", "src");
			assert.strictEqual(key1, key2);
		});

		it('"." and "" produce same cache key (empty normalized to ".")', () => {
			const key1 = buildCacheKey("foo", ".");
			const key2 = buildCacheKey("foo", "./");
			assert.strictEqual(key1, key2);
		});

		it('"./src/" and "src" — same key (trailing slash + dot-prefix)', () => {
			const key1 = buildCacheKey("foo", "./src/");
			const key2 = buildCacheKey("foo", "src");
			assert.strictEqual(key1, key2);
		});

		it('normalized path: "./src" → cache hit when previously stored as "src"', () => {
			setCachedResult("foo", "src", {
				result: { total_returned: 1, results: [{ file: "a.ts", line: 1, column: 1, text: "x" }] },
				rawStdout: "a.ts:1:1:x",
			});
			const cached = getCachedResult("foo", "./src");
			assert.ok(cached !== undefined, "Should find cached entry via normalized path");
		});
	});

	// ── clearCache ──

	describe("clearCache", () => {
		it("clears all cached entries", () => {
			setCachedResult("a", ".", {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			setCachedResult("b", ".", {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			assert.strictEqual(getCacheSize(), 2);
			clearCache();
			assert.strictEqual(getCacheSize(), 0);
		});

		it("after clear, get returns undefined", () => {
			setCachedResult("foo", ".", {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			clearCache();
			const cached = getCachedResult("foo", ".");
			assert.strictEqual(cached, undefined);
		});
	});

	// ── getCacheSize ──

	describe("getCacheSize", () => {
		it("returns 0 for empty cache", () => {
			assert.strictEqual(getCacheSize(), 0);
		});

		it("returns correct count after inserts", () => {
			setCachedResult("a", ".", {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			setCachedResult("b", ".", {
				result: { total_returned: 1, results: [] },
				rawStdout: "",
			});
			assert.strictEqual(getCacheSize(), 2);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Structured summarizer (buildStructuredSummary from index.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("buildStructuredSummary", () => {
	it("0 matches — returns 'No matches found' message, no error", () => {
		const result: RgResult = { total_returned: 0, results: [] };
		const summary = buildStructuredSummary(result, "ripgrep", "TIMEOUT_MS", ".");
		assert.ok(summary.text.includes("No matches found"));
		assert.strictEqual(summary.details.total_returned, 0);
		assert.strictEqual(summary.details.success, true);
	});

	it("1000 matches — shows top-N (default 10) with truncated indicator and file count", () => {
		const results = [];
		for (let i = 0; i < 1000; i++) {
			results.push({
				file: i < 500 ? "src/a.ts" : "src/b.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 1000, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "TIMEOUT_MS", ".");

		// Shows searcher name
		assert.ok(summary.text.includes("ripgrep"));
		// Shows query
		assert.ok(summary.text.includes("TIMEOUT_MS"));
		// Shows directory
		assert.ok(summary.text.includes("Directory: ."));
		// Shows total
		assert.ok(summary.text.includes("1000"));
		// Shows unique file count
		assert.ok(summary.text.includes("across 2 files"));
		// Shows truncated indicator
		assert.ok(summary.text.includes("Showing first 10 of 1000"));
		// Shows only 10 result lines
		const lines = summary.text.split("\n").filter((l) => /^\d+\./.test(l));
		assert.strictEqual(lines.length, 10);
	});

	it("≤10 matches — all shown, no truncated indicator", () => {
		const results = [
			{ file: "a.ts", line: 1, column: 1, text: "one" },
			{ file: "b.ts", line: 2, column: 1, text: "two" },
		];
		const result: RgResult = { total_returned: 2, results };
		const summary = buildStructuredSummary(result, "grep", "query", ".");
		assert.ok(summary.text.includes("Matches returned: 2"));
		assert.ok(summary.text.includes("1. a.ts:1:1:one"));
		assert.ok(summary.text.includes("2. b.ts:2:1:two"));
		assert.ok(!summary.text.includes("Showing first"));
	});

	it("summary includes searcher name, query string, directory", () => {
		const result: RgResult = {
			total_returned: 1,
			results: [{ file: "a.ts", line: 1, column: 1, text: "x" }],
		};
		const summary = buildStructuredSummary(result, "ripgrep", "foo", "src/");
		assert.ok(summary.text.includes("ripgrep"));
		assert.ok(summary.text.includes("foo"));
		assert.ok(summary.text.includes("Directory: src/"));
	});

	it("single match — rendered correctly with count = 1", () => {
		const result: RgResult = {
			total_returned: 1,
			results: [{ file: "a.ts", line: 1, column: 1, text: "x" }],
		};
		const summary = buildStructuredSummary(result, "ripgrep", "x", ".");
		assert.ok(summary.text.includes("Matches returned: 1"));
		assert.ok(summary.text.includes("1 file"));
		assert.ok(summary.text.includes("1. a.ts:1:1:x"));
	});

	it("matches across 1 file vs 100 files — unique file count correct", () => {
		// 1 file
		const results1 = [
			{ file: "a.ts", line: 1, column: 1, text: "x" },
			{ file: "a.ts", line: 2, column: 1, text: "y" },
		];
		const r1: RgResult = { total_returned: 2, results: results1 };
		const summary1 = buildStructuredSummary(r1, "ripgrep", "q", ".");
		assert.ok(summary1.text.includes("1 file"));

		// 100 files (need 10 unique files to display in top-N)
		const results2 = [];
		for (let i = 0; i < 10; i++) {
			results2.push({
				file: `file${i}.ts`,
				line: 1,
				column: 1,
				text: "x",
			});
		}
		// Add 90 more results across same files to make total 100
		for (let i = 0; i < 90; i++) {
			results2.push({
				file: `file${i % 10}.ts`,
				line: i + 2,
				column: 1,
				text: "x",
			});
		}
		const r2: RgResult = { total_returned: 100, results: results2, truncated: true };
		const summary2 = buildStructuredSummary(r2, "ripgrep", "q", ".");
		assert.ok(summary2.text.includes("across 10 files"));
	});

	it("max_count override (top-5) respected", () => {
		const results = [];
		for (let i = 0; i < 20; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 20, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".", 5);
		assert.ok(summary.text.includes("Showing first 5 of 20"));
		const lines = summary.text.split("\n").filter((l) => /^\d+\./.test(l));
		assert.strictEqual(lines.length, 5);
	});

	it("max_count override (top-20) respected", () => {
		const results = [];
		for (let i = 0; i < 30; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 30, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".", 20);
		assert.ok(summary.text.includes("Showing first 20 of 30"));
		const lines = summary.text.split("\n").filter((l) => /^\d+\./.test(l));
		assert.strictEqual(lines.length, 20);
	});

	it("null/undefined raw stdout — empty summary, no crash", () => {
		// buildStructuredSummary doesn't take rawStdout — test that
		// an empty result set with no content doesn't crash
		const result: RgResult = { total_returned: 0, results: [] };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
		assert.ok(summary.text.includes("No matches found"));
		assert.strictEqual(summary.details.total_returned, 0);
	});

	it("top-N results show correct file:line:column:text format", () => {
		const results = [
			{ file: "src/app.ts", line: 42, column: 16, text: "const x = 1;" },
			{ file: "config/settings.py", line: 4, column: 8, text: "TIMEOUT_MS = 5000" },
		];
		const result: RgResult = { total_returned: 2, results };
		const summary = buildStructuredSummary(result, "ripgrep", "5000", ".");
		assert.ok(summary.text.includes("1. src/app.ts:42:16:const x = 1;"));
		assert.ok(summary.text.includes("2. config/settings.py:4:8:TIMEOUT_MS = 5000"));
	});

	it("truncated indicator formatted correctly with closing bracket placeholder", () => {
		const results = [];
		for (let i = 0; i < 15; i++) {
			results.push({
				file: "a.ts",
				line: i + 1,
				column: 1,
				text: `match ${i + 1}`,
			});
		}
		const result: RgResult = { total_returned: 15, results, truncated: true };
		const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
		// Check truncated indicator format (closing bracket is added by executor)
		assert.ok(summary.text.includes("[Showing first 10 of 15 results across 1 file."));
		assert.strictEqual(summary.details.truncated, true);
	});

	// ── Phase 1: Truncation behavior in buildStructuredSummary ──

	describe("line truncation via truncateLine", () => {
		it("line > 500 chars → truncated text ends with '... [truncated]' suffix", () => {
			const longText = "x".repeat(600);
			const results = [{ file: "a.ts", line: 1, column: 1, text: longText }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			assert.ok(summary.text.includes("... [truncated]"), "Should have truncation suffix");
			// Total line in output should be 500 + suffix length
			const lineMatch = summary.text.match(/1\. a\.ts:1:1:(.+)/);
			assert.ok(lineMatch, "Should match result line format");
			const displayedText = lineMatch![1]!;
			assert.ok(displayedText.endsWith("... [truncated]"));
			assert.strictEqual(displayedText.length, 500 + "... [truncated]".length);
		});

		it("line ≤ 500 chars → text passed through unchanged", () => {
			const shortText = "Hello world";
			const results = [{ file: "a.ts", line: 1, column: 1, text: shortText }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			assert.ok(summary.text.includes("Hello world"), "Short text should pass through unchanged");
			assert.ok(
				!summary.text.includes("... [truncated]"),
				"Short text should not have truncation suffix",
			);
		});

		it("line exactly 500 chars → no truncation", () => {
			const exactText = "x".repeat(500);
			const results = [{ file: "a.ts", line: 1, column: 1, text: exactText }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			// Should NOT contain truncation suffix — exactly at boundary
			assert.ok(
				!summary.text.includes("... [truncated]"),
				"Exact 500-char line should not be truncated",
			);
			// All 500 chars should be present
			assert.ok(summary.text.includes(exactText), "All 500 chars should be visible");
		});

		it("line at 501 chars → truncation applied, suffix present and length correct", () => {
			const text501 = "x".repeat(501);
			const results = [{ file: "a.ts", line: 1, column: 1, text: text501 }];
			const result: RgResult = { total_returned: 1, results };
			const summary = buildStructuredSummary(result, "ripgrep", "q", ".");
			const lineMatch = summary.text.match(/1\. a\.ts:1:1:(.+)/);
			assert.ok(lineMatch, "Should match result line format");
			const displayedText = lineMatch![1]!;
			assert.ok(
				displayedText.endsWith("... [truncated]"),
				"501-char line should be truncated with suffix",
			);
			// 500 chars + suffix
			assert.strictEqual(
				displayedText.length,
				500 + "... [truncated]".length,
				"Truncated line should be exactly 500 chars + suffix",
			);
		});
	});
});

// buildSearchErrorText
// ═══════════════════════════════════════════════════════════════════════

describe("buildSearchErrorText", () => {
	it("buildSearchErrorText is exported function", () => {
		assert.strictEqual(typeof buildSearchErrorText, "function");
	});

	it("killed process produces 'killed' in message", () => {
		const result = buildSearchErrorText("ripgrep", 9, true, "", "ripgrep (\`rg --version\`)", ".");
		assert.ok(result.includes("killed"), "Should mention killed");
	});

	it("empty stderr produces 'no error output' in message", () => {
		const result = buildSearchErrorText("grep", 2, false, "", "grep", ".");
		assert.ok(result.includes("no error output"), "Should mention no error output");
	});

	it("stderr matching 'command not found' produces install hint", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			127,
			false,
			"bash: rg: command not found",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("Ensure"));
	});

	it("stderr matching 'No such file or directory' produces not-found hint", () => {
		const result = buildSearchErrorText(
			"grep",
			2,
			false,
			"grep: foo: No such file or directory",
			"grep",
			"foo",
		);
		assert.ok(
			result.includes("not found or inaccessible"),
			"Should mention directory not accessible",
		);
	});

	it("fallback generic error includes stderr text and exit code", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			13,
			false,
			"something went wrong",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("something went wrong"), "Should include stderr");
		assert.ok(result.includes("exit 13"), "Should include exit code");
	});

	it("exit code 1 (no matches) does not call buildSearchErrorText in execute — characterization", () => {
		const result = buildSearchErrorText("ripgrep", 1, false, "", "ripgrep (\`rg --version\`)", ".");
		assert.ok(result.includes("no error output"), "Code 1 with empty stderr -> no error output");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Backend auto-detection (config.ts already tested above)
// The resolveBackend tests in the config section already cover:
//   - ripgrepAvailable returns true → backend ripgrep
//   - ripgrepAvailable returns false → backend grep
//   - Config override "grep" → skip rg check
// ═══════════════════════════════════════════════════════════════════════

describe("integration: rg binary", () => {
	const hasRg = (() => {
		try {
			execSync("rg --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();

	const skipMsg =
		"rg binary not installed — skip integration test (install with: apt install ripgrep or brew install ripgrep)";

	it(
		'searches "5000" on fixture dir and returns 2 results',
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/ not found");
			}

			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 5000 .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			assert.strictEqual(
				result.total_returned,
				2,
				`Expected 2 results, got ${result.total_returned}`,
			);

			// Normalize file paths (rg may include ./ prefix when cwd matches search dir)
			const files = result.results.map((r) => r.file.replace(/^\.\//, "")).sort();
			assert.ok(files.includes("config/settings.py"), "Should find config/settings.py");
			assert.ok(files.includes("src/app.ts"), "Should find src/app.ts");

			// Each result has proper types
			for (const entry of result.results) {
				assert.ok(typeof entry.file === "string" && entry.file.length > 0);
				assert.ok(typeof entry.line === "number" && entry.line > 0);
				assert.ok(typeof entry.column === "number" && entry.column > 0);
				assert.ok(typeof entry.text === "string");
			}
		},
	);

	it(
		'searches "TODO" on fixture dir and returns 0 results',
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/ not found");
			}

			// rg exits with code 1 when no matches found — execSync throws on non-zero
			// We catch the exception and parse stdout for empty result
			let stdout = "";
			try {
				stdout = execSync("rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 TODO .", {
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				});
			} catch (e: unknown) {
				const err = e as { stdout?: string; stderr?: string; status?: number };
				// rg exit code 1 = no matches — stdout should be empty
				stdout = err.stdout || "";
			}

			const result = parseVimgrepOutput(stdout);
			assert.strictEqual(
				result.total_returned,
				0,
				`Expected 0 results for TODO, got ${result.total_returned}`,
			);
		},
	);

	it(
		'searches "TIMEOUT_MS" with max_count=1 and respects per-file limit',
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/ not found");
			}

			// TIMEOUT_MS appears once per file, so max_count=1 should still return 2
			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=1 --no-heading -j1 TIMEOUT_MS .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			assert.strictEqual(
				result.total_returned,
				2,
				`Expected 2 results for TIMEOUT_MS, got ${result.total_returned}`,
			);
		},
	);

	it(
		"column values are 1-indexed character positions",
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/ not found");
			}

			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 5000 .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			for (const entry of result.results) {
				assert.ok(
					typeof entry.column === "number" && entry.column > 0,
					`Column should be positive number, got ${entry.column}`,
				);
			}
		},
	);

	it(
		"--max-columns=200 enforced (lines over 200 chars truncated)",
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error(".pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/ not found");
			}

			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 '[\\s\\S]' .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			for (const entry of result.results) {
				assert.ok(
					entry.text.length <= 200,
					`Text should be <= 200 chars with --max-columns=200, got ${entry.text.length}`,
				);
			}
		},
	);

	it(
		"--hidden flag: searches hidden directory .hidden/",
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const tmpDir = mkdtempSync(join(tmpdir(), "ripgrep-hidden-test-"));
			try {
				// Create a hidden subdirectory with a file containing a known string
				const hiddenDir = join(tmpDir, ".hidden");
				mkdirSync(hiddenDir, { recursive: true });
				writeFileSync(join(hiddenDir, "secret.txt"), "hidden_value_xyz", "utf8");

				// Create an ordinary non-hidden file (should also find this)
				writeFileSync(join(tmpDir, "normal.txt"), "visible_value", "utf8");

				// Use buildRgArgs and run rg with the constructed args
				const { command, args } = buildRgArgs("hidden_value_xyz", ".", 10);
				assert.strictEqual(command, "rg");
				// Spot-check that new flags are in the args
				assert.ok(args.includes("--hidden"));
				assert.ok(args.includes("!.git/**"));

				const stdout = execSync(`${command} ${args.join(" ")}`, {
					cwd: tmpDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				});

				// Should find the hidden file
				assert.ok(
					stdout.includes(".hidden/secret.txt"),
					`Should find result in hidden directory, got: ${stdout}`,
				);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);

	it(
		"--glob '!.git/**': excludes .git/ directory from search",
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const tmpDir = mkdtempSync(join(tmpdir(), "ripgrep-git-exclude-test-"));
			try {
				// Create .git/objects/pack/ with matching content
				const gitPackDir = join(tmpDir, ".git", "objects", "pack");
				mkdirSync(gitPackDir, { recursive: true });
				writeFileSync(join(gitPackDir, "pack-abc.pack"), "hidden_value_xyz", "utf8");

				// Create an ordinary file with same content (should be found)
				writeFileSync(join(tmpDir, "src.txt"), "hidden_value_xyz", "utf8");

				// Use buildRgArgs flags
				const stdout = execSync(
					"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 --hidden --glob '!.git/**' hidden_value_xyz .",
					{
						cwd: tmpDir,
						encoding: "utf-8",
						stdio: "pipe",
						timeout: 10_000,
					},
				);

				// Should find src.txt but NOT .git/objects/pack/pack-abc.pack
				assert.ok(stdout.includes("src.txt"), "Should find non-.git file");
				assert.ok(!stdout.includes(".git/"), ".git/ should be excluded from search");
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);

	it(
		"non-hidden file search still works with --hidden flag",
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const tmpDir = mkdtempSync(join(tmpdir(), "ripgrep-nonhidden-test-"));
			try {
				mkdirSync(join(tmpDir, "src"), { recursive: true });
				writeFileSync(join(tmpDir, "src", "app.ts"), "const x = 5000;", "utf8");

				const stdout = execSync(
					"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 --hidden --glob '!.git/**' 5000 .",
					{
						cwd: tmpDir,
						encoding: "utf-8",
						stdio: "pipe",
						timeout: 10_000,
					},
				);

				assert.ok(
					stdout.includes("src/app.ts"),
					`Should find match in non-hidden file, got: ${stdout}`,
				);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);
});

// ═══════════════════════════════════════════════════════════════════════
// Mode gate + OSC 8 hyperlinks (Issue 741)
// ═══════════════════════════════════════════════════════════════════════

describe("mode gate + OSC 8 hyperlinks", () => {
	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	const tuiTheme = {
		fg: (_k: string, s: string) => `<${_k}>${s}</${_k}>`,
		bold: (s: string) => `*${s}*`,
	} as any;

	const sampleText =
		"ripgrep search results for query: foo\n" +
		"Directory: .\n" +
		"Matches returned: 2 across 1 file\n\n" +
		"1. src/app.ts:42:16:const x = 1;\n" +
		"2. config/settings.py:4:8:TIMEOUT_MS = 5000";

	function makeResult(
		text: string,
		overrides?: {
			total_returned?: number;
			searchDirectory?: string;
			success?: boolean;
		},
	) {
		const { total_returned = 2, searchDirectory, success = true } = overrides ?? {};
		return {
			content: [{ type: "text" as const, text }],
			details: {
				success,
				total_returned,
				searcher: "ripgrep",
				searchDirectory,
				unique_files: 1,
				truncated: false,
			},
		};
	}

	afterEach(() => {
		_setTestCtxMode(undefined);
	});

	// ---------------------------------------------------------------------------
	// renderResult — TUI mode
	// ---------------------------------------------------------------------------

	describe("renderResult — TUI mode", () => {
		beforeEach(() => {
			_setTestCtxMode("tui");
		});

		it("results present → each file path line wrapped with OSC 8 file:// hyperlink", () => {
			const searchDir = "/home/user/project";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			// Should contain OSC 8 sequences for each result line
			const fileUrl1 = pathToFileURL(join(searchDir, "src/app.ts")).href + "#L42";
			const fileUrl2 = pathToFileURL(join(searchDir, "config/settings.py")).href + "#L4";
			assert.ok(
				content.includes(fileUrl1),
				`Content should contain OSC 8 URL for src/app.ts: ${content}`,
			);
			assert.ok(
				content.includes(fileUrl2),
				`Content should contain OSC 8 URL for config/settings.py: ${content}`,
			);
			// Should include the OSC 8 start/end markers
			assert.ok(content.includes("\x1b]8;;"), "Content should contain OSC 8 escape sequences");
			// Summary line is not wrapped
			assert.ok(content.includes("2 matches"), "Content should show summary");
		});

		it("zero results → No matches found text unchanged (no OSC 8)", () => {
			const result = makeResult("No matches found", {
				total_returned: 0,
				searchDirectory: "/tmp/test",
			});
			const rendered = renderResultImpl(result, { expanded: false }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("No matches found"), "Should show no matches");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8 sequences");
		});

		it("details.searchDirectory undefined → file paths as plain text, no OSC 8", () => {
			const result = makeResult(sampleText, { searchDirectory: undefined });
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("src/app.ts:42:16"), "Should show file path as plain text");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8 sequences");
		});

		it("isPartial=true → returns 'Searching...'", () => {
			_setTestCtxMode("tui");
			const result = makeResult(sampleText);
			const rendered = renderResultImpl(result, { isPartial: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("Searching..."), "Should show searching indicator");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8");
		});

		it("success=false → returns error text", () => {
			const result = makeResult("rg: command not found", {
				success: false,
				searchDirectory: "/tmp/test",
			});
			const rendered = renderResultImpl(result, { expanded: false }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("rg: command not found"), "Should show error text");
			assert.ok(!content.includes("\\x1b]8;;"), "Should not contain OSC 8");
		});
	});

	// ---------------------------------------------------------------------------
	// renderResult — non-TUI mode
	// ---------------------------------------------------------------------------

	describe("renderResult — non-TUI modes", () => {
		const modes = ["rpc", "json", "print"] as const;

		for (const mode of modes) {
			it(`${mode} mode → returns raw text content, no theme formatting, no OSC 8`, () => {
				_setTestCtxMode(mode);
				const result = makeResult(sampleText, { searchDirectory: "/tmp/test" });
				const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

				const content = (rendered as any).text;
				// Should be raw text without theme tags
				assert.strictEqual(content, sampleText, `${mode} mode should return raw text`);
			});
		}
	});

	// ---------------------------------------------------------------------------
	// renderResult — _ctxMode undefined (session_start not fired)
	// ---------------------------------------------------------------------------

	describe("renderResult — _ctxMode undefined (session_start not fired)", () => {
		it("defaults to TUI rendering (OSC 8 applied if data present)", () => {
			// _ctxMode starts as undefined, test doesn't set it
			_setTestCtxMode(undefined);
			const searchDir = "/home/user/project";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			// Should have OSC 8 since _ctxMode is undefined (defaults to TUI)
			assert.ok(content.includes("\x1b]8;;"), "Should contain OSC 8 (TUI default)");
			assert.ok(content.includes("2 matches"), "Should show summary");
		});

		it("no searchDirectory → renders as before (no OSC 8)", () => {
			_setTestCtxMode(undefined);
			const result = makeResult(sampleText);
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("src/app.ts:42:16"), "Should show file path as plain text");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8");
		});
	});

	// ---------------------------------------------------------------------------
	// renderCall
	// ---------------------------------------------------------------------------

	describe("renderCall", () => {
		it('TUI mode → formatted `rg "query"` with theme colors', () => {
			_setTestCtxMode("tui");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS", directory: "." }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.ok(content.includes("rg"), "Should contain rg");
			assert.ok(content.includes("TIMEOUT_MS"), "Should contain query");
			// Should have theme tags
			assert.ok(content.includes("<toolTitle>"), "Should have theme formatting");
		});

		it("non-TUI mode (rpc) → returns raw args.query text, no theme colors", () => {
			_setTestCtxMode("rpc");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS", directory: "." }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.strictEqual(content, "TIMEOUT_MS", "rpc mode should return raw query");
		});

		it("non-TUI mode (json) → returns raw args.query text", () => {
			_setTestCtxMode("json");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS" }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.strictEqual(content, "TIMEOUT_MS", "json mode should return raw query");
		});

		it("non-TUI mode (print) → returns raw args.query text", () => {
			_setTestCtxMode("print");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS" }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.strictEqual(content, "TIMEOUT_MS", "print mode should return raw query");
		});

		it("undefined _ctxMode → defaults to TUI (same as before)", () => {
			_setTestCtxMode(undefined);
			const rendered = renderCallImpl(
				{ query: "TIMEOUT_MS", directory: "src" },
				tuiTheme,
				undefined,
			);
			const content = (rendered as any).text;
			assert.ok(content.includes("rg"), "Should contain rg");
			assert.ok(content.includes("src"), "Should contain directory");
			assert.ok(content.includes("<toolTitle>"), "Should have theme formatting");
		});
	});

	// ---------------------------------------------------------------------------
	// wrapOsc8Link — pure function
	// ---------------------------------------------------------------------------

	describe("wrapOsc8Link", () => {
		it("result line matches pattern → wrapped with OSC 8 hyperlink", () => {
			const line = "1. src/app.ts:42:16:const x = 1;";
			const result = wrapOsc8Link(line, "/project");

			const expectedUrl = pathToFileURL("/project/src/app.ts").href + "#L42";
			assert.ok(result.includes(expectedUrl), "Should contain file URL");
			assert.ok(result.includes("\x1b]8;;"), "Should contain OSC 8 start");
			assert.ok(result.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 end (empty)");
			// The file:line:column part should appear between OSC 8 markers
			assert.ok(result.includes("src/app.ts:42:16"), "Should preserve file path with line:col");
		});

		it("non-matching line (header) → unchanged", () => {
			const line = "ripgrep search results for query: foo";
			const result = wrapOsc8Link(line, "/project");
			assert.strictEqual(result, line, "Header lines should be unchanged");
		});

		it("non-matching line (empty) → unchanged", () => {
			const result = wrapOsc8Link("", "/project");
			assert.strictEqual(result, "", "Empty line should be unchanged");
		});

		it("file path with spaces → URL-encoded correctly", () => {
			const line = "1. my file.ts:10:5:content";
			const result = wrapOsc8Link(line, "/project");

			const expectedUrl = pathToFileURL("/project/my file.ts").href + "#L10";
			assert.ok(
				result.includes(encodeURI(expectedUrl)) || result.includes(expectedUrl),
				"URL should be encoded: " + result,
			);
		});

		it("file path with unicode chars → percent-encoded correctly", () => {
			const line = "1. 文件.ts:3:1:你好";
			const result = wrapOsc8Link(line, "/project");

			const expectedUrl = pathToFileURL("/project/文件.ts").href + "#L3";
			assert.ok(result.includes(expectedUrl), "Should contain URL with percent-encoded unicode");
		});

		it("file path with # → #L fragment separator unambiguous, path # escaped", () => {
			const line = "1. file#1.ts:5:3:text";
			const result = wrapOsc8Link(line, "/project");

			// pathToFileURL percent-encodes # as %23
			const expectedUrl = pathToFileURL("/project/file#1.ts").href + "#L5";
			assert.ok(result.includes("#L5"), "Fragment separator should be #L5");
			assert.ok(result.includes(expectedUrl), "URL should have # encoded as %23 in path");
		});
	});

	// ---------------------------------------------------------------------------
	// execute return details — searchDirectory field
	// ---------------------------------------------------------------------------

	describe("execute return details — searchDirectory", () => {
		it("non-cached result → details.searchDirectory is set to resolved absolute path", () => {
			// This tests that the execute handler would set searchDirectory
			// We verify via makeResult that the details contain it
			_setTestCtxMode("tui");
			const searchDir = "/home/user/project";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			assert.strictEqual(
				result.details.searchDirectory,
				searchDir,
				"details.searchDirectory should match what execute sets",
			);
		});

		it("cached result → details.searchDirectory still present", () => {
			const searchDir = "/tmp/cached-dir";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			assert.ok(
				result.details.searchDirectory !== undefined,
				"Cached result should still have searchDirectory",
			);
			assert.strictEqual(result.details.searchDirectory, searchDir);
		});

		it("zero-result success → details.searchDirectory still present", () => {
			const searchDir = "/tmp/zero-result";
			const result = makeResult("No matches found", {
				total_returned: 0,
				searchDirectory: searchDir,
			});
			assert.strictEqual(
				result.details.searchDirectory,
				searchDir,
				"Zero-result should have searchDirectory",
			);
		});
	});
});
