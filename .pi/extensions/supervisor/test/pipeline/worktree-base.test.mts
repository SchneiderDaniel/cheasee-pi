/**
 * Unit tests for resolveWorktreeBase — the writability probe + tmpdir fallback
 * that keeps the pipeline alive when the configured worktree base is not
 * writable (docker /workspaces image overlay owned by root:root 755).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/worktree-base.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWorktreeBase } from "../../pipeline/worktree.ts";

const FALLBACK = join(tmpdir(), "cheasee-pi-worktrees");
const noopNotify = { info: () => {}, error: () => {} };

describe("resolveWorktreeBase", () => {
	it("returns the configured base unchanged when it is writable", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-base-writable-"));
		const base = resolveWorktreeBase(cwd, "../worktrees", noopNotify);
		assert.equal(base, resolve(cwd, "../worktrees"));
		rmSync(cwd, { recursive: true, force: true });
	});

	it("falls back to os.tmpdir()/cheasee-pi-worktrees when the base is unwritable", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-base-ro-"));
		const ro = join(cwd, "ro");
		mkdirSync(ro);
		chmodSync(ro, 0o555);
		try {
			const base = resolveWorktreeBase(cwd, "ro", noopNotify);
			assert.equal(base, FALLBACK);
			assert.ok(existsSync(FALLBACK), "fallback dir created");
		} finally {
			chmodSync(ro, 0o755);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("uses the configured base when only leading dirs are missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-base-missing-"));
		const base = resolveWorktreeBase(cwd, "not-yet-existing/deep", noopNotify);
		assert.equal(base, resolve(cwd, "not-yet-existing/deep"));
		rmSync(cwd, { recursive: true, force: true });
	});

	it("notifies when falling back", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-base-notify-"));
		const ro = join(cwd, "ro");
		mkdirSync(ro);
		chmodSync(ro, 0o555);
		let notified = false;
		try {
			resolveWorktreeBase(cwd, "ro", {
				info: () => {
					notified = true;
				},
				error: () => {},
			});
			assert.ok(notified, "notify.info called on fallback");
		} finally {
			chmodSync(ro, 0o755);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
