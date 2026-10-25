import assert from "node:assert";

import { describe, it, afterEach } from "node:test";

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";

import { join, resolve, dirname } from "node:path";

import { tmpdir } from "node:os";

import { execSync } from "node:child_process";

import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(__filename);

const FIX_SCRIPT = resolve(__dirname, "../../cmd/cheasee-pi/embedded/docker/lib/worktree-fix.sh");

function createFixture(files: Record<string, string>): string {
	const tmp = mkdtempSync(join(tmpdir(), "worktree-fix-"));
	for (const [relPath, content] of Object.entries(files)) {
		const absPath = join(tmp, relPath);
		mkdirSync(dirname(absPath), { recursive: true });
		writeFileSync(absPath, content, "utf-8");
	}
	return tmp;
}

function runFix(workspaceBase: string): { stdout: string; stderr: string } {
	const cmd = `bash -c 'source "${FIX_SCRIPT}" && unbreak_worktrees "${workspaceBase}"' 2>&1`;
	try {
		const stdout = execSync(cmd, {
			encoding: "utf-8",
			timeout: 5000,
		});
		return { stdout, stderr: "" };
	} catch (e: unknown) {
		const err = e as { stderr?: string; stdout?: string; message?: string };
		return {
			stdout: err.stdout?.toString() ?? "",
			stderr: err.stderr?.toString() ?? err.message ?? "unknown error",
		};
	}
}

function readFileOrNull(workspaceBase: string, relPath: string): string | null {
	const absPath = join(workspaceBase, relPath);
	try {
		return readFileSync(absPath, "utf-8").trim();
	} catch {
		return null;
	}
}

function addWorktreeAbs(base: string, id: string, hostPrefix: string = "/home/user/git"): void {
	mkdirSync(join(base, id), { recursive: true });
	writeFileSync(join(base, `${id}/.git`), `gitdir: ${hostPrefix}/.bare/worktrees/${id}`);
	mkdirSync(join(base, `.bare/worktrees/${id}`), { recursive: true });
	writeFileSync(join(base, `.bare/worktrees/${id}/gitdir`), `${hostPrefix}/${id}/.git`);
}

function destroyFixture(tmp: string): void {
	rmSync(tmp, { recursive: true, force: true });
}

describe("BARE_DIR discovery", () => {
	let tmp: string;

	afterEach(() => {
		if (tmp) destroyFixture(tmp);
	});

	it("discovers bare dir from main/.git content", () => {
		tmp = createFixture({
			"main/.git": "gitdir: /workspaces/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/workspaces/main/.git",
		});

		const result = runFix(tmp);
		assert.ok(result.stdout.includes("BARE_DIR="));
	});

	it("falls back to .bare/ when main/.git has already-relative content", () => {
		tmp = createFixture({
			"main/.git": "gitdir: ../.bare/worktrees/main",
			".bare/HEAD": "ref: refs/heads/main",
			".bare/worktrees/main/gitdir": "../../../main/.git",
		});

		const result = runFix(tmp);
		// Should find .bare via fallback
		assert.ok(result.stdout.includes("BARE_DIR="));
		assert.ok(result.stdout.includes("Worktree fix complete"));
	});

	it("skips fix when no .bare directory exists anywhere", () => {
		tmp = createFixture({
			"some-dir/file.txt": "hello",
		});

		const result = runFix(tmp);
		assert.ok(result.stdout.includes("Could not find .bare directory"));
	});
});
