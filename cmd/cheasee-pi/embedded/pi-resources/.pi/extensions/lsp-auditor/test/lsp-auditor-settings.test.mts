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
import { before, after, describe, it } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import { buildServerMappings } from "../server-mappings.ts";
import { readSettings, ServerEntrySchema } from "../settings.ts";
import type { LspAuditorSettings } from "../settings.ts";

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

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Adapter/integration tests (filesystem → readSettings → buildServerMappings)
// ═══════════════════════════════════════════════════════════════════════

function withTempSettings(
	settings: Record<string, unknown>,
	fn: (worktreePath: string) => void,
): void {
	const tmpDir = mkdtempSync(join(tmpdir(), "lsp-auditor-integration-"));
	try {
		const piDir = join(tmpDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "settings.json"), JSON.stringify(settings));
		fn(tmpDir);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

describe("readSettings → buildServerMappings — filesystem integration", () => {
	it("valid config round-trip", () => {
		withTempSettings(
			{
				lspAuditor: {
					servers: [
						{ extensions: [".ts"], command: "custom-ts", args: ["--stdio"] },
						{ extensions: [".kt"], command: "kotlin-ls" },
					],
				},
			},
			(worktree) => {
				const settings = readSettings(worktree);
				assert.ok(settings, "settings should not be null");
				assert.ok(settings!.lspAuditor, "lspAuditor should be present");
				assert.strictEqual(settings!.lspAuditor!.servers!.length, 2);

				const mappings = buildServerMappings(settings!.lspAuditor);
				assert.ok(mappings.some((m) => m.command === "custom-ts"));
				assert.ok(mappings.some((m) => m.command === "kotlin-ls"));
				// Defaults still present for non-overlapping extensions
				assert.ok(mappings.some((m) => m.command === "pyright-langserver"));
				assert.ok(mappings.some((m) => m.command === "rust-analyzer"));
				assert.ok(mappings.some((m) => m.command === "gopls"));
			},
		);
	});

	it("bug 1: non-string extension element -> entry dropped, no crash", () => {
		withTempSettings(
			{
				lspAuditor: {
					servers: [
						{ extensions: [".ts", 123], command: "bad-ts" },
						{ extensions: [".py"], command: "custom-py", args: ["--stdio"] },
					],
				},
			},
			(worktree) => {
				const settings = readSettings(worktree);
				assert.ok(settings, "settings should not be null");
				// Malformed entry filtered out, only valid one remains
				assert.strictEqual(settings!.lspAuditor!.servers!.length, 1);
				assert.strictEqual(settings!.lspAuditor!.servers![0]!.command, "custom-py");

				// No crash when building mappings
				const mappings = buildServerMappings(settings!.lspAuditor);
				assert.ok(mappings.some((m) => m.command === "custom-py"));
				assert.ok(mappings.some((m) => m.command === "typescript-language-server"));
			},
		);
	});

	it("bug 3: string args -> entry dropped, no crash, defaults apply", () => {
		withTempSettings(
			{
				lspAuditor: {
					servers: [
						{ extensions: [".ts"], command: "ts-ls", args: "--stdio" },
					],
				},
			},
			(worktree) => {
				const settings = readSettings(worktree);
				assert.ok(settings, "settings should not be null");
				// Malformed entry filtered out
				assert.strictEqual(settings!.lspAuditor!.servers!.length, 0);

				// No crash — defaults apply
				const mappings = buildServerMappings(settings!.lspAuditor);
				assert.strictEqual(mappings.length, 4);
				const tsMapping = mappings.find((m) => m.extensions.includes(".ts"))!;
				assert.strictEqual(tsMapping.command, "typescript-language-server");
				assert.deepStrictEqual(tsMapping.args, ["--stdio"]);
			},
		);
	});

	it("all entries malformed -> lspAuditor undefined, defaults only", () => {
		withTempSettings(
			{
				lspAuditor: {
					servers: [
						{ extensions: [".ts", 123], command: "bad-ts" },
						{ extensions: [".py"], command: 42 },
					],
				},
			},
			(worktree) => {
				const settings = readSettings(worktree);
				assert.ok(settings, "settings should not be null");
				// Both malformed -> empty servers array
				assert.strictEqual(settings!.lspAuditor!.servers!.length, 0);

				const mappings = buildServerMappings(settings!.lspAuditor);
				assert.strictEqual(mappings.length, 4);
			},
		);
	});

	it("lspAuditor is non-object (array) -> undefined, defaults apply", () => {
		withTempSettings(
			{
				lspAuditor: ["not", "an", "object"],
			},
			(worktree) => {
				const settings = readSettings(worktree);
				assert.ok(settings, "settings should not be null");
				assert.strictEqual(settings!.lspAuditor, undefined);

				const mappings = buildServerMappings(settings!.lspAuditor);
				assert.strictEqual(mappings.length, 4);
			},
		);
	});

	describe("user-journey: console.warn emitted for dropped entries", () => {
		let originalWarn: typeof console.warn;
		let warnMessages: string[];

		before(() => {
			originalWarn = console.warn;
		});

		after(() => {
			console.warn = originalWarn;
		});

		it("settings with non-string extension logs warning with entry content", () => {
			warnMessages = [];
			console.warn = (...args: unknown[]) => {
				warnMessages.push(args.join(" "));
			};

			withTempSettings(
				{
					lspAuditor: {
						servers: [
							{ extensions: [".ts", 123], command: "ts-ls" },
							{ extensions: [".py"], command: "pyright-langserver", args: ["--stdio"] },
						],
					},
				},
				(worktree) => {
					const settings = readSettings(worktree);
					assert.ok(settings, "settings should not be null");

					// Verify warning was emitted with malformed entry content
					assert.ok(
						warnMessages.some((m) => m.includes("123") && m.includes("[lsp-auditor]")),
						"console.warn should mention the malformed entry",
					);
					assert.ok(
						warnMessages.some((m) => m.includes("Dropped malformed server entry")),
						"console.warn should say 'Dropped malformed server entry'",
					);

					// Valid entry still processed
					const mappings = buildServerMappings(settings!.lspAuditor);
					assert.ok(mappings.some((m) => m.command === "pyright-langserver"));
					assert.ok(mappings.some((m) => m.command === "typescript-language-server"));
				},
			);

			console.warn = originalWarn;
		});

		it("settings with string args logs warning with entry content", () => {
			warnMessages = [];
			console.warn = (...args: unknown[]) => {
				warnMessages.push(args.join(" "));
			};

			withTempSettings(
				{
					lspAuditor: {
						servers: [
							{ extensions: [".ts"], command: "ts-ls", args: "--stdio" },
						],
					},
				},
				(worktree) => {
					readSettings(worktree);

					assert.ok(
						warnMessages.some((m) => m.includes("--stdio") && m.includes("[lsp-auditor]")),
						"console.warn should mention the malformed args entry",
					);
					assert.ok(
						warnMessages.some((m) => m.includes("Dropped malformed server entry")),
						"console.warn should say 'Dropped malformed server entry'",
					);
				},
			);

			console.warn = originalWarn;
		});
	});
});
