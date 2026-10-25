/**
 * Phase 1: Core pure functions — lsp-auditor modules
 *
 * Tests pure functions in isolation. No I/O, no Pi API, instant.
 * Imports from extracted modules in .pi/extensions/lsp-auditor/.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/lsp-auditor.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { LspDiagnostic, ServerMapping } from "../types.ts";
import { groupFilesByServer } from "../file-discovery.ts";
import { checkProjectTrust } from "../run-pre-audit.ts";
import { formatForMode } from "../output-adapter.ts";
// Extension entry point — imported here to satisfy knip (loaded dynamically by pi)
import lspAuditor from "../index.ts";

// =========================================================================
// Tests
// =========================================================================

// Split from lsp-auditor.test.mts (issue #2035 Long File refactor).
describe("groupFilesByServer no-dot regression", () => {
	const mappings: ServerMapping[] = [
		{ extensions: [".ts"], command: "ts-ls", args: ["--stdio"], severityThreshold: "warning" },
		{
			extensions: [".py"],
			command: "pyright-langserver",
			args: ["--stdio"],
			severityThreshold: "warning",
		},
	];

	it("extension-less file → unsupported, no server group (repro step 2)", () => {
		const { serverFiles, errors } = groupFilesByServer(["Makefile"], mappings);
		assert.strictEqual(serverFiles.size, 0);
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0]!.includes("Makefile"));
	});

	it("extension-less file NOT spuriously matched to single-char extension mapping", () => {
		const withE: ServerMapping[] = [
			{ extensions: ["e"], command: "e-ls", args: [], severityThreshold: "warning" },
		];
		const { serverFiles, errors } = groupFilesByServer(["Makefile"], withE);
		assert.strictEqual(serverFiles.size, 0, "Makefile must not match extension 'e'");
		assert.ok(errors[0]!.includes("Makefile"));
	});

	it("empty-extension mapping [''] must not capture extension-less files", () => {
		const withEmpty: ServerMapping[] = [
			{ extensions: [""], command: "empty-ls", args: [], severityThreshold: "warning" },
		];
		const { serverFiles, errors } = groupFilesByServer(["Makefile"], withEmpty);
		assert.strictEqual(serverFiles.size, 0, "Makefile must not match extensions: ['']");
		assert.ok(errors[0]!.includes("Makefile"));
	});

	it("extension-less mixed with supported files → only supported grouped", () => {
		const { serverFiles, errors } = groupFilesByServer(["Makefile", "a.ts", "b.py"], mappings);
		const allFiles = [...serverFiles.values()].flat();
		assert.deepStrictEqual(allFiles.sort(), ["a.ts", "b.py"]);
		assert.ok(errors[0]!.includes("Makefile"));
	});

	it("dotfile → unsupported bucket, never matched", () => {
		const { serverFiles, errors } = groupFilesByServer([".gitignore"], mappings);
		assert.strictEqual(serverFiles.size, 0);
		assert.ok(errors[0]!.includes(".gitignore"));
	});
});

describe("groupFilesByServer", () => {
	const mappings: ServerMapping[] = [
		{ extensions: [".ts"], command: "ts-ls", args: ["--stdio"], severityThreshold: "warning" },
		{
			extensions: [".py"],
			command: "pyright-langserver",
			args: ["--stdio"],
			severityThreshold: "warning",
		},
	];

	it("groups files under matching server", () => {
		const { serverFiles, errors } = groupFilesByServer(["a.ts", "b.py"], mappings);
		assert.strictEqual(serverFiles.size, 2);
		const tsEntry = [...serverFiles.entries()].find(([m]) => m.command === "ts-ls");
		assert.deepStrictEqual(tsEntry![1], ["a.ts"]);
	});

	it("flags unsupported file types", () => {
		const { errors } = groupFilesByServer(["a.ts", "script.sh"], mappings);
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0]!.includes("script.sh"));
	});

	it("all unsupported → errors with no server files", () => {
		const { serverFiles, errors } = groupFilesByServer(["script.sh"], mappings);
		assert.strictEqual(serverFiles.size, 0);
		assert.strictEqual(errors.length, 1);
	});
});

describe("checkProjectTrust", () => {
	it("trusted → returns { trusted: true }", () => {
		const result = checkProjectTrust({ isProjectTrusted: () => true });
		assert.strictEqual(result.trusted, true);
		assert.ok(!("note" in result && result.note));
	});

	it("untrusted → returns { trusted: false, note: string }", () => {
		const result = checkProjectTrust({ isProjectTrusted: () => false });
		assert.strictEqual(result.trusted, false);
		assert.strictEqual(typeof (result as { trusted: false; note: string }).note, "string");
		assert.ok((result as { trusted: false; note: string }).note.length > 0);
	});

	it("isProjectTrusted throws → returns { trusted: false, note } (fail-closed)", () => {
		const result = checkProjectTrust({
			isProjectTrusted: () => {
				throw new Error("unexpected error");
			},
		});
		assert.strictEqual(result.trusted, false);
		assert.strictEqual(typeof (result as { trusted: false; note: string }).note, "string");
	});

	it("ctx null/undefined → returns { trusted: false, note } (defensive)", () => {
		const nullResult = checkProjectTrust(null as unknown as { isProjectTrusted: () => boolean });
		assert.strictEqual(nullResult.trusted, false);
		assert.strictEqual(typeof (nullResult as { trusted: false; note: string }).note, "string");

		const undefResult = checkProjectTrust(
			undefined as unknown as { isProjectTrusted: () => boolean },
		);
		assert.strictEqual(undefResult.trusted, false);
		assert.strictEqual(typeof (undefResult as { trusted: false; note: string }).note, "string");
	});
});

describe("formatForMode function selection per mode", () => {
	it("formatForMode is an exported function", () => {
		assert.strictEqual(typeof formatForMode, "function");
	});

	it("TUI mode returns string type", () => {
		const diags: LspDiagnostic[] = [
			{ file: "test.ts", line: 1, column: 1, severity: "Error", message: "test" },
		];
		const tuiResult = formatForMode(diags, "tui", "/workspace", true);
		assert.strictEqual(typeof tuiResult, "string");
	});

	it("RPC mode returns object type", () => {
		const diags: LspDiagnostic[] = [
			{ file: "test.ts", line: 1, column: 1, severity: "Error", message: "test" },
		];
		const rpcResult = formatForMode(diags, "rpc", "/workspace", false);
		assert.strictEqual(typeof rpcResult, "object");
	});

	it("JSON mode returns same shape as RPC", () => {
		const diags: LspDiagnostic[] = [
			{ file: "test.ts", line: 1, column: 1, severity: "Error", message: "test" },
		];
		const rpcResult = formatForMode(diags, "rpc", "/workspace", false);
		const jsonResult = formatForMode(diags, "json", "/workspace", false);
		assert.deepStrictEqual(jsonResult, rpcResult);
	});

	it("Print mode returns string type", () => {
		const diags: LspDiagnostic[] = [
			{ file: "test.ts", line: 1, column: 1, severity: "Error", message: "test" },
		];
		const printResult = formatForMode(diags, "print", "/workspace", false);
		assert.strictEqual(typeof printResult, "string");
	});
});

describe("extension entry point (lspAuditor)", () => {
	it("is a callable function", () => {
		assert.strictEqual(typeof lspAuditor, "function");
	});
});
