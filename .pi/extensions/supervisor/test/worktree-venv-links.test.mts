/**
 * Unit tests for linkWorktreeVenvs (supervisor pipeline/worktree.ts).
 *
 * Regression for the "Venv setup previously failed after N attempts" cascade:
 * worktrees start without the prebuilt web_search/web_crawl venvs, so the first
 * web_crawl call in a subagent rebuilt them via pip install over the flaky
 * container network and failed mid-download. Linking the main repo's prebuilt
 * venvs into the worktree makes ensureVenv's quick-verify pass immediately.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkWorktreeVenvs } from "../pipeline/worktree.ts";

function makeFixture(): { cwd: string; worktree: string } {
	const base = mkdtempSync(path.join(os.tmpdir(), "worktree-venv-"));
	const cwd = path.join(base, "main");
	const worktree = path.join(base, "worktree");
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	mkdirSync(worktree, { recursive: true });
	return { cwd, worktree };
}

describe("linkWorktreeVenvs", () => {
	it("(entity) links prebuilt scrapling + web-search venvs as symlinks", async () => {
		const { cwd, worktree } = makeFixture();
		// prebuilt venvs in main's .pi (real dirs with a sentinel file)
		for (const name of ["scrapling-venv", "web-search-venv"]) {
			const venv = path.join(cwd, ".pi", name);
			mkdirSync(venv, { recursive: true });
			writeFileSync(path.join(venv, "sentinel"), name);
		}

		await linkWorktreeVenvs(cwd, worktree);

		for (const name of ["scrapling-venv", "web-search-venv"]) {
			const link = path.join(worktree, ".pi", name);
			assert.ok(lstatSync(link).isSymbolicLink(), `${name} should be a symlink`);
			assert.ok(existsSync(link), `${name} symlink should resolve to an existing venv`);
			// resolves back to main's prebuilt venv
			assert.equal(
				realpathSync(link),
				path.join(cwd, ".pi", name),
				`${name} should resolve to main's prebuilt venv`,
			);
		}
	});

	it("(entity) leaves worktree alone when main has no prebuilt venv (dev machine)", async () => {
		const { cwd, worktree } = makeFixture();

		await linkWorktreeVenvs(cwd, worktree);

		assert.equal(
			existsSync(path.join(worktree, ".pi", "scrapling-venv")),
			false,
			"no link should be created when source venv is absent — ensureVenv builds fresh",
		);
	});

	it("(entity) replaces a stale venv dir/symlink from a previous run", async () => {
		const { cwd, worktree } = makeFixture();
		const venv = path.join(cwd, ".pi", "scrapling-venv");
		mkdirSync(venv, { recursive: true });
		writeFileSync(path.join(venv, "sentinel"), "scrapling-venv");
		// stale REAL dir in the worktree (e.g. partial pip install from before the fix)
		const stale = path.join(worktree, ".pi", "scrapling-venv");
		mkdirSync(stale, { recursive: true });
		writeFileSync(path.join(stale, "partial-pip-artifact"), "x");

		await linkWorktreeVenvs(cwd, worktree);

		assert.ok(lstatSync(stale).isSymbolicLink(), "stale dir should be replaced by a symlink");
		assert.equal(realpathSync(stale), venv);
	});

	it("(entity) idempotent — running twice keeps a single symlink", async () => {
		const { cwd, worktree } = makeFixture();
		const venv = path.join(cwd, ".pi", "scrapling-venv");
		mkdirSync(venv, { recursive: true });

		await linkWorktreeVenvs(cwd, worktree);
		await linkWorktreeVenvs(cwd, worktree);

		const link = path.join(worktree, ".pi", "scrapling-venv");
		assert.ok(lstatSync(link).isSymbolicLink(), "still a symlink after second run");
		assert.equal(realpathSync(link), venv);
	});
});
