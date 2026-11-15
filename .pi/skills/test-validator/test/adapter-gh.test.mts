// Phase 7b — the `gh` adapter translates only: argv arrays, a body file, and
// exit-code handling. No policy about what to file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GhCommandError, checkGhAuth, createGhIssueFiler } from "../lib/adapters/issue-gh.ts";
import type { GhSpawn } from "../lib/adapters/issue-gh.ts";

interface Recorded {
	program: string;
	args: string[];
}

function recordingSpawn(result: { code: number; stdout: string; stderr: string }): {
	spawn: GhSpawn;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const spawn: GhSpawn = async (program, args) => {
		calls.push({ program, args });
		return result;
	};
	return { spawn, calls };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "test-validator-gh-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("adapter: gh issue filer", () => {
	it("builds an argv array and passes the body through a file", async () => {
		await withTempDir(async (dir) => {
			const calls: Recorded[] = [];
			let bodyOnDisk = "";
			// Capture the body inside the spawn: the filer removes the temp file
			// as soon as the call returns.
			const spawn: GhSpawn = async (program, args) => {
				calls.push({ program, args: [...args] });
				const bodyPath = args[args.indexOf("--body-file") + 1];
				bodyOnDisk = readFileSync(bodyPath, "utf8");
				return { code: 0, stdout: "https://github.com/o/r/issues/12\n", stderr: "" };
			};
			const filer = createGhIssueFiler({ repo: "o/r", bodyDir: dir, spawn });
			const title = "Test quality review: 1 BAD tests";
			const body = "line with `backticks`, $(subshell), \"quotes\", and 'single'";

			const created = await filer.create({ title, body });

			assert.equal(calls.length, 1);
			const [call] = calls;
			assert.equal(call.program, "gh");
			assert.deepEqual(call.args.slice(0, 2), ["issue", "create"]);
			assert.equal(call.args[2], "--repo");
			assert.equal(call.args[3], "o/r");
			assert.equal(call.args[4], "--title");
			assert.equal(call.args[5], title);
			assert.equal(call.args[6], "--body-file");
			assert.equal(call.args.length, 8);
			assert.equal(bodyOnDisk, body, "body reaches gh verbatim through the file");
			assert.equal(created.url, "https://github.com/o/r/issues/12");
		});
	});

	it("carries the exit code and stderr on failure, with no URL", async () => {
		await withTempDir(async (dir) => {
			const { spawn } = recordingSpawn({
				code: 4,
				stdout: "",
				stderr: "HTTP 422: Validation Failed",
			});
			const filer = createGhIssueFiler({ repo: "o/r", bodyDir: dir, spawn });

			await assert.rejects(
				() => filer.create({ title: "t", body: "b" }),
				(err: unknown) => {
					assert.ok(err instanceof GhCommandError);
					assert.equal(err.exitCode, 4);
					assert.match(err.message, /Validation Failed/);
					return true;
				},
			);
		});
	});

	it("surfaces a missing gh binary", async () => {
		await withTempDir(async (dir) => {
			const spawn: GhSpawn = async () => {
				const err = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			};
			const filer = createGhIssueFiler({ repo: "o/r", bodyDir: dir, spawn });

			await assert.rejects(
				() => filer.create({ title: "t", body: "b" }),
				(err: unknown) => {
					assert.ok(err instanceof GhCommandError);
					assert.match(err.message, /gh.*not found|ENOENT/i);
					return true;
				},
			);
		});
	});

	it("finds a previously filed issue by its run marker", async () => {
		await withTempDir(async (dir) => {
			const runFingerprint = "e".repeat(64);
			const { spawn, calls } = recordingSpawn({
				code: 0,
				stdout: JSON.stringify([
					{ url: "https://github.com/o/r/issues/1", body: "unrelated" },
					{
						url: "https://github.com/o/r/issues/2",
						body: `<!-- test-validator-run:${runFingerprint} -->`,
					},
				]),
				stderr: "",
			});
			const filer = createGhIssueFiler({ repo: "o/r", bodyDir: dir, spawn });

			const found = await filer.search({ runFingerprint });

			assert.equal(found?.url, "https://github.com/o/r/issues/2");
			assert.equal(found?.runFingerprint, runFingerprint);
			assert.equal(calls[0].args[0], "issue");
			assert.equal(calls[0].args[1], "list");
			assert.ok(
				calls[0].args.includes(runFingerprint) ||
					calls[0].args.some((a) => a.includes(runFingerprint)),
			);
		});
	});

	it("returns null when the search finds nothing", async () => {
		await withTempDir(async (dir) => {
			const { spawn } = recordingSpawn({ code: 0, stdout: "[]", stderr: "" });
			const filer = createGhIssueFiler({ repo: "o/r", bodyDir: dir, spawn });

			assert.equal(await filer.search({ runFingerprint: "f".repeat(64) }), null);
		});
	});

	it("reports gh auth status failures", async () => {
		const failing: GhSpawn = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
		const state = await checkGhAuth(failing);

		assert.equal(state.ok, false);
		assert.match(state.message, /not logged in|gh auth/i);

		const passing: GhSpawn = async () => ({ code: 0, stdout: "Logged in", stderr: "" });
		assert.equal((await checkGhAuth(passing)).ok, true);
	});
});
