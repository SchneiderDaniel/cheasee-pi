/**
 * Tests for the shared OSV exec fakes (issue #2105).
 *
 * `../helpers/exec-fakes.ts` owns `ExecCall`, `createMockExec` and
 * `createRejectingExec`; the osv-scanner suites import them instead of
 * re-declaring byte-identical local copies.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/checks/osv-scanner-dedup.test.mts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createMockExec, createRejectingExec, type ExecCall } from "../helpers/exec-fakes.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── createRejectingExec ────────────────────────────────────────────────────

describe("createRejectingExec", () => {
	it("rejects with the same Error instance on the first and on repeated calls", async () => {
		const sentinel = new Error("boom");
		const exec = createRejectingExec(sentinel);

		const first = await exec("osv-scanner", ["--version"], {}).then(
			() => null,
			(err: unknown) => err,
		);
		assert.equal(first, sentinel);

		const second = await exec("osv-scanner", [], {}).then(
			() => null,
			(err: unknown) => err,
		);
		assert.equal(second, sentinel);
	});

	it("passes a non-Error rejection value through verbatim", async () => {
		const exec = createRejectingExec("boom");
		const err = await exec("cmd", [], {}).then(
			() => null,
			(e: unknown) => e,
		);
		assert.equal(err, "boom");
	});

	it("accepts (cmd, args, opts), ignores them, and returns a promise (no sync throw)", async () => {
		const exec = createRejectingExec(new Error("nope"));
		let promise: Promise<unknown> | undefined;
		assert.doesNotThrow(() => {
			promise = exec("cmd", ["a", "b"], { cwd: "/tmp" });
		});
		assert.ok(promise instanceof Promise, "returns a promise");
		await assert.rejects(promise!, /nope/);
	});
});

// ─── createMockExec ─────────────────────────────────────────────────────────

describe("createMockExec", () => {
	it("yields results in order, then falls back to an empty success result", async () => {
		const exec = createMockExec([
			{ code: 0, stdout: "one", stderr: "" },
			{ code: 1, stdout: "two", stderr: "err" },
		]);

		assert.deepEqual(await exec("a", [], {}), { code: 0, stdout: "one", stderr: "" });
		assert.deepEqual(await exec("b", [], {}), { code: 1, stdout: "two", stderr: "err" });
		assert.deepEqual(await exec("c", [], {}), { code: 0, stdout: "", stderr: "" });
	});

	it("appends every invocation to the call log (args default to []) and exposes it as .calls", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: "", stderr: "" }], calls);

		await exec("osv-scanner", ["--format", "json"], { cwd: "/repo" });
		await exec("osv-scanner", undefined as unknown as string[], undefined);

		assert.deepEqual(calls, [
			{ cmd: "osv-scanner", args: ["--format", "json"], opts: { cwd: "/repo" } },
			{ cmd: "osv-scanner", args: [], opts: undefined },
		]);
		assert.equal((exec as unknown as { calls: ExecCall[] }).calls, calls);
	});
});

// ─── Guards: one owner, no local copies in the test layer ───────────────────

describe("osv exec fake dedup guards", () => {
	const readSource = (file: string): string => readFileSync(join(here, file), "utf-8");
	const countOccurrences = (source: string, needle: string): number =>
		source.split(needle).length - 1;

	for (const file of [
		"osv-scanner.test.mts",
		"osv-scanner-part2.test.mts",
		"../dead-code.test.mts",
		"../dead-code-part2.test.mts",
		"../dead-code-part3.test.mts",
		"../duplicate-code-run.test.mts",
	]) {
		it(`${file} declares neither createRejectingExec nor createMockExec`, () => {
			const source = readSource(file);
			assert.equal(countOccurrences(source, "function createRejectingExec"), 0);
			assert.equal(countOccurrences(source, "function createMockExec"), 0);
		});
	}

	for (const file of ["../dead-code-part3.test.mts", "../duplicate-code-run.test.mts"]) {
		it(`${file} imports createMockExec from ./helpers/exec-fakes.ts`, () => {
			const importBlock = readSource(file).match(
				/import\s*\{([^}]*)\}\s*from\s*"\.\/helpers\/exec-fakes\.ts"/,
			);
			assert.ok(importBlock, `expected an import from ./helpers/exec-fakes.ts in ${file}`);
			assert.match(importBlock![1]!, /\bcreateMockExec\b/);
		});
	}

	for (const file of ["../dead-code.test.mts", "../dead-code-part2.test.mts"]) {
		it(`${file} declared the fake but used neither — no dead import introduced`, () => {
			const source = readSource(file);
			assert.equal(countOccurrences(source, "createMockExec"), 0);
			assert.equal(countOccurrences(source, "ExecCall"), 0);
		});
	}

	it("osv-scanner-part2.test.mts imports both fakes from ../helpers/exec-fakes.ts", () => {
		const source = readSource("osv-scanner-part2.test.mts");
		const importBlock = source.match(
			/import\s*\{([^}]*)\}\s*from\s*"\.\.\/helpers\/exec-fakes\.ts"/,
		);
		assert.ok(importBlock, "expected an import from ../helpers/exec-fakes.ts");
		assert.match(importBlock![1]!, /\bcreateMockExec\b/);
		assert.match(importBlock![1]!, /\bcreateRejectingExec\b/);
	});

	it("osv-scanner.test.mts declared both but used neither — no dead import introduced", () => {
		const source = readSource("osv-scanner.test.mts");
		assert.equal(countOccurrences(source, "createMockExec"), 0);
		assert.equal(countOccurrences(source, "createRejectingExec"), 0);
	});
});
