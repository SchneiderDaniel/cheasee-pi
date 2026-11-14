/**
 * Tests for the shared git test harness (issue #2105).
 *
 * `git.test.mts`, `git-part2.test.mts` and `git-part3.test.mts` each carried a
 * byte-identical 94-line copy of `realGitExec` / `realGit` /
 * `initWorkflowFixture` / `createMockExec` / `createMockNotify`. The harness
 * lives once in `../helpers/git-harness.mts`; the suites import it.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/supervisor/test/github/git-harness-dedup.test.mts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createMockExec,
	createMockNotify,
	initWorkflowFixture,
	realGit,
	realGitExec,
} from "../helpers/git-harness.mts";

const here = dirname(fileURLToPath(import.meta.url));

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// ─── createMockExec(): scripted ExecFn ──────────────────────────────────────

describe("git-harness createMockExec() — scripted ExecFn", () => {
	it("returns results in call order and spreads killed: false", async () => {
		const { exec } = createMockExec([
			{ code: 0, stdout: "first", stderr: "" },
			{ code: 1, stdout: "", stderr: "boom" },
		]);

		const a = await exec("git", ["status"]);
		const b = await exec("git", ["push"]);

		assert.deepEqual(a, { code: 0, stdout: "first", stderr: "", killed: false });
		assert.deepEqual(b, { code: 1, stdout: "", stderr: "boom", killed: false });
	});

	it("returns an empty success result once results are exhausted", async () => {
		const { exec } = createMockExec([]);

		const result = await exec("git", ["diff"]);

		assert.deepEqual(result, { code: 0, stdout: "", stderr: "", killed: false });
	});

	it("records every invocation with args defaulting to [] and opts defaulting to {}", async () => {
		const { exec, calls } = createMockExec([]);

		await exec("git", undefined as unknown as string[], undefined);
		await exec("git", ["commit", "-m", "x"], { cwd: "/tmp/repo" });

		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0], { cmd: "git", args: [], opts: {} });
		assert.deepEqual(calls[1], {
			cmd: "git",
			args: ["commit", "-m", "x"],
			opts: { cwd: "/tmp/repo" },
		});
	});
});

// ─── createMockNotify(): recorded notifications ─────────────────────────────

describe("git-harness createMockNotify() — recorded notifications", () => {
	it("records info and error calls with their level", () => {
		const { notify, calls } = createMockNotify();

		notify.info("hello");
		notify.error("bad thing");

		assert.deepEqual(calls, [
			{ level: "info", msg: "hello" },
			{ level: "error", msg: "bad thing" },
		]);
	});

	it("starts with an empty call log", () => {
		const { calls } = createMockNotify();

		assert.deepEqual(calls, []);
	});
});

// ─── realGitExec() / realGit(): real git shell-out harness ──────────────────

describe("git-harness realGitExec()/realGit() — real git shell-out", () => {
	it("runs a real git command and reports code 0 with stdout", async () => {
		const result = await realGitExec(here)("git", ["--version"]);

		assert.equal(result.code, 0);
		assert.match(result.stdout, /git version/);
	});

	it("fails closed with a non-zero code instead of throwing on a bad command", async () => {
		const result = await realGitExec(here)("git", ["definitely-not-a-command"]);

		assert.notEqual(result.code, 0);
	});

	it("realGit() rejects with a descriptive error when git fails", async () => {
		await assert.rejects(
			() => realGit(here, ["definitely-not-a-command"]),
			/git definitely-not-a-command failed:/,
		);
	});

	it("realGit() resolves when git succeeds", async () => {
		await realGit(here, ["--version"]);
	});
});

// ─── initWorkflowFixture(): real-git workflow-exemption fixture ────────────

describe("git-harness initWorkflowFixture() — workflow exemption fixture", () => {
	it("creates the repo with a bare origin and a cleanup that removes it", async () => {
		const fixture = await initWorkflowFixture();
		try {
			assert.ok(existsSync(fixture.dir), "fixture dir exists");
			assert.ok(existsSync(join(fixture.dir, ".git", "config")), "feature clone is a git repo");
			assert.ok(existsSync(join(fixture.dir, "README.md")), "base commit has README.md");
		} finally {
			fixture.cleanup();
		}

		assert.equal(existsSync(fixture.dir), false, "cleanup removed the fixture dir");
	});
});

// ─── Guard: no local harness copies left in the git suites ─────────────────

describe("git.ts suites declare no local harness copies", () => {
	const FILES = ["git.test.mts", "git-part2.test.mts", "git-part3.test.mts"];
	const FUNCTIONS = [
		"realGitExec",
		"realGit",
		"initWorkflowFixture",
		"createMockExec",
		"createMockNotify",
	];

	for (const file of FILES) {
		it(`${file} declares none of the shared harness members`, () => {
			const source = readFileSync(join(here, file), "utf8");

			for (const fn of FUNCTIONS) {
				assert.equal(
					countOccurrences(source, `function ${fn}(`),
					0,
					`${file} must not declare function ${fn}()`,
				);
			}
			assert.equal(
				countOccurrences(source, "interface ExecCall"),
				0,
				`${file} must not declare interface ExecCall`,
			);
		});
	}

	it("the harness itself owns exactly one copy of each member", () => {
		const source = readFileSync(join(here, "../helpers/git-harness.mts"), "utf8");

		for (const fn of FUNCTIONS) {
			const exported = source.match(new RegExp(`export (async )?function ${fn}\\(`, "g")) ?? [];
			assert.equal(exported.length, 1, `git-harness.mts must export function ${fn}() exactly once`);
		}
		assert.equal(
			countOccurrences(source, "export interface ExecCall"),
			1,
			"git-harness.mts must export interface ExecCall exactly once",
		);
	});
});

// ─── Guard: no dead `createMockExec` copies in the github suites ───────────

describe("github suites carry no unused createMockExec copies", () => {
	// Both suites declared this 3-line factory and never called it. `gh-client`
	// keeps its own variant — different signature (envLog), single owner.
	for (const file of ["comment.test.mts", "comment-part2.test.mts"]) {
		it(`${file} declares no createMockExec`, () => {
			const source = readFileSync(join(here, file), "utf8");

			assert.equal(
				countOccurrences(source, "function createMockExec("),
				0,
				`${file} must not declare createMockExec()`,
			);
			assert.equal(
				countOccurrences(source, "createMockExec("),
				0,
				`${file} must not reference createMockExec()`,
			);
		});
	}
});
