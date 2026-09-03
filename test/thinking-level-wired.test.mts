/**
 * Structural wiring guard for .pi/extensions/lib/ modules.
 *
 * Regression prevention for #1604 (dead lib/thinking-level.ts revived, #1212
 * duplication): every shared lib module must have ≥1 PRODUCTION importer
 * (test-file imports never count — that is exactly how the dead file hid)
 * and no extension may re-invent its own thinking-level switch table.
 *
 * This replaces the manual ponytail `rg` audit; ESLint/noUnusedLocals cannot
 * see cross-file dead code, so the invariant is asserted structurally here.
 *
 * Run with:
 *   node --experimental-strip-types --test test/thinking-level-wired.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, dirname, sep } from "node:path";

const EXTENSIONS_DIR = resolve(import.meta.dirname, "..", ".pi/extensions");
const LIB_DIR = join(EXTENSIONS_DIR, "lib");
const THINKING_LEVEL_FILE = join(LIB_DIR, "thinking-level.ts");

// ─── Scan helpers ─────────────────────────────────────────────────

function isTestFile(file: string): boolean {
	return /\.test\.(ts|mts)$/.test(file);
}

function walkTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkTsFiles(full));
		else if (entry.isFile() && /\.(ts|mts)$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** Non-test source file: not a *.test.* file and not inside any `test/` directory. */
function isProductionSource(file: string): boolean {
	if (isTestFile(file)) return false;
	return !relative(EXTENSIONS_DIR, file).split(sep).includes("test");
}

function productionSourceFiles(): string[] {
	return walkTsFiles(EXTENSIONS_DIR).filter(isProductionSource);
}

/** Match `from "./x"`, `from "../lib/x.ts"`, and dynamic `import("./x")` specifiers. */
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)(["'])(\.[^"']+)\1/g;

function importSpecifiers(content: string): string[] {
	const specs: string[] = [];
	for (const m of content.matchAll(IMPORT_RE)) specs.push(m[2]!);
	return specs;
}

/** Production (non-test) source files whose imports resolve to the target module. */
function productionImportersOf(targetAbs: string): string[] {
	const target = resolve(targetAbs);
	const withoutExt = target.replace(/\.(ts|mts|js)$/, "");
	const importers: string[] = [];
	for (const file of productionSourceFiles()) {
		const content = readFileSync(file, "utf-8");
		const hit = importSpecifiers(content).some((spec) => {
			const resolved = resolve(dirname(file), spec);
			return resolved === target || resolved === withoutExt; // tolerate extension-less specifiers
		});
		if (hit) importers.push(file);
	}
	return importers;
}

function wired(targetAbs: string): boolean {
	return productionImportersOf(targetAbs).length >= 1;
}

/** A parallel thinking-level switch table pairs `case "medium":` with `case "xhigh":`. */
function hasParallelThinkingTables(content: string): boolean {
	return content.includes('case "medium":') && content.includes('case "xhigh":');
}

// ─── Guard: lib/thinking-level.ts wired ─────────────────────────────

describe("lib/thinking-level.ts is wired (issue #1604)", () => {
	it("has at least one production (non-test) importer", () => {
		assert.ok(existsSync(THINKING_LEVEL_FILE), "lib/thinking-level.ts must exist");
		const importers = productionImportersOf(THINKING_LEVEL_FILE);
		assert.ok(
			importers.length >= 1,
			`lib/thinking-level.ts has no production importers (test imports never count). ` +
				`Importers found: ${importers.join(", ") || "none"}`,
		);
	});
});

// ─── Guard: generic dead-lib check over .pi/extensions/lib/ ─────────

describe("generic dead-lib guard (every lib module has a production importer)", () => {
	it("every non-test, non-ambient lib module has ≥1 production importer", () => {
		const dead: string[] = [];
		for (const file of walkTsFiles(LIB_DIR)) {
			if (isTestFile(file)) continue;
			if (relative(LIB_DIR, file).split(sep)[0] === "test") continue; // lib/test/**
			const content = readFileSync(file, "utf-8");
			if (content.includes("declare module")) continue; // ambient decl (e.g. proper-lockfile-ambient.ts)
			if (!wired(file)) dead.push(relative(EXTENSIONS_DIR, file));
		}
		assert.deepStrictEqual(dead, [], "lib modules without production importers: ");
	});
});

// ─── Guard: no parallel thinking-level tables in consumer extensions ─

describe("no parallel thinking-level mapping tables (no #1212 divergence)", () => {
	it("context-info and supervisor production sources contain no switch tables", () => {
		const offenders: string[] = [];
		for (const ext of ["context-info", "supervisor"]) {
			const extDir = join(EXTENSIONS_DIR, ext);
			for (const file of walkTsFiles(extDir)) {
				if (!isProductionSource(file)) continue;
				if (hasParallelThinkingTables(readFileSync(file, "utf-8"))) {
					offenders.push(relative(EXTENSIONS_DIR, file));
				}
			}
		}
		assert.deepStrictEqual(offenders, [], "files re-inventing thinking-level tables: ");
	});

	it("supervisor/lib/formatting.ts no longer exports thinkingColor/thinkingLabel", () => {
		const content = readFileSync(join(EXTENSIONS_DIR, "supervisor/lib/formatting.ts"), "utf-8");
		assert.ok(
			!/export (?:function|const) thinking(?:Color|Label)\b/.test(content),
			"supervisor/lib/formatting.ts must not export thinking helpers",
		);
	});

	it("context-info/formatting.ts no longer exports thinkingIcon/thinkingColor", () => {
		const content = readFileSync(join(EXTENSIONS_DIR, "context-info/formatting.ts"), "utf-8");
		assert.ok(
			!/export (?:function|const) thinking(?:Icon|Color)\b/.test(content),
			"context-info/formatting.ts must not export thinking helpers",
		);
	});
});

// ─── TDD gate: predicates must fail when the regression returns ─────

describe("guard fails on simulated regressions (TDD gate)", () => {
	it("guard fails for a target with zero production importers (last importer removed)", () => {
		const orphan = join(tmpdir(), `unwired-lib-${process.pid}.ts`);
		writeFileSync(orphan, "export const unused = 1;\n");
		try {
			assert.strictEqual(wired(orphan), false, "unwired module must fail the wired() check");
		} finally {
			rmSync(orphan, { force: true });
		}
	});

	it("test-file imports alone never satisfy the guard (ts-prune -s pitfall)", () => {
		const libTestFile = join(LIB_DIR, "test", "thinking-level.test.ts");
		assert.ok(existsSync(libTestFile), "precondition: lib/test/thinking-level.test.ts exists");
		assert.ok(
			!productionSourceFiles().includes(libTestFile),
			"lib/test/** must never be scanned as production importers",
		);
	});

	it("guard detects a third parallel thinking-level switch table", () => {
		const thirdCopy = `
function thinkingColor(level: string | undefined): string {
	switch (level) {
		case "medium": return "muted";
		case "xhigh": return "accent";
	}
}`;
		assert.ok(
			hasParallelThinkingTables(thirdCopy),
			"predicate must flag a re-invented thinking table",
		);
		const clean = readFileSync(join(EXTENSIONS_DIR, "context-info/formatting.ts"), "utf-8");
		assert.ok(
			!hasParallelThinkingTables(clean),
			"predicate must pass on the clean (table-free) consumer source",
		);
	});
});