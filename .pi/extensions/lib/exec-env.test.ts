// ─── Tests: lib/exec-env.ts — per-child env adapter ───────────────
// The adapter exists so a secret can be scoped to one child instead of
// process.env. These cases spawn real `node` children (fast, no network).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "./port-types.ts";
import { withPerChildEnv } from "./exec-env.ts";

const delegated: ExecFn = async () => ({ code: 0, stdout: "base", stderr: "" });

describe("withPerChildEnv", () => {
	it("passes opts.env to the child without writing process.env", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec(
			process.execPath,
			["-e", "process.stdout.write(process.env.PI_TEST_TOKEN ?? '')"],
			{ env: { PI_TEST_TOKEN: "tok-123" } },
		);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "tok-123");
		assert.equal(process.env.PI_TEST_TOKEN, undefined, "parent env untouched");
	});

	it("propagates a non-zero exit code", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec(process.execPath, ["-e", "process.exit(3)"], { env: {} });
		assert.equal(result.code, 3);
	});

	it("surfaces a spawn failure instead of hanging", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec("definitely-not-a-real-binary-xyz", [], { env: {} });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /ENOENT/);
	});

	it("delegates to the base exec when no env is requested", async () => {
		const exec = withPerChildEnv(delegated);
		const result = await exec("anything", []);
		assert.equal(result.stdout, "base");
	});
});
