/**
 * Verification tests for dead import declarations removal (Issue #1875).
 *
 * `index.ts` is a backward-compatible re-export hub: it re-exports every
 * public symbol via `export ... from`, so three local `import` declarations
 * (types.ts, adapter.ts, checkpoint.ts) are wholly unused and shadowed.
 *
 * These tests fail BEFORE removal and pass AFTER removal.
 * Uses only dynamic import() — no static imports of the (eventually) removed
 * names from their direct modules.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/verify-unused-import-declarations.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexPath = resolve(import.meta.dirname, "../index.ts");

/** Matches an `import ... from "<spec>"` declaration (multi-line safe, stops at `;`). */
function importFrom(source: string, spec: string): RegExpMatchArray | null {
	const escaped = spec.replace(/\./g, "\\.");
	return source.match(new RegExp(`import\\b[^;]*?from\\s+["']\\./${escaped}["']`));
}

describe("Issue #1875 — redundant local import declarations removed", () => {
	it("index.ts has no import declaration for ./types.ts", () => {
		const content = readFileSync(indexPath, "utf-8");
		assert.strictEqual(
			importFrom(content, "types.ts"),
			null,
			"unused `import type { TscDiagnostic, DiagnosticTrend } from \"./types.ts\"` still present",
		);
	});

	it("index.ts has no import declaration for ./adapter.ts", () => {
		const content = readFileSync(indexPath, "utf-8");
		assert.strictEqual(
			importFrom(content, "adapter.ts"),
			null,
			"unused `import { diagnosticToTscDiagnostic, resolveDiagnosticFilePath } from \"./adapter.ts\"` still present",
		);
	});

	it("index.ts has no import declaration for ./checkpoint.ts", () => {
		const content = readFileSync(indexPath, "utf-8");
		assert.strictEqual(
			importFrom(content, "checkpoint.ts"),
			null,
			"unused `import { runTscCheckpoint } from \"./checkpoint.ts\"` still present",
		);
	});

	it("does not over-remove the imports the handler body uses", () => {
		const content = readFileSync(indexPath, "utf-8");
		assert.ok(
			importFrom(content, "watcher.ts"),
			"`import { DiagnosticsWatcher } from \"./watcher.ts\"` was wrongly removed",
		);
		assert.ok(
			importFrom(content, "format.ts"),
			"`import { formatDiagnostics, formatDiagnosticsJson, directionLabel } from \"./format.ts\"` was wrongly removed",
		);
	});
});

describe("Issue #1875 — facade public surface preserved", () => {
	it("dynamic import resolves and default export is a function", async () => {
		const mod = (await import("../index.ts")) as Record<string, unknown>;
		assert.strictEqual(typeof mod.default, "function");
	});

	it("every value re-export is still present as a function", async () => {
		const mod = (await import("../index.ts")) as Record<string, unknown>;
		for (const name of [
			"diagnosticToTscDiagnostic",
			"resolveDiagnosticFilePath",
			"DiagnosticsWatcher",
			"formatDiagnostics",
			"formatDiagnosticsJson",
			"directionLabel",
			"runTscCheckpoint",
		]) {
			assert.strictEqual(typeof mod[name], "function", `${name} is not a function export`);
		}
	});

	it("runTscCheckpoint keeps its arity and returns the expected shape", async () => {
		const mod = (await import("../index.ts")) as Record<string, unknown>;
		const runTscCheckpoint = mod.runTscCheckpoint as (...args: unknown[]) => Promise<unknown>;
		assert.strictEqual(runTscCheckpoint.length, 2);
		const result = (await runTscCheckpoint("/nonexistent/path")) as Record<string, unknown>;
		assert.ok("diagnostics" in result, "missing `diagnostics` on result");
		assert.ok("hasErrors" in result, "missing `hasErrors` on result");
	});

	it("type re-export block still lists TscDiagnostic and DiagnosticTrend", () => {
		const content = readFileSync(indexPath, "utf-8");
		const exportBlock = content.slice(content.indexOf("// Type re-exports"));
		assert.ok(exportBlock.includes("TscDiagnostic"), "TscDiagnostic missing from type re-exports");
		assert.ok(exportBlock.includes("DiagnosticTrend"), "DiagnosticTrend missing from type re-exports");
	});

	it("runTscCheckpoint appears exactly once, inside the export re-binding", () => {
		const content = readFileSync(indexPath, "utf-8");
		const occurrences = content.match(/runTscCheckpoint/g) ?? [];
		assert.strictEqual(
			occurrences.length,
			1,
			`expected exactly one runTscCheckpoint occurrence (the export), found ${occurrences.length}`,
		);
		assert.match(
			content,
			/export\s*\{\s*runTscCheckpoint\s*\}\s*from\s+["']\.\/checkpoint\.ts["']/,
		);
	});

	it("module evaluates without ReferenceError (no dangling local binding)", async () => {
		const mod = await import("../index.ts");
		assert.ok(mod, "index.ts should evaluate without throwing");
	});
});

describe("Issue #1875 — downstream consumer regression", () => {
	it("supervisor can still resolve runTscCheckpoint through the facade", async () => {
		// Mirrors the dynamic import contract used by
		// supervisor/checks/audit-gate-decision.ts (getRunGate).
		const mod = (await import("../index.ts")) as Record<string, unknown>;
		const runTscCheckpoint = mod.runTscCheckpoint as { length: number };
		assert.strictEqual(typeof mod.runTscCheckpoint, "function");
		assert.strictEqual(runTscCheckpoint.length, 2);
	});
});
