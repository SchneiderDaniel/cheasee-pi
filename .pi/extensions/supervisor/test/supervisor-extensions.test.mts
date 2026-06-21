/**
 * Tests for resolveExtensionPathsWithFs() — per-agent extension path resolution
 * with injected existsSync seam, and runner CLI formatting (flatMap + context-info).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-extensions.test.mts
 */

import assert from "node:assert";
import { resolve as resolvePath } from "node:path";
import { describe, it } from "node:test";

import { resolveExtensionPathsWithFs, resolveExtensionPaths } from "../lib/extensions.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake existsSync function backed by a Map<string, boolean>.
 * The Map is keyed by absolute paths.
 */
function fakeExists(existing: Map<string, boolean>): (path: string) => boolean {
	return (path: string) => existing.get(path) === true;
}

/**
 * A known absolute base directory for tests.
 * We use a path that avoids assumptions about the test runner's CWD.
 */
const BASE_CWD = "/test/cwd";

/**
 * Build an absolute extension path under BASE_CWD.
 */
function extPath(name: string): string {
	return resolvePath(BASE_CWD, `.pi/extensions/${name}.ts`);
}

/**
 * Build an absolute directory-based extension index path under BASE_CWD.
 */
function extDirPath(name: string): string {
	return resolvePath(BASE_CWD, `.pi/extensions/${name}/index.ts`);
}

// ---------------------------------------------------------------------------
// Phase 1: resolveExtensionPathsWithFs — core resolver with injected seam
// ---------------------------------------------------------------------------

describe("resolveExtensionPathsWithFs — empty/undefined/missing input", () => {
	it("undefined extensions → []", () => {
		const result = resolveExtensionPathsWithFs(undefined, BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("empty string → []", () => {
		const result = resolveExtensionPathsWithFs("", BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("whitespace-only → []", () => {
		const result = resolveExtensionPathsWithFs("   ", BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("supervisor → [] (filtered out)", () => {
		const result = resolveExtensionPathsWithFs("supervisor", BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("SUPERVISOR → [] (case-insensitive filter)", () => {
		const result = resolveExtensionPathsWithFs("SUPERVISOR", BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("Supervisor → [] (mixed-case filter)", () => {
		const result = resolveExtensionPathsWithFs("Supervisor", BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});
});

describe("resolveExtensionPathsWithFs — single-file resolution", () => {
	it("single-file extension exists → returns [absFilePath]", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("mcp"), true);
		const result = resolveExtensionPathsWithFs("mcp", BASE_CWD, fakeExists(existing));
		assert.deepStrictEqual(result, [extPath("mcp")]);
	});

	it("directory-based extension exists → returns [absDirIndexPath]", () => {
		const existing = new Map<string, boolean>();
		existing.set(extDirPath("caveman"), true);
		const result = resolveExtensionPathsWithFs("caveman", BASE_CWD, fakeExists(existing));
		assert.deepStrictEqual(result, [extDirPath("caveman")]);
	});

	it("file takes priority over directory when both exist", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("mcp"), true);
		existing.set(extDirPath("mcp"), true);
		const result = resolveExtensionPathsWithFs("mcp", BASE_CWD, fakeExists(existing));
		assert.deepStrictEqual(result, [extPath("mcp")]);
	});

	it("neither file nor dir exists → returns default file path (fallback)", () => {
		const result = resolveExtensionPathsWithFs("unknown", BASE_CWD, fakeExists(new Map()));
		assert.deepStrictEqual(result, [extPath("unknown")]);
	});
});

describe("resolveExtensionPathsWithFs — mixed multi-ext resolution", () => {
	it("one single-file, one directory, one missing → three paths in order", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("mcp"), true);
		existing.set(extDirPath("caveman"), true);
		const result = resolveExtensionPathsWithFs(
			"mcp,caveman,unknown",
			BASE_CWD,
			fakeExists(existing),
		);
		assert.deepStrictEqual(result, [extPath("mcp"), extDirPath("caveman"), extPath("unknown")]);
	});

	it("supervisor in middle → filtered out, order preserved", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("mcp"), true);
		existing.set(extPath("browser"), true);
		const result = resolveExtensionPathsWithFs(
			"mcp,supervisor,browser",
			BASE_CWD,
			fakeExists(existing),
		);
		assert.deepStrictEqual(result, [extPath("mcp"), extPath("browser")]);
	});

	it("cwd controls base directory → all paths start with given cwd", () => {
		const customCwd = "/custom/cwd";
		const existing = new Map<string, boolean>();
		existing.set(resolvePath(customCwd, ".pi/extensions/mcp.ts"), true);
		const result = resolveExtensionPathsWithFs("mcp", customCwd, fakeExists(existing));
		assert.ok(result[0]!.startsWith(customCwd));
	});

	it("existsSyncFn called with exact absolute paths", () => {
		const calledPaths: string[] = [];
		const trackingExists = (p: string) => {
			calledPaths.push(p);
			return false;
		};
		resolveExtensionPathsWithFs("test-ext", BASE_CWD, trackingExists);
		assert.strictEqual(calledPaths.length, 2);
		assert.ok(calledPaths.includes(extPath("test-ext")));
		assert.ok(calledPaths.includes(extDirPath("test-ext")));
	});
});

describe("resolveExtensionPathsWithFs — boundary cases", () => {
	it("55 extensions all resolve", () => {
		const existing = new Map<string, boolean>();
		const names: string[] = [];
		for (let i = 0; i < 55; i++) {
			const name = `ext-${i}`;
			names.push(name);
			existing.set(extPath(name), true);
		}
		const result = resolveExtensionPathsWithFs(names.join(","), BASE_CWD, fakeExists(existing));
		assert.strictEqual(result.length, 55);
	});

	it("extension names with hyphens and dots pass through", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("my-custom-tool"), true);
		existing.set(extPath("my.tool"), true);
		const result = resolveExtensionPathsWithFs(
			"my-custom-tool,my.tool",
			BASE_CWD,
			fakeExists(existing),
		);
		assert.strictEqual(result.length, 2);
		assert.ok(result[0]!.includes("my-custom-tool"));
		assert.ok(result[1]!.includes("my.tool"));
	});

	it("whitespace around names trimmed", () => {
		const existing = new Map<string, boolean>();
		existing.set(extPath("mcp"), true);
		existing.set(extPath("browser"), true);
		const result = resolveExtensionPathsWithFs(
			"  mcp  ,  browser  ",
			BASE_CWD,
			fakeExists(existing),
		);
		assert.deepStrictEqual(result, [extPath("mcp"), extPath("browser")]);
	});
});

// ---------------------------------------------------------------------------
// Phase 1b: resolveExtensionPaths — public wrapper smoketest
// ---------------------------------------------------------------------------

describe("resolveExtensionPaths — public wrapper", () => {
	it("called without 3rd arg uses real existsSync and process.cwd()", () => {
		// This is a smoketest — it calls the real function with a known extension
		// name that should exist in the real filesystem (supervisor extension itself).
		const result = resolveExtensionPaths("supervisor");
		// supervisor is always filtered out, so result should be empty
		assert.deepStrictEqual(result, []);
	});

	it("with explicit cwd produces paths under that cwd", () => {
		const result = resolveExtensionPaths("unknown-test-ext", BASE_CWD);
		assert.strictEqual(result.length, 1);
		assert.ok(result[0]!.startsWith(BASE_CWD));
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Runner CLI formatting (flatMap + context-info injection)
// Tests the transformation that agent/runner.ts applies to bare paths.
// These are unit tests for the formatting logic, isolated from the resolver.
// ---------------------------------------------------------------------------

/**
 * Simulates the runner's formatting logic: bare paths → --extension flags +
 * context-info auto-injection (dedup).
 */
function formatExtensionFlags(barePaths: string[], contextInfoPath: string): string[] {
	const flags: string[] = [];
	if (barePaths.length === 0) {
		flags.push("--extension", contextInfoPath);
	} else {
		for (const p of barePaths) {
			flags.push("--extension", p);
		}
		const hasContextInfo = barePaths.some((p) => p.includes("context-info.ts"));
		if (!hasContextInfo) {
			flags.push("--extension", contextInfoPath);
		}
	}
	return flags;
}

describe("runner CLI formatting — flatMap", () => {
	it("bare paths → --extension flags in order", () => {
		const result = formatExtensionFlags(
			["/a/mcp.ts", "/b/browser.ts"],
			"/abs/path/to/context-info.ts",
		);
		assert.deepStrictEqual(result, [
			"--extension",
			"/a/mcp.ts",
			"--extension",
			"/b/browser.ts",
			"--extension",
			"/abs/path/to/context-info.ts",
		]);
	});

	it("empty array → only context-info", () => {
		const result = formatExtensionFlags([], "/abs/path/to/context-info.ts");
		assert.deepStrictEqual(result, ["--extension", "/abs/path/to/context-info.ts"]);
	});

	it("single path + context-info appended correctly", () => {
		const result = formatExtensionFlags(["/a/mcp.ts"], "/context-info/context-info.ts");
		assert.deepStrictEqual(result, [
			"--extension",
			"/a/mcp.ts",
			"--extension",
			"/context-info/context-info.ts",
		]);
	});
});

describe("runner CLI formatting — context-info dedup", () => {
	it("context-info NOT in paths → appended", () => {
		const result = formatExtensionFlags(["/a/mcp.ts"], "/ci/context-info.ts");
		assert.ok(result.includes("/ci/context-info.ts"));
	});

	it("context-info already in paths → no duplicate", () => {
		const result = formatExtensionFlags(
			["/a/mcp.ts", "/ci/context-info.ts"],
			"/ci/context-info.ts",
		);
		const contextInfoCount = result.filter(
			(s) => s.includes("context-info.ts") && !s.includes("--extension"),
		).length;
		assert.strictEqual(contextInfoCount, 1);
	});

	it("no resolved paths → only context-info", () => {
		const result = formatExtensionFlags([], "/abs/path/to/context-info.ts");
		assert.deepStrictEqual(result, ["--extension", "/abs/path/to/context-info.ts"]);
	});

	it("resolveExtensionPaths returns bare paths → runner produces flags + context-info", () => {
		// Integrate: this simulates what runner.ts does end-to-end
		const existing = new Map<string, boolean>();
		existing.set(extPath("mcp"), true);
		const barePaths = resolveExtensionPathsWithFs("mcp", BASE_CWD, fakeExists(existing));
		const result = formatExtensionFlags(barePaths, extPath("context-info"));
		assert.deepStrictEqual(result, [
			"--extension",
			extPath("mcp"),
			"--extension",
			extPath("context-info"),
		]);
	});
});
