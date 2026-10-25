// ── Worktree name probe ─────────────────────────────────────────
// A linked worktree's `.git` is a pointer file (`gitdir: <path>`), not a
// directory; the name is the segment under `worktrees/`. Leaf module: reads
// the filesystem, owns no state.

import { existsSync, readFileSync } from "node:fs";

export function getWorktreeName(cwd: string): string | null {
	try {
		const gitFile = `${cwd}/.git`;
		if (!existsSync(gitFile)) return null;
		const content = readFileSync(gitFile, "utf-8");
		const match = content.match(/^gitdir:\s*(.+)$/m);
		if (!match) return null;
		const gitDir = match[1]!.trim();
		const wtMatch = gitDir.match(/worktrees\/(.+?)(\/|$)/);
		return wtMatch ? wtMatch[1]! : "worktree";
	} catch {
		return null;
	}
}
