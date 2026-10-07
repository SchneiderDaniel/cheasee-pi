/**
 * Verification tests for dead code removal (Issue #1877).
 *
 * Confirms the unused `import type { Dirent } from "node:fs"` is removed from
 * `prompts.ts` and `skills.ts`, while `markdown-resources.ts` remains the sole
 * legitimate owner of the `Dirent` type. Locator behavior is regression-guarded.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/dead-code-dirent-import.test.mts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";

const dir = import.meta.dirname;
const promptsPath = joinPath(dir, "../prompts.ts");
const skillsPath = joinPath(dir, "../skills.ts");
const markdownResourcesPath = joinPath(dir, "../markdown-resources.ts");

const read = (p: string): string => readFileSync(p, "utf-8");

// Locator entry parameter type, derived without a static `Dirent` import.
type Entry = Parameters<
	typeof import("../prompts.ts").promptsLocator
>[1];

const dirEntry = (name: string): Entry =>
	({ name, isDirectory: () => true, isFile: () => false }) as unknown as Entry;
const fileEntry = (name: string): Entry =>
	({ name, isDirectory: () => false, isFile: () => true }) as unknown as Entry;

describe("dead code removal — Issue #1877 (unused Dirent import)", () => {
	describe("Phase 1: Dirent import removed (static proof)", () => {
		it("prompts.ts matches no \\bDirent\\b token", () => {
			assert.doesNotMatch(read(promptsPath), /\bDirent\b/);
		});

		it("skills.ts matches no \\bDirent\\b token", () => {
			assert.doesNotMatch(read(skillsPath), /\bDirent\b/);
		});

		it("prompts.ts has no `import type { Dirent }` and no node:fs type-import line", () => {
			const content = read(promptsPath);
			assert.doesNotMatch(content, /import type \{ Dirent \}/);
			assert.doesNotMatch(content, /import type[^\n]*from "node:fs"/);
		});

		it("skills.ts has no `import type { Dirent }` and no node:fs type-import line", () => {
			const content = read(skillsPath);
			assert.doesNotMatch(content, /import type \{ Dirent \}/);
			assert.doesNotMatch(content, /import type[^\n]*from "node:fs"/);
		});

		it("markdown-resources.ts still owns the Dirent type", () => {
			assert.match(read(markdownResourcesPath), /\bDirent\b/);
		});
	});

	describe("Phase 2: surrounding imports and exports preserved", () => {
		it("prompts.ts keeps its runtime and shared-engine imports", () => {
			const content = read(promptsPath);
			for (const sym of [
				"readdirSync",
				"joinPath",
				"basename",
				"listMarkdownResources",
				"ResourceMeta",
				"Locator",
				"NameOf",
			]) {
				assert.ok(content.includes(sym), `prompts.ts missing import: ${sym}`);
			}
		});

		it("skills.ts keeps its runtime and shared-engine imports", () => {
			const content = read(skillsPath);
			for (const sym of [
				"existsSync",
				"joinPath",
				"basename",
				"dirname",
				"listMarkdownResources",
				"ResourceMeta",
				"Locator",
				"NameOf",
			]) {
				assert.ok(content.includes(sym), `skills.ts missing import: ${sym}`);
			}
		});

		it("prompts.ts dynamic import resolves and listLocalPrompts is a function", async () => {
			const mod = await import("../prompts.ts");
			assert.equal(typeof mod.listLocalPrompts, "function");
		});

		it("skills.ts dynamic import resolves and listLocalSkills is a function", async () => {
			const mod = await import("../skills.ts");
			assert.equal(typeof mod.listLocalSkills, "function");
		});
	});

	describe("Phase 3: locator behavior preserved (regression guard)", () => {
		it("resolves prompts and skills locators against real temp dirs", async () => {
			const { promptsLocator, listLocalPrompts } = await import("../prompts.ts");
			const { skillsLocator, listLocalSkills } = await import("../skills.ts");

			const tempDir = mkdtempSync(joinPath(tmpdir(), "ctx-info-"));
			try {
				mkdirSync(joinPath(tempDir, "sub"));
				writeFileSync(joinPath(tempDir, "sub", "a.md"), "# a");
				mkdirSync(joinPath(tempDir, "skillsub"));
				writeFileSync(joinPath(tempDir, "skillsub", "SKILL.md"), "# skill");
				writeFileSync(joinPath(tempDir, "x.md"), "# x");
				writeFileSync(joinPath(tempDir, "x.txt"), "txt");

				assert.deepEqual(promptsLocator(tempDir, dirEntry("sub")), [
					joinPath(tempDir, "sub", "a.md"),
				]);
				assert.deepEqual(promptsLocator(tempDir, fileEntry("x.md")), [
					joinPath(tempDir, "x.md"),
				]);
				assert.equal(promptsLocator(tempDir, fileEntry("x.txt")), null);

				assert.deepEqual(skillsLocator(tempDir, dirEntry("skillsub")), [
					joinPath(tempDir, "skillsub", "SKILL.md"),
				]);
				assert.equal(skillsLocator(tempDir, dirEntry(".gitkeep")), null);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}

			assert.ok(Array.isArray(listLocalPrompts()));
			assert.ok(Array.isArray(listLocalSkills()));
		});
	});
});
