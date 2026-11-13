// ─── Tests: lib/exec-env.ts — per-child env adapter ───────────────
// The adapter exists so a secret can be scoped to one child instead of
// process.env. These cases spawn real `node` children (fast, no network).
//
// The fixtures are script *files* written into a temp dir, never `node -e`:
// the argv policy rejects an interpreter's code flag by design, so the eval
// form cannot be the fixture.

import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExecFn } from "./port-types.ts";
import { withPerChildEnv } from "./exec-env.ts";

const delegated: ExecFn = async () => ({ code: 0, stdout: "base", stderr: "" });

// Keys a `withPerChildEnv` caller may scope to one child, plus the channels the
// policy must drop and PATH as the positive control.
const PROBE_KEYS = [
	"PI_TEST_TOKEN",
	"GH_TOKEN",
	"NODE_OPTIONS",
	"LD_PRELOAD",
	"GIT_SSH_COMMAND",
	"GIT_CONFIG_COUNT",
	"PATH",
];

const FIXTURES = mkdtempSync(join(tmpdir(), "exec-env-"));
const PRINT_ENV = join(FIXTURES, "print-env.mjs");
const EXIT_CODE = join(FIXTURES, "exit-code.mjs");
const SLEEP = join(FIXTURES, "sleep.mjs");

writeFileSync(
	PRINT_ENV,
	[
		`const keys = ${JSON.stringify(PROBE_KEYS)};`,
		"const env = {};",
		"for (const k of keys) env[k] = typeof process.env[k] === 'string' ? process.env[k] : null;",
		"process.stdout.write(JSON.stringify({ env, cwd: process.cwd() }));",
	].join("\n"),
);
writeFileSync(EXIT_CODE, "process.exit(Number(process.argv[2] ?? 0));\n");
writeFileSync(SLEEP, "setTimeout(() => {}, 30_000);\n");

after(() => rmSync(FIXTURES, { recursive: true, force: true }));

/** Run `print-env.mjs` through the adapter and parse what the child saw. */
async function probe(env: Record<string, string>, opts: { cwd?: string } = {}) {
	const exec = withPerChildEnv(delegated);
	const result = await exec(process.execPath, [PRINT_ENV], { env, ...opts });
	assert.equal(result.code, 0, `child must succeed, stderr: ${result.stderr}`);
	return JSON.parse(result.stdout) as { env: Record<string, string | null>; cwd: string };
}

describe("withPerChildEnv", () => {
	it("passes opts.env to the child without writing process.env", async () => {
		const seen = await probe({ PI_TEST_TOKEN: "tok-123" });
		assert.equal(seen.env.PI_TEST_TOKEN, "tok-123");
		assert.equal(process.env.PI_TEST_TOKEN, undefined, "parent env untouched");
	});

	it("drops env execution channels while keeping the scoped variables", async () => {
		const seen = await probe({
			NODE_OPTIONS: "--require /tmp/hook.cjs",
			LD_PRELOAD: "/tmp/lib.so",
			GIT_SSH_COMMAND: "sh -c id",
			GIT_CONFIG_COUNT: "1",
			PI_TEST_TOKEN: "tok-123",
		});

		assert.equal(seen.env.NODE_OPTIONS, null, "NODE_OPTIONS must not reach the child");
		assert.equal(seen.env.LD_PRELOAD, null, "LD_PRELOAD must not reach the child");
		assert.equal(seen.env.GIT_SSH_COMMAND, null, "GIT_SSH_COMMAND must not reach the child");
		assert.equal(seen.env.GIT_CONFIG_COUNT, null, "GIT_CONFIG_* must not reach the child");
		assert.equal(seen.env.PI_TEST_TOKEN, "tok-123", "the scoped secret must survive");
		assert.equal(typeof seen.env.PATH, "string", "PATH is inherited (positive control)");
	});

	it("keeps GH_TOKEN — the only key production callers scope here", async () => {
		const seen = await probe({ GH_TOKEN: "ghp_test_123" });
		assert.equal(seen.env.GH_TOKEN, "ghp_test_123");
	});

	it("still honours opts.cwd", async () => {
		const seen = await probe({}, { cwd: FIXTURES });
		assert.equal(realpathSync(seen.cwd), realpathSync(FIXTURES));
	});

	it("propagates a non-zero exit code", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec(process.execPath, [EXIT_CODE, "3"], { env: {} });
		assert.equal(result.code, 3);
	});

	it("maps an interpreter code flag to {code:1} instead of throwing", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec(process.execPath, ["-e", "process.exit(0)"], { env: {} });
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Unsafe args/);
	});

	it("maps a NUL arg to {code:1} carrying the policy message", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec(process.execPath, [PRINT_ENV, "bad\0arg"], { env: {} });
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Unsafe arg/);
	});

	it("surfaces a spawn failure instead of hanging", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec("definitely-not-a-real-binary-xyz", [], { env: {} });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /ENOENT/);
	});

	it("forwards the abort signal — a long child is killed well before its lifetime", async () => {
		const exec = withPerChildEnv(delegated);
		const controller = new AbortController();
		const pending = exec(process.execPath, [SLEEP], { env: {}, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const result = await pending;
		assert.notEqual(result.code, 0, "an aborted child must not report success");
	});

	it("delegates to the base exec when no env is requested", async () => {
		const calls: Array<[string, string[], unknown]> = [];
		const base: ExecFn = async (cmd, args, opts) => {
			calls.push([cmd, args, opts]);
			return { code: 0, stdout: "base", stderr: "" };
		};
		const exec = withPerChildEnv(base);
		const opts = { cwd: "/tmp" };
		const result = await exec("anything", ["a"], opts);

		assert.equal(result.stdout, "base");
		assert.deepEqual(calls, [["anything", ["a"], opts]], "base exec sees the call unchanged");
		assert.equal(process.env.PI_TEST_TOKEN, undefined, "no child env was written");
	});
});
