// ─── Tests: pipeline/worktree.ts — worktree removal guard ────────────
// The stale-worktree cleanup drives `rm -rf` from a repo-local JSON state
// file, so `worktreePath` is untrusted. These tests cover the pure
// path-policy helpers and the removal guard that gates the destructive step.
//
// Phase 1: parseWorktreeListPorcelain / canonicalizePath / isStrictlyInside
// Phase 2: fetchWorktreeAllowlist / verifyRemovableWorktree (adapter)
//
// Run: node --experimental-strip-types --test \
//        .pi/extensions/supervisor/test/pipeline/worktree-removal-guard.test.mts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	canonicalizePath,
	fetchWorktreeAllowlist,
	isStrictlyInside,
	parseWorktreeListPorcelain,
	verifyRemovableWorktree,
	type WorktreeEntry,
} from "../../pipeline/worktree.ts";

// ─── Helpers ──────────────────────────────────────────────────────

/** `git worktree list --porcelain -z` output: NUL-terminated fields and records. */
function porcelain(...records: Array<[string, ...string[]]>): string {
	return records
		.map(([path, ...attrs]) => ["worktree " + path, ...attrs].join("\0") + "\0\0")
		.join("");
}

function entry(path: string, overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
	return {
		path,
		bare: false,
		prunable: false,
		locked: false,
		detached: false,
		branch: "refs/heads/x",
		...overrides,
	};
}

function mockPi(code: number, stdout: string): ExtensionAPI {
	return {
		exec: (async () => ({
			code,
			stdout,
			stderr: code === 0 ? "" : "boom",
			killed: false,
		})) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

// ─── Phase 1: parseWorktreeListPorcelain ──────────────────────────

describe("parseWorktreeListPorcelain — Phase 1", () => {
	it("parses main + linked entries in listing order", () => {
		const entries = parseWorktreeListPorcelain(
			porcelain(
				["/a", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main"],
				["/b", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/x"],
			),
		);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].path, "/a");
		assert.equal(entries[0].bare, false);
		assert.equal(entries[1].path, "/b");
		assert.equal(entries[1].bare, false);
	});

	it("marks a bare record", () => {
		const entries = parseWorktreeListPorcelain(porcelain(["/a", "bare"]));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].bare, true);
	});

	it("marks detached / locked / prunable attributes", () => {
		const entries = parseWorktreeListPorcelain(
			porcelain([
				"/a",
				"HEAD 1111111111111111111111111111111111111111",
				"detached",
				"locked Locked by entrypoint.sh",
				"prunable gitdir file points to non-existent location",
			]),
		);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].detached, true);
		assert.equal(entries[0].locked, true);
		assert.equal(entries[0].prunable, true);
	});

	it("bare `locked` without a reason is still locked", () => {
		const entries = parseWorktreeListPorcelain(porcelain(["/a", "locked"]));
		assert.equal(entries[0].locked, true);
	});

	it("captures the branch ref and leaves it null when absent", () => {
		const entries = parseWorktreeListPorcelain(
			porcelain(["/a", "branch refs/heads/main"], ["/b", "detached"]),
		);
		assert.equal(entries[0].branch, "refs/heads/main");
		assert.equal(entries[1].branch, null);
	});

	it("keeps a path containing a newline as one entry (-z is NUL-delimited)", () => {
		const entries = parseWorktreeListPorcelain(
			porcelain(["/a\nb", "HEAD 1111111111111111111111111111111111111111"]),
		);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].path, "/a\nb");
	});

	it("returns [] for empty output", () => {
		assert.deepEqual(parseWorktreeListPorcelain(""), []);
	});

	it("ignores blank / whitespace-only records", () => {
		const entries = parseWorktreeListPorcelain("\0\0worktree /a\0HEAD 1111\0\0   \0");
		assert.equal(entries.length, 1);
		assert.equal(entries[0].path, "/a");
	});
});

// ─── Phase 1: canonicalizePath ────────────────────────────────────

describe("canonicalizePath — Phase 1", () => {
	let root: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "wt-canon-")));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns the realpath of an existing directory", () => {
		const dir = join(root, "existing");
		mkdirSync(dir);
		assert.equal(canonicalizePath(dir), realpathSync(dir));
	});

	it("resolves a missing leaf against its canonical parent", () => {
		const dir = join(root, "existing");
		mkdirSync(dir);
		assert.equal(canonicalizePath(join(dir, "missing")), join(realpathSync(dir), "missing"));
	});

	it("collapses `.` and `..` segments", () => {
		mkdirSync(join(root, "a"), { recursive: true });
		assert.equal(canonicalizePath(join(root, "a", "..")), root);
		assert.equal(canonicalizePath(join(root, "a", ".", "..", "a")), join(root, "a"));
	});

	it("surfaces an intermediate symlink that escapes the base", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "wt-canon-out-")));
		try {
			const base = join(root, "base");
			mkdirSync(base);
			symlinkSync(outside, join(base, "link"), "dir");

			// Missing leaf under the symlink → the resolved outside target is
			// returned, not masked back into the base.
			assert.equal(canonicalizePath(join(base, "link", "leaf")), join(outside, "leaf"));
			// Existing symlink itself → the outside target.
			assert.equal(canonicalizePath(join(base, "link")), outside);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("returns null when the parent does not exist", () => {
		assert.equal(canonicalizePath(join(root, "nope", "deep", "x")), null);
	});
});

// ─── Phase 1: isStrictlyInside ────────────────────────────────────

describe("isStrictlyInside — Phase 1", () => {
	it("rejects the base itself (whole-base deletion)", () => {
		assert.equal(isStrictlyInside("/a/base", "/a/base"), false);
	});

	it("accepts a proper descendant", () => {
		assert.equal(isStrictlyInside("/a/base", "/a/base/sub"), true);
	});

	it("rejects a separator-less sibling prefix", () => {
		assert.equal(isStrictlyInside("/a/base", "/a/base-evil"), false);
	});

	it("rejects a `..` escape that lands next to the base", () => {
		assert.equal(isStrictlyInside("/a/base", "/a/base/../base2"), false);
	});

	it("tolerates a trailing separator on the base", () => {
		assert.equal(isStrictlyInside("/a/base/", "/a/base/sub"), true);
		assert.equal(isStrictlyInside("/a/base/", "/a/base/"), false);
	});
});

// ─── Phase 2: fetchWorktreeAllowlist ──────────────────────────────

describe("fetchWorktreeAllowlist — Phase 2", () => {
	it("returns parsed entries on success", async () => {
		const pi = mockPi(0, porcelain(["/a", "bare"], ["/b", "branch refs/heads/x"]));
		const res = await fetchWorktreeAllowlist(pi, "/cwd");
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.value.length, 2);
			assert.equal(res.value[0].bare, true);
		}
	});

	it("fails closed on a non-zero exit", async () => {
		const res = await fetchWorktreeAllowlist(mockPi(128, ""), "/cwd");
		assert.equal(res.ok, false);
	});

	it("fails closed on empty stdout", async () => {
		const res = await fetchWorktreeAllowlist(mockPi(0, ""), "/cwd");
		assert.equal(res.ok, false);
	});
});

// ─── Phase 2: verifyRemovableWorktree ─────────────────────────────

describe("verifyRemovableWorktree — Phase 2", () => {
	let root: string;
	let base: string;
	let repo: string;
	let outside: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "wt-guard-")));
		base = join(root, "worktrees");
		repo = join(root, "repo");
		outside = realpathSync(mkdtempSync(join(tmpdir(), "wt-guard-out-")));
		mkdirSync(base, { recursive: true });
		mkdirSync(repo, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("accepts a registered linked worktree strictly inside the base", () => {
		const mainWt = join(root, "main-checkout");
		const wt = join(base, "wt-1");
		mkdirSync(mainWt);
		mkdirSync(wt);

		const res = verifyRemovableWorktree([entry(mainWt), entry(wt)], repo, base, wt);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.value, wt);
		}
	});

	it("accepts a worktree whose directory is already gone (stale dir)", () => {
		const mainWt = join(root, "main-checkout");
		mkdirSync(mainWt);
		const gone = join(base, "wt-gone"); // never created

		const res = verifyRemovableWorktree([entry(mainWt), entry(gone)], repo, base, gone);
		assert.equal(res.ok, true);
	});

	it("rejects the base itself", () => {
		const res = verifyRemovableWorktree([entry(join(root, "main-checkout"))], repo, base, base);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /outside worktree base/);
		}
	});

	it("rejects a path outside the base (/workspaces/main style)", () => {
		const mainWt = join(root, "main-checkout");
		mkdirSync(mainWt);
		// `main-checkout` exists and is listed, but lives outside the worktree base.
		const res = verifyRemovableWorktree([entry(mainWt)], repo, base, mainWt);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /outside worktree base/);
		}
	});

	it("rejects the main worktree (first listing entry) even though it is listed", () => {
		const mainWt = join(base, "main-checkout"); // inside the base
		const wt = join(base, "wt-1");
		mkdirSync(mainWt);
		mkdirSync(wt);

		const res = verifyRemovableWorktree([entry(mainWt), entry(wt)], repo, base, mainWt);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /main worktree/);
		}
	});

	it("rejects the repository root the supervisor runs from", () => {
		// base contains the repo root in the real deployment (base "../" → /workspaces)
		const res = verifyRemovableWorktree([entry(repo), entry(join(base, "wt-1"))], repo, root, repo);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /main repository root/);
		}
	});

	it("rejects a bare entry", () => {
		const bare = join(root, ".bare");
		const wt = join(root, "wt-1");
		mkdirSync(bare);
		mkdirSync(wt);

		const res = verifyRemovableWorktree(
			[entry(bare, { bare: true }), entry(wt)],
			repo,
			root, // base = root so the bare dir is strictly inside
			bare,
		);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /bare repository/);
		}
	});

	it("rejects a path inside the base that is not in the worktree listing", () => {
		const mainWt = join(root, "main-checkout");
		mkdirSync(mainWt);
		const unlisted = join(base, "wt-unlisted");
		mkdirSync(unlisted);

		const res = verifyRemovableWorktree([entry(mainWt)], repo, base, unlisted);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /not a registered worktree/);
		}
	});

	it("rejects a symlink inside the base whose realpath escapes it", () => {
		const mainWt = join(root, "main-checkout");
		mkdirSync(mainWt);
		const link = join(base, "link");
		symlinkSync(outside, link, "dir");

		const res = verifyRemovableWorktree([entry(mainWt), entry(link)], repo, base, link);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /outside worktree base/);
		}
	});

	it("fails closed when the allowlist is empty", () => {
		const wt = join(base, "wt-1");
		mkdirSync(wt);
		const res = verifyRemovableWorktree([], repo, base, wt);
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /no registered worktrees/);
		}
	});

	it("resolves a relative candidate against cwd, not process.cwd()", () => {
		// cwd is the repo root here; the candidate is relative to it.
		const wt = join(base, "wt-1");
		mkdirSync(wt);
		mkdirSync(join(root, "main-checkout"));

		const res = verifyRemovableWorktree(
			[entry(join(root, "main-checkout")), entry(wt)],
			root, // cwd
			base,
			join("worktrees", "wt-1"),
		);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.value, wt);
		}
	});

	it("resolves a relative listing entry against its admin dir (docker worktree layout)", () => {
		// Regression guard: the docker bootstrap rewrites
		// `.bare/worktrees/<id>/gitdir` to a relative path, so `git worktree list`
		// prints `../../../worktrees/wt-1` — relative to that admin dir, never to
		// cwd. Resolving against cwd would silently disable every cleanup.
		const bareDir = join(root, ".bare");
		const wt = join(base, "wt-1");
		mkdirSync(join(bareDir, "worktrees", "wt-1"), { recursive: true });
		mkdirSync(wt);

		const res = verifyRemovableWorktree(
			[entry(bareDir, { bare: true }), entry("../../../worktrees/wt-1")],
			repo,
			base,
			wt,
		);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.value, wt);
		}
	});

	it("rejects the worktree carrying the default branch even when it is a listed linked worktree", () => {
		// Bare+linked docker layout: the main checkout is an ordinary linked
		// entry (not the first entry, whose bare dir is listed first), so only
		// the branch it carries identifies it.
		const bare = join(root, ".bare");
		const mainWtInBase = join(base, "main");
		const wt = join(base, "wt-1");
		mkdirSync(join(bare, "worktrees"), { recursive: true });
		mkdirSync(mainWtInBase);
		mkdirSync(wt);

		const entries = [
			entry(bare, { bare: true }),
			entry("../../../worktrees/main", { branch: "refs/heads/main" }),
			entry("../../../worktrees/wt-1"),
		];

		const res = verifyRemovableWorktree(entries, repo, base, mainWtInBase, "main");
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /default branch main/);
		}

		// The sibling worktree on a normal branch is still removable.
		const okRes = verifyRemovableWorktree(entries, repo, base, wt, "main");
		assert.equal(okRes.ok, true);
	});

	it("rejects when the base cannot be canonicalized", () => {
		const wt = join(base, "wt-1");
		mkdirSync(wt);
		const res = verifyRemovableWorktree([entry(wt)], repo, join(root, "missing", "deep"), wt);
		assert.equal(res.ok, false);
	});

	it("returned path is always canonical (the raw state-file string never reaches a delete)", () => {
		const wt = join(base, "wt-1");
		mkdirSync(wt);
		const res = verifyRemovableWorktree(
			[entry(join(root, "main-checkout")), entry(wt)],
			repo,
			base,
			join(base, ".", "wt-1", ""),
		);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.value, resolve(wt));
			assert.equal(res.value, wt);
		}
	});
});
