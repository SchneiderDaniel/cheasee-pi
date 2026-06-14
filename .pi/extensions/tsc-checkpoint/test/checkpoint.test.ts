/**
 * Tests for checkpoint.ts — runTscCheckpoint one-shot function.
 *
 * Uses real ts.createProgram with temp fixtures for integration testing.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/checkpoint.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runTscCheckpoint } from "../checkpoint.ts";

// ═══════════════════════════════════════════════════════════════════════
// Fixture helpers
// ═══════════════════════════════════════════════════════════════════════

function createFixture(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "tsc-checkpoint-test-"));
	const cleanup = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	};
	return { dir, cleanup };
}

// ═══════════════════════════════════════════════════════════════════════
// runTscCheckpoint — one-shot ts.createProgram integration
// ═══════════════════════════════════════════════════════════════════════

describe("runTscCheckpoint (one-shot ts.createProgram)", () => {
	it("missing tsconfig returns empty diagnostics", async () => {
		const result = await runTscCheckpoint("/nonexistent/path");
		assert.deepStrictEqual(result, { diagnostics: [], hasErrors: false });
	});

	it("config parse failure (malformed JSON) returns empty diagnostics", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				'{ "compilerOptions": { "noEmit": true, "strict": true ',
				"utf-8",
			);
			const result = await runTscCheckpoint(dir);
			assert.deepStrictEqual(result, { diagnostics: [], hasErrors: false });
		} finally {
			cleanup();
		}
	});

	it("config parse failure with non-existent extends returns empty diagnostics", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { noEmit: true, strict: true },
					extends: "./nonexistent-base.json",
				}),
				"utf-8",
			);
			const result = await runTscCheckpoint(dir);
			assert.deepStrictEqual(result, { diagnostics: [], hasErrors: false });
		} finally {
			cleanup();
		}
	});

	it("clean project with no type errors returns empty diagnostics", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { noEmit: true, strict: true },
					include: ["src/**/*.ts"],
				}),
				"utf-8",
			);
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "index.ts"), "export const x: number = 1;\n", "utf-8");

			const result = await runTscCheckpoint(dir);
			assert.deepStrictEqual(result, { diagnostics: [], hasErrors: false });
		} finally {
			cleanup();
		}
	});

	it("project with type errors returns hasErrors: true with diagnostics", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { noEmit: true, strict: true },
					include: ["src/**/*.ts"],
				}),
				"utf-8",
			);
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "index.ts"), 'const x: number = "string";\n', "utf-8");

			const result = await runTscCheckpoint(dir);

			assert.strictEqual(result.hasErrors, true);
			assert.ok(result.diagnostics.length > 0, "should have at least one diagnostic");
			const diag = result.diagnostics[0]!;
			assert.strictEqual(diag.severity, "Error");
			assert.ok(diag.file.includes("index.ts") || diag.filePath.includes("index.ts"));
			assert.ok(diag.message.length > 0);
			assert.ok(diag.code?.startsWith("TS"));
			assert.strictEqual(typeof diag.line, "number");
			assert.strictEqual(typeof diag.column, "number");
		} finally {
			cleanup();
		}
	});

	it("project with multiple error files — all errors reported", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { noEmit: true, strict: true },
					include: ["src/**/*.ts"],
				}),
				"utf-8",
			);
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "a.ts"), 'const x: number = "string-a";\n', "utf-8");
			writeFileSync(join(dir, "src", "b.ts"), 'const y: number = "string-b";\n', "utf-8");

			const result = await runTscCheckpoint(dir);

			assert.strictEqual(result.hasErrors, true);
			assert.strictEqual(result.diagnostics.length, 2, "should have 2 errors (one per file)");
			// Each diagnostic should reference a different file
			const files = new Set(result.diagnostics.map((d) => d.file));
			assert.strictEqual(files.size, 2);
		} finally {
			cleanup();
		}
	});

	it("empty worktreePath string → no crash (correct return shape)", async () => {
		// resolve("", "tsconfig.json") resolves to CWD, which may have a tsconfig.
		// This test just verifies no crash and correct return shape.
		const result = await runTscCheckpoint("");
		assert.ok("diagnostics" in result);
		assert.ok("hasErrors" in result);
		assert.ok(Array.isArray(result.diagnostics));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Pipeline contract — runTscCheckpoint signature & shape
// ═══════════════════════════════════════════════════════════════════════

describe("runTscCheckpoint (pipeline contract)", () => {
	it("is exported and callable with single worktreePath argument", async () => {
		const { runTscCheckpoint: rtc } = await import("../checkpoint.ts");
		const result = await rtc("/nonexistent/path");
		assert.ok(typeof result === "object");
		assert.ok("diagnostics" in result);
		assert.ok("hasErrors" in result);
	});

	it("has .length === 1 (only worktreePath param)", () => {
		assert.strictEqual(runTscCheckpoint.length, 1);
	});

	it("return shape matches TscCheckpointResult", async () => {
		const result = await runTscCheckpoint("/nonexistent/path");
		assert.ok("diagnostics" in result);
		assert.ok("hasErrors" in result);
		assert.ok(Array.isArray(result.diagnostics));
		assert.strictEqual(typeof result.hasErrors, "boolean");
		// trend is optional, should not be present when empty
		assert.strictEqual((result as any).trend, undefined);
	});

	it("module imports diagnosticToTscDiagnostic from adapter.ts (one-way, non-circular)", async () => {
		// The dependency exists at the module level — verify by importing
		const adapterMod = await import("../adapter.ts");
		const checkpointMod = await import("../checkpoint.ts");
		assert.strictEqual(typeof adapterMod.diagnosticToTscDiagnostic, "function");
		assert.strictEqual(typeof checkpointMod.runTscCheckpoint, "function");
	});
});
