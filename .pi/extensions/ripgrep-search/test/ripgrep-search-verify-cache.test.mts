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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { verifyDirectory } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
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
