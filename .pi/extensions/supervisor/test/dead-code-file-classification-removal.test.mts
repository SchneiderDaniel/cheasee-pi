/**
 * Tests for the dead-code removal in checks/file-classification.ts —
 * proves TEST_NAME_PATTERNS / classifyChangedFiles and their cascade
 * (isTestFile, TEST_EXTENSIONS, unused node:path import) are gone, and
 * that the retained isTestableFile contract is unchanged.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-file-classification-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const checksDir = join(testDir, "..", "checks");
const classificationPath = join(checksDir, "file-classification.ts");

/** Recursively collect every .ts/.mts source file under checks/, excluding test/. */
function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "test" || entry.name === "node_modules") continue;
			out.push(...collectSourceFiles(full));
		} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
			out.push(full);
		}
	}
	return out;
}

/** Count source files (outside test/) containing the literal needle. */
function scanSources(needle: string): string[] {
	return collectSourceFiles(checksDir).filter((f) => readFileSync(f, "utf8").includes(needle));
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: removed symbols are gone and leave no dangling references
// ═══════════════════════════════════════════════════════════════════════

describe("file-classification dead-code removal", () => {
	for (const name of [
		"classifyChangedFiles",
		"TEST_NAME_PATTERNS",
		"isTestFile",
		"TEST_EXTENSIONS",
	]) {
		it(`no source under checks/ (outside test/) references ${name}`, () => {
			assert.deepEqual(scanSources(name), [], `dangling ${name} reference found`);
		});
	}

	it("removed exports are gone from the module surface", async () => {
		const mod = (await import("../checks/file-classification.ts")) as Record<string, unknown>;
		assert.equal("classifyChangedFiles" in mod, false);
		assert.equal("isTestFile" in mod, false);
	});

	it("drops the orphaned node:path import after the cascade", () => {
		const source = readFileSync(classificationPath, "utf8");
		assert.equal(source.includes("extname"), false, "extname still imported");
		assert.equal(source.includes("basename"), false, "basename still imported");
	});

	it("retains SOURCE_EXTENSIONS and exports isTestableFile", () => {
		const source = readFileSync(classificationPath, "utf8");
		assert.ok(source.includes("SOURCE_EXTENSIONS"));
		assert.ok(source.includes("export function isTestableFile"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: retained isTestableFile contract unchanged
// ═══════════════════════════════════════════════════════════════════════

describe("retained isTestableFile contract", () => {
	it("behaves identically via direct module and shim re-export", async () => {
		const direct = (await import("../checks/file-classification.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		const shim = (await import("../checks/requirements-traceability.ts")) as {
			isTestableFile: (p: string) => boolean;
		};
		for (const mod of [direct, shim]) {
			assert.equal(mod.isTestableFile("src/foo.ts"), true);
			assert.equal(mod.isTestableFile("src/foo.d.ts"), false);
			assert.equal(mod.isTestableFile(""), false);
		}
	});
});
