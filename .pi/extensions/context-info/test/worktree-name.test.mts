// ─── Context-info environment probes (issue #2033 split) ────────────
// `contextInfo(pi)` stays the composition root; the linked-worktree name probe
// moved to `lib/worktree-name.ts`. The thinking-level probe mirrors pi's live
// level (`getThinkingLevel()`), falling back to the setting.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorktreeName } from "../lib/worktree-name.ts";
import { mirrorThinkingLevel } from "../lib/thinking-level.ts";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "context-info-"));

const withGitFile = (content: string): string => {
	const dir = tempDir();
	writeFileSync(join(dir, ".git"), content);
	return dir;
};

describe("getWorktreeName", () => {
	it("reads the worktree segment out of the gitdir pointer", () => {
		const dir = withGitFile("gitdir: /repo/.git/worktrees/feature-x\n");
		assert.equal(getWorktreeName(dir), "feature-x");
	});

	it("tolerates a gitdir without a trailing segment", () => {
		const dir = withGitFile("gitdir: /repo/.git/worktrees/feature-x");
		assert.equal(getWorktreeName(dir), "feature-x");
	});

	it("returns null outside a worktree", () => {
		assert.equal(getWorktreeName(tempDir()), null);
		const mainRepo = tempDir();
		mkdirSync(join(mainRepo, ".git"));
		assert.equal(getWorktreeName(mainRepo), null);
	});
});

describe("mirrorThinkingLevel", () => {
	it("prefers pi's live level", () => {
		const pi = { getThinkingLevel: () => "high" } as never;
		assert.equal(mirrorThinkingLevel(pi), "high");
	});

	it("falls back to the setting on a pi build without the getter", () => {
		assert.equal(mirrorThinkingLevel({} as never), "");
	});
});
