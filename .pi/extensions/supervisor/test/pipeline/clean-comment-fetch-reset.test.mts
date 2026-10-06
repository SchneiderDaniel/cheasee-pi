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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKTREE_TS = resolve(__dirname, "../../pipeline/worktree.ts");

const COMMENT_FETCH = "// Fetch latest from remote for this branch";
const COMMENT_RESET = "// Reset worktree to match remote tracking branch";
// #1680 replaced the local rev-parse probe with an authoritative ls-remote
// one, so the old rev-parse why-comment is gone; the new why-comment stands in.
const WHY_COMMENT = "// Probe the SERVER, not the local tracking ref.";

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
