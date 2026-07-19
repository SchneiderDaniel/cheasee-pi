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
import type { LspDiagnostic, ServerMapping, AuditResult } from "../types.ts";
import {
	severityValue,
	thresholdValue,
	formatDiagnostics,
	filterBySeverity,
} from "../formatting.ts";
import { buildServerMappings } from "../server-mappings.ts";
import { extractModifiedFiles, groupFilesByServer } from "../file-discovery.ts";
import { countRetryAttempts, shouldRetry, MAX_RETRIES } from "../retry.ts";
import { mergeAuditResults, mapSessionEntriesToRetryEntries, checkProjectTrust } from "../run-pre-audit.ts";
import { formatForMode } from "../output-adapter.ts";
// Extension entry point — imported here to satisfy knip (loaded dynamically by pi)
import lspAuditor from "../index.ts";

// =========================================================================
// Tests
// =========================================================================

describe("mapSessionEntriesToRetryEntries", () => {
	it("custom entry → maps customType as type and data as payload", () => {
		const input = [
			{ type: "custom", customType: "lsp-audit-retry", data: { issueNum: 42, attempt: 1 } },
		];
		const result = mapSessionEntriesToRetryEntries(input);
		assert.deepStrictEqual(result, [
			{ type: "lsp-audit-retry", payload: { issueNum: 42, attempt: 1 } },
		]);
	});

	it("non-custom entry → passes through unchanged", () => {
		const input = [{ type: "message", text: "hello", turnIndex: 0 }];
		const result = mapSessionEntriesToRetryEntries(input);
		assert.deepStrictEqual(result, [{ type: "message", payload: input[0] }]);
	});

	it("empty array → []", () => {
		assert.deepStrictEqual(mapSessionEntriesToRetryEntries([]), []);
	});

	it("customType undefined → type: '' fallback", () => {
		const input = [{ type: "custom", data: { issueNum: 7 } }];
		const result = mapSessionEntriesToRetryEntries(input);
		assert.strictEqual(result[0]!.type, "");
		assert.deepStrictEqual(result[0]!.payload, { issueNum: 7 });
	});

	it("customType empty string → type: ''", () => {
		const input = [{ type: "custom", customType: "", data: { issueNum: 7 } }];
		const result = mapSessionEntriesToRetryEntries(input);
		assert.strictEqual(result[0]!.type, "");
		assert.deepStrictEqual(result[0]!.payload, { issueNum: 7 });
	});

	it("data null → payload null", () => {
		const input = [{ type: "custom", customType: "lsp-audit-retry", data: null }];
		const result = mapSessionEntriesToRetryEntries(input);
		assert.strictEqual(result[0]!.type, "lsp-audit-retry");
		assert.strictEqual(result[0]!.payload, null);
	});

	it("data undefined → payload undefined", () => {
		const input = [{ type: "custom", customType: "lsp-audit-retry" }];
		const result = mapSessionEntriesToRetryEntries(input);
		assert.strictEqual(result[0]!.type, "lsp-audit-retry");
		assert.strictEqual(result[0]!.payload, undefined);
	});

	it("mixed entries → each mapped independently", () => {
		const input = [
			{ type: "message", text: "hello" },
			{ type: "custom", customType: "lsp-audit-retry", data: { issueNum: 1 } },
			{ type: "model_change", model: "claude" },
		];
		const result = mapSessionEntriesToRetryEntries(input);
		assert.strictEqual(result.length, 3);
		assert.strictEqual(result[0]!.type, "message");
		assert.strictEqual(result[1]!.type, "lsp-audit-retry");
		assert.deepStrictEqual(result[1]!.payload, { issueNum: 1 });
		assert.strictEqual(result[2]!.type, "model_change");
		assert.strictEqual(result[2]!.payload, input[2]);
	});

	it("mapped entries fed to countRetryAttempts → correct count", () => {
		const entries = [
			{ type: "custom", customType: "lsp-audit-retry", data: { issueNum: 42, attempt: 1 } },
			{ type: "custom", customType: "lsp-audit-retry", data: { issueNum: 42, attempt: 2 } },
			{ type: "custom", customType: "other-type", data: { issueNum: 42 } },
		];
		const mapped = mapSessionEntriesToRetryEntries(entries);
		assert.strictEqual(countRetryAttempts(mapped, 42), 2);
	});
});

describe("formatDiagnostics", () => {
	it("empty array → empty string", () => {
		assert.strictEqual(formatDiagnostics([]), "");
	});

	it("single diagnostic → one line", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "type x" },
		]);
		assert.strictEqual(result, "a.ts, Line 1: [Error] type x");
	});

	it("multiple diagnostics same file → sorted by line, file header once", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 5, column: 1, severity: "Warning", message: "unused" },
			{ file: "a.ts", line: 2, column: 3, severity: "Error", message: "type mismatch" },
		]);
		const lines = result.split("\n");
		assert.strictEqual(lines[0], "a.ts, Line 2: [Error] type mismatch");
		assert.strictEqual(lines[1], "a.ts, Line 5: [Warning] unused");
	});

	it("two files → blocks separated by blank line", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "err1" },
			{ file: "b.py", line: 3, column: 1, severity: "Warning", message: "warn1" },
		]);
		assert.ok(result.includes("\n\n"));
		assert.ok(result.includes("a.ts"));
		assert.ok(result.includes("b.py"));
	});

	it("files sorted alphabetically", () => {
		const result = formatDiagnostics([
			{ file: "z.ts", line: 1, column: 1, severity: "Error", message: "z" },
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "a" },
		]);
		const firstLine = result.split("\n")[0]!;
		assert.ok(firstLine.startsWith("a.ts"));
	});

	it("message >500 chars truncated", () => {
		const longMsg = "x".repeat(1000);
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: longMsg },
		]);
		assert.ok(result.length < 600);
		assert.ok(result.endsWith("..."));
	});

	it("unicode/emoji in message passed through", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "🚀 unicode test 世界" },
		]);
		assert.ok(result.includes("🚀 unicode test 世界"));
	});
});

describe("filterBySeverity", () => {
	const diags: LspDiagnostic[] = [
		{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "e" },
		{ file: "b.ts", line: 2, column: 1, severity: "Warning", message: "w" },
		{ file: "c.ts", line: 3, column: 1, severity: "Information", message: "i" },
		{ file: "d.ts", line: 4, column: 1, severity: "Hint", message: "h" },
	];

	it("threshold 'error' → only errors", () => {
		const result = filterBySeverity(diags, "error");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.severity, "Error");
	});

	it("threshold 'warning' → errors + warnings", () => {
		const result = filterBySeverity(diags, "warning");
		assert.strictEqual(result.length, 2);
	});

	it("threshold 'info' → all severities", () => {
		const result = filterBySeverity(diags, "info");
		assert.strictEqual(result.length, 4);
	});

	it("empty array → empty", () => {
		assert.deepStrictEqual(filterBySeverity([], "warning"), []);
	});

	it("unknown threshold string → defaults to warning (errors + warnings)", () => {
		const result = filterBySeverity(diags, "unknown");
		assert.strictEqual(result.length, 2);
	});

	it("null/undefined input → empty array (no crash)", () => {
		assert.deepStrictEqual(filterBySeverity(null as unknown as LspDiagnostic[], "warning"), []);
		assert.deepStrictEqual(
			filterBySeverity(undefined as unknown as LspDiagnostic[], "warning"),
			[],
		);
	});
});

describe("mergeAuditResults", () => {
	it("merges diagnostics and errors", () => {
		const result = mergeAuditResults([
			{
				diagnostics: [{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "e1" }],
				errors: ["srv1 failed"],
				note: "",
			},
			{
				diagnostics: [{ file: "b.ts", line: 2, column: 1, severity: "Warning", message: "w1" }],
				errors: [],
				note: "",
			},
		]);
		assert.strictEqual(result.diagnostics.length, 2);
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.note.includes("srv1 failed"));
	});

	it("both empty → empty result", () => {
		const result = mergeAuditResults([]);
		assert.deepStrictEqual(result, { diagnostics: [], errors: [], note: "" });
	});

	it("handles missing arrays", () => {
		const result = mergeAuditResults([
			{ diagnostics: undefined as unknown as LspDiagnostic[], errors: ["e"], note: "" },
			{
				diagnostics: [{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "x" }],
				errors: undefined as unknown as string[],
				note: "",
			},
		]);
		assert.strictEqual(result.diagnostics.length, 1);
		assert.strictEqual(result.errors.length, 1);
	});
});

describe("buildServerMappings", () => {
	it("undefined config → returns 4 default mappings", () => {
		const result = buildServerMappings(undefined);
		assert.strictEqual(result.length, 4);
		assert.ok(result.some((m) => m.extensions.includes(".ts")));
		assert.ok(result.some((m) => m.extensions.includes(".py")));
		assert.ok(result.some((m) => m.extensions.includes(".rs")));
		assert.ok(result.some((m) => m.extensions.includes(".go")));
	});

	it("TypeScript uses typescript-language-server --stdio", () => {
		const result = buildServerMappings(undefined);
		const ts = result.find((m) => m.extensions.includes(".ts"));
		assert.ok(ts);
		assert.strictEqual(ts!.command, "typescript-language-server");
		assert.deepStrictEqual(ts!.args, ["--stdio"]);
	});

	it("Python uses pyright-langserver --stdio", () => {
		const result = buildServerMappings(undefined);
		const py = result.find((m) => m.extensions.includes(".py"));
		assert.ok(py);
		assert.strictEqual(py!.command, "pyright-langserver");
	});

	it("user override .ts → replaces default .ts mapping, keeps others", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts"], command: "custom-ts" }],
		});
		const ts = result.find((m) => m.extensions.includes(".ts"));
		assert.ok(ts);
		assert.strictEqual(ts!.command, "custom-ts");
		assert.ok(result.some((m) => m.extensions.includes(".py")));
	});

	it("user adds new language .kt → added to defaults", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".kt"], command: "kotlin-ls" }],
		});
		assert.ok(result.some((m) => m.extensions.includes(".kt")));
		assert.ok(result.some((m) => m.extensions.includes(".ts")));
		assert.strictEqual(result.length, 5);
	});

	it("severityThreshold per-server honored", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "error" }],
		});
		const ts = result.find((m) => m.extensions.includes(".ts"));
		assert.strictEqual(ts!.severityThreshold, "error");
	});

	it("empty servers → returns defaults", () => {
		const result = buildServerMappings({ servers: [] });
		assert.strictEqual(result.length, 4);
	});

	it("extensions deduplicated", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts", ".TS", ".tsx", ".TSX"], command: "ts-ls" }],
		});
		const ts = result.find((m) => m.extensions.includes(".ts"));
		assert.ok(ts);
		assert.strictEqual(ts!.extensions.length, 2);
	});
});

describe("extractModifiedFiles", () => {
	it("parses git diff output into file list", () => {
		const output = "src/app.ts\nlib/utils.py\ndocs/readme.md\n";
		const result = extractModifiedFiles(output, "/tmp/worktree");
		assert.deepStrictEqual(result, ["src/app.ts", "lib/utils.py", "docs/readme.md"]);
	});

	it("empty output → []", () => {
		assert.deepStrictEqual(extractModifiedFiles("", "/tmp/worktree"), []);
	});

	it("path traversal pattern ../ → filtered out", () => {
		const result = extractModifiedFiles("src/../etc/passwd\nvalid.ts", "/tmp/worktree");
		assert.deepStrictEqual(result, ["valid.ts"]);
	});

	it("valid ..-bearing filenames are NOT filtered", () => {
		const result = extractModifiedFiles(
			"release..notes.ts\n..bar.ts\nfoo..bar/baz.ts",
			"/tmp/worktree",
		);
		assert.deepStrictEqual(result, ["release..notes.ts", "..bar.ts", "foo..bar/baz.ts"]);
	});

	it("trailing .. at end of line → filtered out (traversal risk)", () => {
		const result = extractModifiedFiles("foo/bar..\nvalid.ts", "/tmp/worktree");
		assert.deepStrictEqual(result, ["valid.ts"]);
	});

	it("absolute path → filtered out", () => {
		const result = extractModifiedFiles("/etc/passwd\nvalid.ts", "/tmp/worktree");
		assert.deepStrictEqual(result, ["valid.ts"]);
	});

	it("strips leading ./", () => {
		const result = extractModifiedFiles("./src/app.ts\n./lib.py", "/tmp/worktree");
		assert.deepStrictEqual(result, ["src/app.ts", "lib.py"]);
	});
});

describe("countRetryAttempts", () => {
	it("counts matching entries", () => {
		const entries = [
			{ type: "lsp-audit-retry", payload: { issueNum: 35 } },
			{ type: "lsp-audit-retry", payload: { issueNum: 35 } },
			{ type: "other", payload: {} },
		];
		assert.strictEqual(countRetryAttempts(entries, 35), 2);
	});

	it("no matching entries → 0", () => {
		const entries = [{ type: "other", payload: {} }];
		assert.strictEqual(countRetryAttempts(entries, 35), 0);
	});

	it("different issue → 0", () => {
		const entries = [{ type: "lsp-audit-retry", payload: { issueNum: 99 } }];
		assert.strictEqual(countRetryAttempts(entries, 35), 0);
	});

	it("null/undefined entries → 0", () => {
		assert.strictEqual(countRetryAttempts(null as unknown as [], 35), 0);
		assert.strictEqual(countRetryAttempts(undefined as unknown as [], 35), 0);
	});
});

describe("shouldRetry", () => {
	it("0 attempts → true", () => assert.strictEqual(shouldRetry(0), true));
	it("2 attempts → true", () => assert.strictEqual(shouldRetry(2), true));
	it("3 attempts → false", () => assert.strictEqual(shouldRetry(3), false));
	it("negative → treated as 0 → true", () => assert.strictEqual(shouldRetry(-1), true));
	it("NaN → treated as 0 → true", () => assert.strictEqual(shouldRetry(NaN), true));
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

describe("args splitting pattern (for parseArgs integration)", () => {
	it("empty args string split → array with empty string", () => {
		const args = "";
		const split = args.split(/\s+/);
		assert.deepStrictEqual(split, [""]);
	});

	it("simple flags split correctly", () => {
		const result = "--files src/".split(/\s+/);
		assert.deepStrictEqual(result, ["--files", "src/"]);
	});

	it("multiple flags and positionals split correctly", () => {
		const result = "--files src/ --verbose src/main.ts".split(/\s+/);
		assert.deepStrictEqual(result, ["--files", "src/", "--verbose", "src/main.ts"]);
	});

	it("whitespace normalization via split", () => {
		const result = "   --files   src/   ".trim().split(/\s+/);
		assert.deepStrictEqual(result, ["--files", "src/"]);
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
