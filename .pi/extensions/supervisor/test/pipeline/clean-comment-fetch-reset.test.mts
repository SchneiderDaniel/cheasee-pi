// ─── Tests: clean-code comment deletion (issue #1538) ─────────────
// Rule 2 (self-documenting code): the what-comments "Fetch latest from
// remote for this branch" / "Reset worktree to match remote tracking
// branch" restate the execChecked args verbatim, so they are deleted.
// Diff-scope static guards: the comments are gone, both call blocks are
// byte-identical, the rev-parse why-comment and error strings remain,
// and git diff against origin/main shows exactly two deleted lines.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKTREE_TS = resolve(__dirname, "../../pipeline/worktree.ts");
const REL_WORKTREE = ".pi/extensions/supervisor/pipeline/worktree.ts";

const COMMENT_FETCH = "// Fetch latest from remote for this branch";
const COMMENT_RESET = "// Reset worktree to match remote tracking branch";
const WHY_COMMENT = "// Check if remote tracking branch exists. The old try/catch-only guard";

// Expected call blocks verbatim (1-tab statement, 2-tab args).
const EXPECTED_FETCH = [
	'\tconst fetchRes = await execChecked(pi, "git", ["fetch", remote, worktreeBranch], {',
	"\t\tcwd,",
	"\t\ttimeout: 30000,",
	"\t});",
].join("\n");

const EXPECTED_RESET = [
	"\tconst resetRes = await execChecked(",
	"\t\tpi,",
	'\t\t"git",',
	'\t\t["reset", "--hard", `${remote}/${worktreeBranch}`],',
	"\t\t{ cwd: wtPath, timeout: 15000 },",
	"\t);",
].join("\n");

describe("clean-code #1538 — redundant what-comments removed", () => {
	it("worktree.ts contains neither comment nor its text", () => {
		const src = readFileSync(WORKTREE_TS, "utf-8");
		assert.ok(!src.includes(COMMENT_FETCH), "fetch comment still present in worktree.ts");
		assert.ok(!src.includes(COMMENT_RESET), "reset comment still present in worktree.ts");
		assert.ok(
			!src.includes("Fetch latest from remote for this branch"),
			"fetch comment text still present in worktree.ts",
		);
		assert.ok(
			!src.includes("Reset worktree to match remote tracking branch"),
			"reset comment text still present in worktree.ts",
		);
	});

	it("fetch call block is byte-identical (error behavior preserved)", () => {
		const src = readFileSync(WORKTREE_TS, "utf-8");
		assert.ok(src.includes(EXPECTED_FETCH), "expected fetch call block not found verbatim");
	});

	it("reset call block is byte-identical (error behavior preserved)", () => {
		const src = readFileSync(WORKTREE_TS, "utf-8");
		assert.ok(src.includes(EXPECTED_RESET), "expected reset call block not found verbatim");
	});

	it("rev-parse why-comment and error strings are preserved", () => {
		const src = readFileSync(WORKTREE_TS, "utf-8");
		assert.ok(src.includes(WHY_COMMENT), "rev-parse why-comment removed");
		assert.ok(
			src.includes("git fetch ${remote} ${worktreeBranch} failed:"),
			"fetch error string changed",
		);
		assert.ok(
			src.includes("git reset --hard ${remote}/${worktreeBranch} failed:"),
			"reset error string changed",
		);
	});
});

describe("clean-code #1538 — git diff scope vs origin/main", () => {
	it("diff is exactly 0 insertions and 2 deletions, the sole removed lines being the comments", () => {
		const numstat = execFileSync("git", ["diff", "--numstat", "origin/main", "--", REL_WORKTREE], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const m = numstat.trim().match(/^(\d+)\s+(\d+)\s+.+$/);
		assert.ok(m, `unexpected numstat output: ${numstat}`);
		assert.equal(m[1], "0", `expected 0 insertions, got ${m[1]}`);
		assert.equal(m[2], "2", `expected 2 deletions, got ${m[2]}`);

		const u0 = execFileSync("git", ["diff", "-U0", "origin/main", "--", REL_WORKTREE], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const removed = u0
			.split("\n")
			.filter((l) => l.startsWith("-") && !l.startsWith("---"))
			.map((l) => l.slice(1));
		assert.equal(removed.length, 2, `expected exactly 2 removed lines, got ${removed.length}`);
		const trimmed = removed.map((l) => l.trim());
		assert.ok(trimmed.includes(COMMENT_FETCH), `fetch comment not removed: ${trimmed}`);
		assert.ok(trimmed.includes(COMMENT_RESET), `reset comment not removed: ${trimmed}`);
	});
});
