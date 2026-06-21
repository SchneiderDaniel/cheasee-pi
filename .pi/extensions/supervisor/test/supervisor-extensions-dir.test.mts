/**
 * Tests for directory-aware extension resolution in supervisor/extensions.ts
 *
 * Replaces the old duplicate-based tests with direct calls to the real
 * resolveExtensionPathsWithFs function using an in-memory Map<string, boolean>
 * as the fake existsSync. No temp directories, no process.chdir.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-extensions-dir.test.mts
 */

import assert from "node:assert";
import { resolve as resolvePath } from "node:path";
import { describe, it } from "node:test";

import { resolveExtensionPathsWithFs } from "../lib/extensions.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CWD = "/test/cwd";

function fakeExists(existing: Map<string, boolean>): (path: string) => boolean {
	return (path: string) => existing.get(path) === true;
}

function extPath(name: string): string {
	return resolvePath(BASE_CWD, `.pi/extensions/${name}.ts`);
}

function extDirPath(name: string): string {
	return resolvePath(BASE_CWD, `.pi/extensions/${name}/index.ts`);
}

// ---------------------------------------------------------------------------
// Tests — directory-aware resolution
// ---------------------------------------------------------------------------

describe("resolveExtensionPathsWithFs — directory-aware resolution", () => {
	it("caveman when directory exists → resolves to caveman/index.ts", () => {
		const existing = new Map<string, boolean>();
		existing.set(extDirPath("caveman"), true);
		const result = resolveExtensionPathsWithFs("caveman", BASE_CWD, fakeExists(existing));
		assert.ok(
			result.some((r) => r.includes("caveman/index.ts")),
			`Expected caveman/index.ts in result, got: ${JSON.stringify(result)}`,
		);
	});

	it("ask-user when file exists (not dir) → resolves to ask-user.ts", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("ask-user"), true);
		const result = resolveExtensionPathsWithFs("ask-user", BASE_CWD, fakeExists(existing));
		assert.ok(
			result.some((r) => r.includes("ask-user.ts") && !r.includes("index.ts")),
			`Expected ask-user.ts in result, got: ${JSON.stringify(result)}`,
		);
	});

	it("nonexistent when neither file nor dir → falls back to .ts path", () => {
		const result = resolveExtensionPathsWithFs("nonexistent", BASE_CWD, fakeExists(new Map()));
		assert.ok(
			result.some((r) => r.includes("nonexistent.ts")),
			`Expected nonexistent.ts fallback, got: ${JSON.stringify(result)}`,
		);
	});

	it("caveman,supervisor → supervisor filtered, caveman resolves to index.ts", () => {
		const existing = new Map<string, boolean>();
		existing.set(extDirPath("caveman"), true);
		const result = resolveExtensionPathsWithFs(
			"caveman,supervisor",
			BASE_CWD,
			fakeExists(existing),
		);
		assert.ok(
			result.some((r) => r.includes("caveman/index.ts")),
			`Expected caveman/index.ts, got: ${JSON.stringify(result)}`,
		);
		assert.ok(!result.some((r) => r.includes("supervisor")));
	});

	it("empty string → []", () => {
		const result = resolveExtensionPathsWithFs("", BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("undefined → []", () => {
		const result = resolveExtensionPathsWithFs(undefined, BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("scrapling when neither file nor dir → falls back to scrapling.ts", () => {
		const result = resolveExtensionPathsWithFs("scrapling", BASE_CWD, fakeExists(new Map()));
		assert.ok(
			result.some((r) => r.includes("scrapling.ts")),
			`Expected scrapling.ts, got: ${JSON.stringify(result)}`,
		);
	});

	it("directory-based extension with additional single-file → priority: file wins", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("caveman"), true);
		existing.set(extDirPath("caveman"), true);
		const result = resolveExtensionPathsWithFs("caveman", BASE_CWD, fakeExists(existing));
		// File path takes priority over directory index
		assert.ok(
			result.some((r) => r.includes("caveman.ts") && !r.includes("index.ts")),
			`Expected caveman.ts (file priority), got: ${JSON.stringify(result)}`,
		);
	});

	it("mixed extensions: one directory, one file → both resolved in order", () => {
		const existing = new Map<string, boolean>();
		existing.set(extDirPath("caveman"), true);
		existing.set(extPath("mcp"), true);
		const result = resolveExtensionPathsWithFs("caveman,mcp", BASE_CWD, fakeExists(existing));
		assert.strictEqual(result.length, 2);
		assert.ok(result[0]!.includes("caveman/index.ts"));
		assert.ok(result[1]!.includes("mcp.ts"));
	});
});
