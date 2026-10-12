/**
 * Seam test for the context-info git invocation (issue: four CodeFlow
 * command-execution sites).
 *
 * `node:child_process.execFile` is intercepted before `../codeflow.ts` is
 * dynamically imported, so the exact program/argv/options are observable.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *     --test .pi/extensions/context-info/test/codeflow-git-argv.test.mts
 */

import assert from "node:assert";
import { dirname, join } from "node:path";
import { describe, it, mock } from "node:test";
import { promisify } from "node:util";
import * as childProcessModule from "node:child_process";

const hasMockModule = typeof mock.module === "function";

const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
let execError: Error | null = null;
const stdout = "git@github.com:alice/foo.git\n";

if (hasMockModule) {
	const namedExports: Record<string, unknown> = {};
	for (const key of Object.keys(childProcessModule)) {
		namedExports[key] = (childProcessModule as any)[key];
	}
	// Mirror the real execFile's promisify.custom, which resolves `{stdout, stderr}`
	// (generic promisify would resolve an array instead).
	const fakeExecFile = Object.assign(
		(_file: string, _args: readonly string[], _options: Record<string, unknown>, callback: Function) => {
			callback(new Error("use the promisified form"), "", "");
		},
		{
			[promisify.custom]: async (
				file: string,
				args: readonly string[],
				options: Record<string, unknown>,
			) => {
				calls.push({ file, args, options });
				if (execError) throw execError;
				return { stdout, stderr: "" };
			},
		},
	);
	namedExports["execFile"] = fakeExecFile;
	mock.module("node:child_process", { namedExports });
}

const { repoSlug } = (await import("../codeflow.ts")) as typeof import("../codeflow.ts");

if (!hasMockModule) {
	describe("bareRepoURL git invocation", () => {
		it("requires --experimental-test-module-mocks", (t) => t.skip());
	});
} else {
	describe("bareRepoURL git invocation", () => {
		it("invokes execFile with a literal 'git' argv and shell:false", async () => {
			calls.length = 0;
			execError = null;
			const root = "/tmp/ws";

			const slug = await repoSlug(root);

			assert.strictEqual(calls.length, 1, "one git invocation");
			assert.strictEqual(calls[0]!.file, "git", "program is the literal 'git'");
			assert.deepStrictEqual(calls[0]!.args, [
				"--git-dir",
				join(dirname(root), ".bare"),
				"config",
				"--get",
				"remote.origin.url",
			]);
			assert.strictEqual(calls[0]!.options.shell, false);
			assert.strictEqual(slug, "alice-foo", "remote-derived slug");
		});

		it("falls back to the workspace basename when git fails", async () => {
			calls.length = 0;
			execError = new Error("not a git directory");

			const slug = await repoSlug("/tmp/ws");

			assert.strictEqual(calls.length, 1);
			assert.strictEqual(slug, "ws");
		});
	});
}
