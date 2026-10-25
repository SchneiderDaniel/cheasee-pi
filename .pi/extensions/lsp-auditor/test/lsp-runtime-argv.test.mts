/**
 * Seam tests for the LSP runtime's argv invariant (issue: four CodeFlow
 * command-execution sites).
 *
 * `node:child_process` is intercepted with mock.module before the runtime is
 * dynamically imported, so the real spawn must never be reached on a rejected
 * argv. Mirrors the guard pattern in supervisor/test/runner-split.test.mts.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *     --test .pi/extensions/lsp-auditor/test/lsp-runtime-argv.test.mts
 */

import assert from "node:assert";
import { isAbsolute } from "node:path";
import { describe, it, mock } from "node:test";
import * as childProcessModule from "node:child_process";
import { UnsafeArgvError } from "../../lib/safe-argv.ts";

const hasMockModule = typeof mock.module === "function";

const spawnCalls: Array<{
	program: string;
	args: readonly string[];
	options: Record<string, unknown>;
}> = [];

if (hasMockModule) {
	const namedExports: Record<string, unknown> = {};
	for (const key of Object.keys(childProcessModule)) {
		namedExports[key] = (childProcessModule as any)[key];
	}
	namedExports["spawn"] = (
		program: string,
		args: readonly string[],
		options: Record<string, unknown>,
	) => {
		spawnCalls.push({ program, args, options });
		return { on: () => {}, removeAllListeners: () => {}, kill: () => true };
	};
	mock.module("node:child_process", { namedExports });
}

const loadRuntime = () => import("../lsp-client/runtime.ts");

// ─── resolveExecutable — no module mocking needed ──────────────────

describe("createDefaultRuntime.resolveExecutable", () => {
	it("resolves a real binary (node, git) to an absolute path", async () => {
		const { createDefaultRuntime } = await loadRuntime();
		const rt = createDefaultRuntime();
		for (const name of ["node", "git"]) {
			const resolved = rt.resolveExecutable(name);
			assert.ok(resolved && isAbsolute(resolved), `${name} must resolve to an absolute path`);
		}
	});

	it("returns null for an unknown binary", async () => {
		const { createDefaultRuntime } = await loadRuntime();
		assert.strictEqual(
			createDefaultRuntime().resolveExecutable("definitely-not-a-real-binary-xyz"),
			null,
		);
	});

	it("returns null for option injection and a NUL name", async () => {
		const { createDefaultRuntime } = await loadRuntime();
		const rt = createDefaultRuntime();
		assert.strictEqual(rt.resolveExecutable("-a"), null);
		assert.strictEqual(rt.resolveExecutable("node\0"), null);
	});

	it("the removed execFile port method is gone", async () => {
		const { createDefaultRuntime } = await loadRuntime();
		const rt = createDefaultRuntime();
		assert.strictEqual(typeof (rt as { execFile?: unknown }).execFile, "undefined");
		assert.strictEqual(typeof rt.resolveExecutable, "function");
	});
});

// ─── spawn — argv invariant at the seam ────────────────────────────

if (!hasMockModule) {
	describe("createDefaultRuntime.spawn — argv invariant", () => {
		it("requires --experimental-test-module-mocks flag", (t) => t.skip());
	});
} else {
	describe("createDefaultRuntime.spawn — argv invariant", () => {
		it("valid argv reaches the intercepted spawn unchanged, with shell:false (positive control)", async () => {
			const { createDefaultRuntime } = await loadRuntime();
			spawnCalls.length = 0;
			createDefaultRuntime().spawn("/usr/bin/node", ["--version"], { cwd: "/tmp" });

			assert.strictEqual(spawnCalls.length, 1, "the real spawn must be reached for a valid call");
			assert.strictEqual(spawnCalls[0]!.program, "/usr/bin/node");
			assert.deepStrictEqual(spawnCalls[0]!.args, ["--version"]);
			assert.strictEqual(spawnCalls[0]!.options.shell, false);
		});

		it("a NUL arg throws UnsafeArgvError and never reaches spawn", async () => {
			const { createDefaultRuntime } = await loadRuntime();
			spawnCalls.length = 0;
			assert.throws(
				() => createDefaultRuntime().spawn("/usr/bin/node", ["bad\0arg"], {}),
				UnsafeArgvError,
			);
			assert.strictEqual(spawnCalls.length, 0, "spawn must not be called after a rejection");
		});

		it("options.shell:true throws and never reaches spawn", async () => {
			const { createDefaultRuntime } = await loadRuntime();
			spawnCalls.length = 0;
			assert.throws(
				() => createDefaultRuntime().spawn("/usr/bin/node", ["--version"], { shell: true }),
				UnsafeArgvError,
			);
			assert.strictEqual(spawnCalls.length, 0, "spawn must not be called after a rejection");
		});
	});
}
