/**
 * Tests for adapter.ts — TscWatchAdapter interface, TypeScriptWatchAdapter impl,
 * diagnosticToTscDiagnostic mapping, resolveDiagnosticFilePath, createDefaultAdapter factory.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/adapter.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import {
	diagnosticToTscDiagnostic,
	resolveDiagnosticFilePath,
	createDefaultAdapter,
} from "../adapter.ts";

import type { TscDiagnostic } from "../types.ts";

import ts from "typescript";

// ═══════════════════════════════════════════════════════════════════════
// diagnosticToTscDiagnostic — pure mapping ts.Diagnostic → TscDiagnostic
// ═══════════════════════════════════════════════════════════════════════

describe("diagnosticToTscDiagnostic", () => {
	const configDir = "/home/user/project";

	function mockSourceFile(fileName: string): ts.SourceFile {
		return {
			fileName,
			getLineAndCharacterOfPosition(_pos: number) {
				return { line: 2, character: 5 };
			},
		} as unknown as ts.SourceFile;
	}

	function mockDiagnostic(overrides: {
		file: ts.SourceFile;
		start?: number;
		messageText?: string | ts.DiagnosticMessageChain;
		code?: number;
		category?: ts.DiagnosticCategory;
	}): ts.Diagnostic {
		return {
			start: 100,
			messageText: "Type 'string' is not assignable to type 'number'",
			code: 2322,
			category: ts.DiagnosticCategory.Error,
			...overrides,
		} as unknown as ts.Diagnostic;
	}

	it("maps error diagnostic with file to correct TscDiagnostic fields", () => {
		const file = mockSourceFile("src/app.ts");
		const diagnostic = mockDiagnostic({ file });

		const result = diagnosticToTscDiagnostic(diagnostic, configDir);

		assert.ok(result, "should return a TscDiagnostic");
		assert.strictEqual(result!.file, "src/app.ts");
		assert.strictEqual(result!.line, 3); // line + 1
		assert.strictEqual(result!.column, 6); // character + 1
		assert.strictEqual(result!.severity, "Error");
		assert.strictEqual(result!.message, "Type 'string' is not assignable to type 'number'");
		assert.strictEqual(result!.code, "TS2322");
		assert.strictEqual(result!.filePath, "/home/user/project/src/app.ts");
	});

	it("maps diagnostic with non-zero offset → line/column derived correctly", () => {
		const file = {
			fileName: "src/deep.ts",
			getLineAndCharacterOfPosition(pos: number) {
				// pos 150 → line 3, character 30
				return { line: 3, character: 30 };
			},
		} as unknown as ts.SourceFile;

		const diagnostic = mockDiagnostic({ file, start: 150 });
		const result = diagnosticToTscDiagnostic(diagnostic, configDir);

		assert.ok(result);
		assert.strictEqual(result!.line, 4); // 3 + 1
		assert.strictEqual(result!.column, 31); // 30 + 1
	});

	it("maps diagnostic with nested messageText → flattened single string", () => {
		const file = mockSourceFile("src/app.ts");
		const nestedMessage: ts.DiagnosticMessageChain = {
			messageText: "Type 'string' is not assignable",
			category: ts.DiagnosticCategory.Error,
			code: 2322,
			next: [
				{
					messageText: "Did you mean 'number'?",
					category: ts.DiagnosticCategory.Error,
					code: 2322,
				},
			],
		};

		const diagnostic = mockDiagnostic({ file, messageText: nestedMessage });
		const result = diagnosticToTscDiagnostic(diagnostic, configDir);

		assert.ok(result);
		// Flattened message should include both parts
		assert.ok(result!.message.includes("Type 'string' is not assignable"));
		assert.ok(result!.message.includes("Did you mean 'number'?"));
	});

	it("diagnostic without file → returns undefined", () => {
		// A diagnostic without a file (global error like duplicate identifier across files)
		const diagnostic = {
			start: 0,
			messageText: "Global error",
			code: 2300,
			category: ts.DiagnosticCategory.Error,
			// No file property
		} as unknown as ts.Diagnostic;

		const result = diagnosticToTscDiagnostic(diagnostic, configDir);
		assert.strictEqual(result, undefined);
	});

	it("diagnostic with zero start → line=1, column=1", () => {
		const file = {
			fileName: "src/zero.ts",
			getLineAndCharacterOfPosition(_pos: number) {
				return { line: 0, character: 0 };
			},
		} as unknown as ts.SourceFile;

		const diagnostic = mockDiagnostic({ file, start: 0 });
		const result = diagnosticToTscDiagnostic(diagnostic, configDir);

		assert.ok(result);
		assert.strictEqual(result!.line, 1);
		assert.strictEqual(result!.column, 1);
	});

	it("filePath resolved: relative path → resolved against configDir", () => {
		const file = mockSourceFile("relative/path.ts");
		const diagnostic = mockDiagnostic({ file });

		const result = diagnosticToTscDiagnostic(diagnostic, configDir);
		assert.ok(result);
		assert.strictEqual(result!.filePath, "/home/user/project/relative/path.ts");
	});

	it("filePath resolved: absolute path → returned as-is", () => {
		const file = mockSourceFile("/absolute/path.ts");
		const diagnostic = mockDiagnostic({ file });

		const result = diagnosticToTscDiagnostic(diagnostic, configDir);
		assert.ok(result);
		assert.strictEqual(result!.filePath, "/absolute/path.ts");
	});

	it("diagnostic with start > file length → still returns position (boundary)", () => {
		// TypeScript's getLineAndCharacterOfPosition handles over-large positions
		// by returning last-character behavior; we just verify the function doesn't throw
		const file = {
			fileName: "src/boundary.ts",
			getLineAndCharacterOfPosition(pos: number) {
				// Even for very large positions, TS returns some line/char
				return { line: 999, character: 50 };
			},
		} as unknown as ts.SourceFile;

		const diagnostic = mockDiagnostic({ file, start: 999999 });
		const result = diagnosticToTscDiagnostic(diagnostic, configDir);

		assert.ok(result, "should still return a diagnostic without throwing");
		assert.strictEqual(result!.line, 1000);
		assert.strictEqual(result!.column, 51);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// resolveDiagnosticFilePath
// ═══════════════════════════════════════════════════════════════════════

describe("resolveDiagnosticFilePath", () => {
	it("resolves relative path to absolute against tsconfig dir", () => {
		const result = resolveDiagnosticFilePath("src/app.ts", "/home/user/project");
		assert.strictEqual(result, "/home/user/project/src/app.ts");
	});

	it("already absolute path returned as-is", () => {
		const result = resolveDiagnosticFilePath("/home/user/project/src/app.ts", "/other/dir");
		assert.strictEqual(result, "/home/user/project/src/app.ts");
	});

	it("Windows absolute path returned as-is", () => {
		const result = resolveDiagnosticFilePath("C:\\Users\\me\\src\\app.ts", "/other/dir");
		assert.strictEqual(result, "C:\\Users\\me\\src\\app.ts");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// createDefaultAdapter factory
// ═══════════════════════════════════════════════════════════════════════

describe("createDefaultAdapter", () => {
	it("returns an object satisfying TscWatchAdapter interface", () => {
		const adapter = createDefaultAdapter();

		assert.strictEqual(typeof adapter.start, "function");
		assert.strictEqual(typeof adapter.stop, "function");
		assert.strictEqual(typeof adapter.isRunning, "function");
		assert.strictEqual(typeof adapter.getDiagnostics, "function");
		assert.strictEqual(typeof adapter.onDiagnosticsChange, "function");
	});

	it("diagnosticToTscDiagnostic is exported from adapter module", () => {
		assert.strictEqual(typeof diagnosticToTscDiagnostic, "function");
	});

	it("createDefaultAdapter returns non-running adapter", () => {
		const adapter = createDefaultAdapter();
		assert.strictEqual(adapter.isRunning(), false);
	});

	it("getDiagnostics returns empty array initially", () => {
		const adapter = createDefaultAdapter();
		assert.deepStrictEqual(adapter.getDiagnostics(), []);
	});
});
