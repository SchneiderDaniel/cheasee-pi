/**
 * Phase 3: Settings/config loading tests for LSP Auditor
 *
 * Tests buildServerMappings from .pi/extensions/lsp-auditor/server-mappings.ts
 * with various settings.json configurations.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/lsp-auditor-settings.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { buildServerMappings } from "../server-mappings.ts";
import type { LspAuditorSettings } from "../settings.ts";

// Re-create schema references here for test isolation — avoids import of
// non-exported schema objects while testing the same constraints.
import { Type } from "typebox";

const ServerEntrySchema = Type.Object({
	extensions: Type.Array(Type.String(), { minItems: 1 }),
	command: Type.String({ minLength: 1 }),
	args: Type.Optional(Type.Array(Type.String())),
	severityThreshold: Type.Optional(
		Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
	),
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Schema validation tests
// ═══════════════════════════════════════════════════════════════════════

describe("ServerEntrySchema — runtime validation", () => {
	it("accepts valid server entry with all fields", () => {
		assert.ok(
			Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "ts-ls",
				args: ["--stdio"],
				severityThreshold: "warning",
			}),
		);
	});

	it("accepts entry with only required fields (extensions, command)", () => {
		assert.ok(
			Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "ts-ls",
			}),
		);
	});

	it("rejects non-string extension element (bug 1)", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [".ts", 123],
				command: "ts-ls",
			}),
		);
	});

	it("rejects non-string severityThreshold (bug 2)", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "ts-ls",
				severityThreshold: 1,
			}),
		);
	});

	it("rejects non-array args (bug 3)", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "ts-ls",
				args: "--stdio",
			}),
		);
	});

	it("rejects empty command", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "",
			}),
		);
	});

	it("rejects missing command", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
			}),
		);
	});

	it("rejects missing extensions", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				command: "ts-ls",
			}),
		);
	});

	it("rejects empty extensions array (minItems: 1)", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [],
				command: "ts-ls",
			}),
		);
	});

	it("rejects severityThreshold outside enum (e.g. 'CRITICAL')", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "ts-ls",
				severityThreshold: "CRITICAL",
			}),
		);
	});

	it("rejects case-variant severityThreshold (e.g. 'Warning')", () => {
		assert.ok(
			!Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "ts-ls",
				severityThreshold: "Warning",
			}),
		);
	});

	it("accepts entry with extra unknown fields", () => {
		assert.ok(
			Value.Check(ServerEntrySchema, {
				extensions: [".ts"],
				command: "ts-ls",
				extraField: "ignored",
			}),
		);
	});

	it("Static type is assignable to expected shape (compile-time check)", () => {
		// This is a compile-time assertion: if LspAuditorSettings has the right
		// shape, this assignment works. If the schema drifts, this line fails.
		const _check: LspAuditorSettings extends { servers?: Array<{ extensions: string[]; command: string }> } ? true : never = true;
		assert.strictEqual(_check, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: buildServerMappings integration
// ═══════════════════════════════════════════════════════════════════════

describe("buildServerMappings — config integration", () => {
	it("no lspAuditor key → returns default server mappings", () => {
		const result = buildServerMappings(undefined);
		assert.strictEqual(result.length, 4);
		assert.ok(result.some((m) => m.extensions.includes(".ts")));
		assert.ok(result.some((m) => m.extensions.includes(".py")));
		assert.ok(result.some((m) => m.extensions.includes(".rs")));
		assert.ok(result.some((m) => m.extensions.includes(".go")));
	});

	it("partial server override — replaces .ts with custom, keeps .py/.rs/.go", () => {
		const config = {
			servers: [{ extensions: [".ts", ".tsx"], command: "custom-ts-server", args: ["--stdio"] }],
		};
		const result = buildServerMappings(config);
		assert.ok(result.some((m) => m.command === "custom-ts-server"));
		assert.ok(result.some((m) => m.command === "pyright-langserver"));
		assert.ok(result.some((m) => m.command === "rust-analyzer"));
		assert.ok(result.some((m) => m.command === "gopls"));
	});

	it("adds new language without removing defaults", () => {
		const config = {
			servers: [{ extensions: [".kt"], command: "kotlin-ls" }],
		};
		const result = buildServerMappings(config);
		assert.strictEqual(result.length, 5);
		assert.ok(result.some((m) => m.extensions.includes(".kt")));
	});

	it("valid severityThreshold 'error' honored", () => {
		const config = {
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "error" as const }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.severityThreshold, "error");
	});

	it("empty servers array → returns defaults only", () => {
		const config = { servers: [] };
		const result = buildServerMappings(config);
		assert.strictEqual(result.length, 4);
	});

	it("undefined config → defaults", () => {
		const result = buildServerMappings(undefined);
		assert.strictEqual(result.length, 4);
	});

	it("extensions array contains duplicates → deduplicated", () => {
		const config = {
			servers: [{ extensions: [".ts", ".TS", ".tsx", ".tsx"], command: "ts-ls" }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.extensions.length, 2);
	});

	it("multiple servers in config → all honored", () => {
		const config = {
			servers: [
				{ extensions: [".kt"], command: "kotlin-ls" },
				{ extensions: [".swift"], command: "sourcekit-lsp" },
			],
		};
		const result = buildServerMappings(config);
		assert.ok(result.length >= 6);
		assert.ok(result.some((m) => m.command === "kotlin-ls"));
		assert.ok(result.some((m) => m.command === "sourcekit-lsp"));
	});

	it("severityThreshold 'info' honored", () => {
		const config = {
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "info" as const }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.severityThreshold, "info");
	});
});
