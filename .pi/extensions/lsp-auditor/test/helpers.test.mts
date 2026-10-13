/**
 * Tests for .pi/extensions/lsp-auditor/test/helpers.ts — the shared git/error
 * fixtures for the lsp-auditor suites.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/helpers.test.mts
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { errorDiag, makeGitFixture } from "./helpers.ts";

describe("errorDiag", () => {
	it("pins the range and severity with a default message", () => {
		assert.deepStrictEqual(errorDiag(), {
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			severity: 1,
			message: "mock error",
		});
	});

	it("accepts a custom message", () => {
		assert.strictEqual(errorDiag("x").message, "x");
	});
});

describe("makeGitFixture", () => {
	let dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs = [];
	});

	const fixture = (prefix: string) => {
		const dir = makeGitFixture(prefix);
		dirs.push(dir);
		return dir;
	};

	it("returns a committed main repo with a modified src/app.ts and .pi/settings.json", () => {
		const dir = fixture("lsp-preaudit-");
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
		assert.strictEqual(branch, "main");
		const diff = execFileSync("git", ["diff", "main", "--name-only"], { cwd: dir, encoding: "utf-8" });
		assert.ok(diff.split("\n").includes("src/app.ts"), `modified file must be listed: ${diff}`);
		assert.ok(existsSync(join(dir, ".pi/settings.json")));
		const settings = JSON.parse(readFileSync(join(dir, ".pi/settings.json"), "utf-8"));
		assert.strictEqual(settings.lspAuditor.servers[0].command, "mock-lsp");
	});

	it("honours the given prefix and yields independent directories", () => {
		const a = fixture("lsp-cmd-");
		const b = fixture("lsp-cmd-");
		assert.ok(a.includes("lsp-cmd-"));
		assert.notStrictEqual(a, b);
	});
});
