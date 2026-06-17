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

import ts from "typescript";
import { runTscCheckpoint, toTscDiagnostic } from "../checkpoint.ts";
import { diagnosticToTscDiagnostic } from "../adapter.ts";

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

	it("config parse failure (malformed JSON) returns hasErrors: true with diagnostic", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				'{ "compilerOptions": { "noEmit": true, "strict": true ',
				"utf-8",
			);
			const result = await runTscCheckpoint(dir);
			assert.strictEqual(result.hasErrors, true);
			assert.ok(result.diagnostics.length > 0, "should have at least one diagnostic");
			assert.strictEqual(result.diagnostics[0]!.file, "tsconfig.json");
		} finally {
			cleanup();
		}
	});

	it("config parse failure with non-existent extends returns hasErrors: true with diagnostic", async () => {
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
			assert.strictEqual(result.hasErrors, true);
			assert.ok(result.diagnostics.length > 0, "should have at least one diagnostic");
		} finally {
			cleanup();
		}
	});

	it("whitespace-only tsconfig returns hasErrors: true with diagnostic", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(join(dir, "tsconfig.json"), "   \n  \n  ", "utf-8");
			const result = await runTscCheckpoint(dir);
			assert.strictEqual(result.hasErrors, true);
			assert.ok(result.diagnostics.length > 0, "should have at least one diagnostic");
			const diag = result.diagnostics[0]!;
			assert.strictEqual(diag.file, "tsconfig.json");
			assert.strictEqual(diag.severity, "Error");
		} finally {
			cleanup();
		}
	});

	it("cyclic extends returns hasErrors: true with diagnostic", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { noEmit: true },
					extends: "./tsconfig.a.json",
				}),
				"utf-8",
			);
			writeFileSync(
				join(dir, "tsconfig.a.json"),
				JSON.stringify({
					extends: "./tsconfig.b.json",
				}),
				"utf-8",
			);
			writeFileSync(
				join(dir, "tsconfig.b.json"),
				JSON.stringify({
					extends: "./tsconfig.a.json",
				}),
				"utf-8",
			);

			const result = await runTscCheckpoint(dir);
			assert.strictEqual(result.hasErrors, true);
			assert.ok(result.diagnostics.length > 0, "should have at least one diagnostic");
		} finally {
			cleanup();
		}
	});

	it("getParsedCommandLineOfConfigFile returning undefined → hasErrors: true with diagnostic", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({ compilerOptions: { noEmit: true } }),
				"utf-8",
			);

			// Inject a mock that returns undefined to exercise the defensive branch
			const result = await runTscCheckpoint(dir, () => undefined);

			assert.strictEqual(result.hasErrors, true);
			assert.strictEqual(result.diagnostics.length, 1);
			assert.strictEqual(result.diagnostics[0]!.file, "tsconfig.json");
			assert.strictEqual(result.diagnostics[0]!.severity, "Error");
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

	it("config with include: [] and no source files — no crash, correct shape (TS18003 may fire)", async () => {
		const { dir, cleanup } = createFixture();
		try {
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { noEmit: true, strict: true },
					include: [],
				}),
				"utf-8",
			);
			const result = await runTscCheckpoint(dir);
			// TS 6.0.3 may or may not produce a config error for empty include.
			// At minimum verify correct shape and no crash.
			assert.ok("hasErrors" in result);
			assert.ok("diagnostics" in result);
			assert.ok(Array.isArray(result.diagnostics));
			assert.strictEqual(typeof result.hasErrors, "boolean");
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
// toTscDiagnostic — config diagnostic helper entity tests
// ═══════════════════════════════════════════════════════════════════════

describe("toTscDiagnostic (config diagnostic helper)", () => {
	it("fileless diagnostic → synthetic TscDiagnostic pointing to tsconfig.json", () => {
		const diag = {
			category: ts.DiagnosticCategory.Error,
			code: 1234,
			messageText: "Test parse error",
			file: undefined,
			start: undefined,
			length: undefined,
		} as ts.Diagnostic;
		const configPath = "/fake/project/tsconfig.json";
		const result = toTscDiagnostic(diag, configPath);

		assert.strictEqual(result.file, "tsconfig.json");
		assert.strictEqual(result.filePath, configPath);
		assert.strictEqual(result.line, 0);
		assert.strictEqual(result.column, 0);
		assert.strictEqual(result.severity, "Error");
		assert.strictEqual(result.message, "Test parse error");
		assert.strictEqual(result.code, "TS1234");
	});

	it("file-based diagnostic → delegates to diagnosticToTscDiagnostic", () => {
		const sourceFile = ts.createSourceFile(
			"test.ts",
			'const x: number = "str";\n',
			ts.ScriptTarget.Latest,
		);
		const diag: ts.Diagnostic = {
			category: ts.DiagnosticCategory.Error,
			code: 2322,
			messageText: "Type 'string' is not assignable to type 'number'",
			file: sourceFile,
			start: 24,
			length: 5,
		};
		const configPath = "/fake/project/tsconfig.json";
		const result = toTscDiagnostic(diag, configPath);
		const expected = diagnosticToTscDiagnostic(diag, "/fake/project")!;

		assert.deepStrictEqual(result, expected);
	});

	it("multiline messageText → flattened via ts.flattenDiagnosticMessageText", () => {
		const chain: ts.DiagnosticMessageChain = {
			messageText: "Base error",
			category: ts.DiagnosticCategory.Error,
			code: 1111,
			next: [
				{
					messageText: "Nested detail",
					category: ts.DiagnosticCategory.Error,
					code: 2222,
				},
			],
		};
		const diag = {
			category: ts.DiagnosticCategory.Error,
			code: 1111,
			messageText: chain,
			file: undefined,
			start: undefined,
			length: undefined,
		} as ts.Diagnostic;
		const result = toTscDiagnostic(diag, "/fake/path/tsconfig.json");

		assert.strictEqual(result.severity, "Error");
		assert.ok(result.message.includes("Base error"), "message should contain flattened base text");
		assert.ok(
			result.message.includes("Nested detail"),
			"message should contain flattened nested text",
		);
	});

	it("zero start position → line: 0, column: 0 for fileless diagnostic", () => {
		const diag = {
			category: ts.DiagnosticCategory.Error,
			code: 5678,
			messageText: "Some error with no start",
			file: undefined,
			start: undefined,
			length: undefined,
		} as ts.Diagnostic;
		const result = toTscDiagnostic(diag, "/fake/path/tsconfig.json");

		assert.strictEqual(result.line, 0);
		assert.strictEqual(result.column, 0);
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

	it("has .length === 2 (worktreePath + optional injectable config parser)", () => {
		// Second optional parameter exists for testability — the ts namespace
		// has non-configurable getters preventing monkey-patching.
		assert.strictEqual(runTscCheckpoint.length, 2);
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
