/**
 * Verification tests for dead code removal (Issue #1392).
 *
 * Confirms that the never-imported `TscWatchOptions` interface has been
 * removed from `types.ts`, and that the two file-tree doc diagrams no
 * longer advertise it. The interface was speculative ("reserved for
 * future polling mode") and never part of the extension's public API
 * (index.ts re-exports only TscDiagnostic and DiagnosticTrend).
 *
 * NOTE: interfaces are erased by --experimental-strip-types, so a runtime
 * `=== undefined` check would pass BEFORE the fix (false positive). All
 * absence checks are therefore static source-text via readFileSync.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/tsc-watch-options-removed.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const typesPath = resolve(import.meta.dirname, "../types.ts");
const indexPath = resolve(import.meta.dirname, "../index.ts");
const readmePath = resolve(import.meta.dirname, "../README.md");
const docsPath = resolve(import.meta.dirname, "../../../../docs/extensions/tsc-checkpoint.md");

describe("Issue #1392 — TscWatchOptions removed from types.ts", () => {
	it("types.ts no longer declares TscWatchOptions", () => {
		const content = readFileSync(typesPath, "utf-8");
		assert.ok(
			!content.includes("TscWatchOptions"),
			"types.ts should no longer contain the TscWatchOptions identifier",
		);
	});

	it("types.ts still declares the sibling exports (no over-removal)", () => {
		const content = readFileSync(typesPath, "utf-8");
		assert.ok(content.includes("export interface DiagnosticTrend"), "DiagnosticTrend export removed");
		assert.ok(content.includes("export interface TscCheckpointResult"), "TscCheckpointResult export removed");
		assert.ok(content.includes("export type { TscDiagnostic };"), "TscDiagnostic re-export removed");
	});

	it("types.ts still imports cleanly at runtime (type-only module)", async () => {
		const mod = await import("../types.ts");
		assert.ok(mod, "types.ts should import without error");
	});
});

describe("Issue #1392 — index.ts re-export hub unchanged", () => {
	it("index.ts re-export block still lists TscDiagnostic and DiagnosticTrend", () => {
		const content = readFileSync(indexPath, "utf-8");
		const exportBlock = content.slice(content.indexOf("// Type re-exports"));
		assert.ok(exportBlock.includes("TscDiagnostic"), "TscDiagnostic missing from type re-exports");
		assert.ok(exportBlock.includes("DiagnosticTrend"), "DiagnosticTrend missing from type re-exports");
		assert.ok(!exportBlock.includes("TscWatchOptions"), "TscWatchOptions leaked into re-export block");
	});

	it("index.ts still exposes every value export at runtime", async () => {
		const mod = (await import("../index.ts")) as Record<string, unknown>;
		for (const name of [
			"diagnosticToTscDiagnostic",
			"resolveDiagnosticFilePath",
			"DiagnosticsWatcher",
			"formatDiagnostics",
			"formatDiagnosticsJson",
			"runTscCheckpoint",
		]) {
			assert.strictEqual(
				typeof mod[name],
				"function",
				`index.ts should still export ${name}`,
			);
		}
	});
});

describe("Issue #1392 — doc file-tree diagrams updated", () => {
	for (const [label, path] of [
		["README.md", readmePath],
		["docs/extensions/tsc-checkpoint.md", docsPath],
	] as const) {
		it(`${label} no longer lists TscWatchOptions in the types.ts annotation`, () => {
			const content = readFileSync(path, "utf-8");
			assert.ok(!content.includes("TscWatchOptions"), `${label} should not mention TscWatchOptions`);
		});

		it(`${label} still lists the used types in the types.ts annotation (doc-drift guard)`, () => {
			const content = readFileSync(path, "utf-8");
			const annotation = content.match(/types\.ts\s+#[^\n]*/);
			assert.ok(annotation, `${label} has no types.ts annotation line`);
			for (const name of ["TscDiagnostic", "DiagnosticTrend", "TscCheckpointResult"]) {
				assert.ok(annotation[0].includes(name), `${label} annotation lost ${name}`);
			}
		});
	}
});
