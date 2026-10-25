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
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { buildRgArgs, parseVimgrepOutput } from "../backends.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
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
