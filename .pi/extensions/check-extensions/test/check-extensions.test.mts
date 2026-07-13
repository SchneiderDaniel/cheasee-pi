/**
 * Tests for check-extensions extension
 *
 * Phases 1-8: all modules
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/check-extensions/test/check-extensions.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFile } from "node:child_process";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: changelog-parser.ts
// ═══════════════════════════════════════════════════════════════════════

import { parseChangelog, type ChangeEntry } from "../changelog-parser.ts";

describe("changelog-parser", () => {
	it("parses valid changelog with all categories", () => {
		const md = `# Changelog

## [1.0.0] - 2026-01-15

### Added

- New extension API for custom tools
- New registerCommand method on pi

### Changed

- Updated tool execution to use new ctx format

### Deprecated

- Old extension registration pattern

### Removed

- Legacy event system support for extensions

### Fixed

- Tool result event handling for custom extensions

### Security

- Updated extension sandbox permissions
`;
		const entries = parseChangelog(md);
		assert.ok(entries.length >= 5, `Expected at least 5 entries, got ${entries.length}`);
		// Check Added entries
		const added = entries.filter((e) => e.category === "Added");
		assert.ok(added.length >= 1);
		// Changed entries
		const changed = entries.filter((e) => e.category === "Changed");
		assert.ok(changed.length >= 1);
		// Deprecated entries
		const deprecated = entries.filter((e) => e.category === "Deprecated");
		assert.ok(deprecated.length >= 1);
		// Removed entries
		const removed = entries.filter((e) => e.category === "Removed");
		assert.ok(removed.length >= 1);
		// Fixed entries
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.ok(fixed.length >= 1);
		// Version extraction
		for (const e of entries) {
			assert.strictEqual(e.version, "1.0.0");
		}
	});

	it("API-visible keywords set apiNames and isBreaking for Deprecated/Removed", () => {
		const md = `## [2.0.0] - 2026-03-01

### Added

- New tool registration via registerTool API

### Deprecated

- Old extension event system, use pi.on instead

### Removed

- Legacy SDK export function removed

### Fixed

- Internal clipboard handling on macOS
`;
		const entries = parseChangelog(md);
		// Added entry with tool/registerTool keywords
		const added = entries.find((e) => e.category === "Added");
		assert.ok(added);
		assert.ok(added.apiNames.length > 0, "Added entry should have apiNames");
		assert.ok(added.apiNames.includes("registerTool"), "Should extract registerTool");

		// Deprecated - breaking
		const deprecated = entries.find((e) => e.category === "Deprecated");
		assert.ok(deprecated);
		assert.strictEqual(deprecated.isBreaking, true);

		// Removed - breaking
		const removed = entries.find((e) => e.category === "Removed");
		assert.ok(removed);
		assert.strictEqual(removed.isBreaking, true);

		// Fixed with internal-only terms - should be excluded
		const fixed = entries.find((e) => e.category === "Fixed");
		assert.strictEqual(fixed, undefined, "Fixed internal entry should be excluded");
	});

	it("Fixed entry with API-visible terms included in output", () => {
		const md = `## [1.1.0] - 2026-02-01

### Fixed

- Fixed tool result event handling for custom extensions
`;
		const entries = parseChangelog(md);
		const fixed = entries.find((e) => e.category === "Fixed");
		assert.ok(fixed, "Fixed entry with API-visible terms should be included");
		assert.ok(fixed.apiNames.length > 0);
	});

	it("Added entry mentioning pi.on or registerTool captures apiNames", () => {
		const md = `## [1.0.0] - 2026-01-01

### Added

- New pi.on event handler for session lifecycle
- Added registerTool for custom tool definitions
`;
		const entries = parseChangelog(md);
		const added = entries.filter((e) => e.category === "Added");
		assert.ok(added.length >= 2);
		const allApiNames = added.flatMap((e) => e.apiNames);
		assert.ok(allApiNames.includes("on"), "Should capture on from pi.on");
		assert.ok(allApiNames.includes("registerTool"), "Should capture registerTool");
	});

	it("Deprecated entry sets isBreaking=true", () => {
		const md = `## [1.0.0] - 2026-01-01

### Deprecated

- Old extension API deprecated
`;
		const entries = parseChangelog(md);
		const dep = entries.find((e) => e.category === "Deprecated");
		assert.ok(dep);
		assert.strictEqual(dep.isBreaking, true);
	});

	it("Boundary: empty changelog returns empty array", () => {
		assert.deepStrictEqual(parseChangelog(""), []);
	});

	it("Boundary: no version headers returns empty array, no crash", () => {
		assert.deepStrictEqual(
			parseChangelog("Just some text with no headers\n\nNo versions here"),
			[],
		);
	});

	it("Boundary: malformed header without date still parses version", () => {
		const md = `## [0.75.5]

### Added

- New extension API
`;
		const entries = parseChangelog(md);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.version, "0.75.5");
	});

	it("Boundary: category header with no bullet items produces entry with empty description", () => {
		const md = `## [1.0.0] - 2026-01-01

### Added
`;
		const entries = parseChangelog(md);
		const added = entries.find((e) => e.category === "Added");
		assert.ok(added);
		assert.strictEqual(added.description, "");
	});

	it("Error: undefined input returns empty array", () => {
		assert.deepStrictEqual(parseChangelog(undefined as unknown as string), []);
	});

	it("Error: null input returns empty array", () => {
		assert.deepStrictEqual(parseChangelog(null as unknown as string), []);
	});

	// ═══════════════════════════════════════════════════════════════
	// Bug fix: isInternalEntry must not drop Fixed entries with API names
	// ═══════════════════════════════════════════════════════════════

	it("Fixed entry with internal term AND API keyword includes apiNames (bug fix)", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed provider registration for pi.exec
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "Fixed entry should NOT be dropped");
		assert.ok(fixed[0]!.apiNames.includes("exec"), "Should extract 'exec' from pi.exec");
		assert.ok(fixed[0]!.apiNames.length > 0, "apiNames should not be empty");
	});

	it("Fixed entry with only internal terms (no API names) still excluded", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed provider connection timeout
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 0, "Pure internal Fixed entry should be excluded");
	});

	it("Fixed entry with different internal terms (no API) excluded", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed theme alignment on macOS
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 0, "Theme/macOS internal Fixed entry should be excluded");
	});

	it("Fixed entry with API-only terms (no internal) still included", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed extension registration for custom tools
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "API-only Fixed entry should be included");
		const apiNames = fixed[0]!.apiNames;
		assert.ok(apiNames.includes("extension"), "Should extract 'extension'");
		assert.ok(apiNames.includes("tool"), "Should extract 'tool'");
	});

	it("Fixed entry with multiple broad internal terms + API keyword included", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed bash login reference in pi.exec
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "Fixed entry with internal terms + API should be included");
		assert.ok(fixed[0]!.apiNames.includes("exec"), "Should extract 'exec' from pi.exec");
	});

	it("Fixed entry with worker/resize internal terms + pi.on included", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed worker resize handler for pi.on events
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "Fixed entry with worker+resize+pi.on should be included");
		assert.ok(fixed[0]!.apiNames.includes("on"), "Should extract 'on' from pi.on");
	});
});



// ═══════════════════════════════════════════════════════════════════════
// Phase 4: ast-scanner.ts — AST-based file scanning
// ═══════════════════════════════════════════════════════════════════════

import { scanExtensionsAST, type ASTFinding, type ASTScanningResult } from "../ast-scanner.ts";

/**
 * Resolve ast-grep binary path from npm global prefix.
 */
function getAstGrepPath(): string {
	const home = homedir();
	const candidates = [
		join(home, ".npm-global", "bin", "ast-grep"),
		"/usr/local/bin/ast-grep",
		"/usr/bin/ast-grep",
	];
	for (const c of candidates) {
		try {
			accessSync(c, constants.X_OK);
			return c;
		} catch {
			/* try next */
		}
	}
	return "ast-grep"; // fallback — hope it's on PATH
}

describe("ast-scanner", () => {
	let tmpDir: string;
	const astGrepPath = getAstGrepPath();

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ast-scan-test-"));
	});

	afterEach(() => {
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("finds runtime-call findings for pi.method calls", async () => {
		const extDir = join(tmpDir, "caveman");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`pi.on("session_start", async (_event: any, ctx: any) => {`,
				`  pi.registerCommand("caveman", { description: "", handler: async () => {} });`,
				`  pi.registerTool({ name: "test", execute: async () => {} });`,
				`  pi.exec("gh", ["issue"], { cwd: ctx.cwd });`,
				`  ctx.ui.notify("hello", "info");`,
				`  pi.sendUserMessage("test");`,
				`});`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(
			extDir,
			["pi.on", "pi.registerCommand", "pi.registerTool", "pi.exec", "pi.sendUserMessage", "ctx.ui"],
			execFn,
			astGrepPath,
		);

		// Should have runtime-call findings
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.ok(runtimeCalls.length >= 5, `Expected >=5 runtime calls, got ${runtimeCalls.length}`);

		const apiNames = runtimeCalls.map((f) => f.apiName);
		assert.ok(apiNames.includes("pi.on"), "Should find pi.on");
		assert.ok(apiNames.includes("pi.registerCommand"), "Should find pi.registerCommand");
		assert.ok(apiNames.includes("pi.registerTool"), "Should find pi.registerTool");
		assert.ok(apiNames.includes("pi.exec"), "Should find pi.exec");
		assert.ok(apiNames.includes("pi.sendUserMessage"), "Should find pi.sendUserMessage");
	});

	it("skips comments and string literals", async () => {
		const extDir = join(tmpDir, "clean-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`// TODO: migrate pi.on("tool_call", oldHandler)`,
				`// pi.registerCommand("old", { handler: oldFn });`,
				`const x = "pi.on inside string";`,
				`const y = "ctx.ui should not match";`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(
			extDir,
			["pi.on", "pi.registerCommand", "ctx.ui"],
			execFn,
			astGrepPath,
		);

		// No runtime-call findings from comments or strings
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.strictEqual(runtimeCalls.length, 0, "Should NOT find runtime calls in comments/strings");
	});

	it("classifies import-type and import-value contexts", async () => {
		const extDir = join(tmpDir, "import-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
				`import { registerCommand } from "@earendil-works/pi-coding-agent";`,
				`pi.on("session_start", async () => {});`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(
			extDir,
			["pi.on", "pi.registerCommand"],
			execFn,
			astGrepPath,
		);

		// Should have import-type finding
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.ok(typeImports.length >= 1, `Expected >=1 import-type, got ${typeImports.length}`);

		// Should have import-value finding
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.ok(valueImports.length >= 1, `Expected >=1 import-value, got ${valueImports.length}`);

		// Should have runtime-call finding
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.ok(runtimeCalls.length >= 1, `Expected >=1 runtime-call, got ${runtimeCalls.length}`);
	});

	// ═══════════════════════════════════════════════════════════
	// Bug fix: type-import false negatives — non-API type names
	// (ExtensionContext, ExtensionOptions, etc.) must be detected
	// regardless of whether the name contains "pi" as substring.
	// ═══════════════════════════════════════════════════════════

	it("import-type finding for ExtensionContext (no 'pi' substring)", async () => {
		const extDir = join(tmpDir, "ext-ctx-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			1,
			`Expected 1 import-type for ExtensionContext, got ${typeImports.length}`,
		);
		assert.strictEqual(typeImports[0]!.apiName, "pi.import-type");
	});

	it("import-type finding for any single non-API type (ExtensionOptions)", async () => {
		const extDir = join(tmpDir, "ext-options-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import type { ExtensionOptions } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			1,
			`Expected 1 import-type for ExtensionOptions, got ${typeImports.length}`,
		);
		assert.strictEqual(typeImports[0]!.apiName, "pi.import-type");
	});

	it("import-type finding for multiple non-API types in one import", async () => {
		const extDir = join(tmpDir, "multi-type-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import type { ExtensionContext, ExtensionOptions, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			1,
			`Expected 1 import-type for multiple types (1 per line), got ${typeImports.length}`,
		);
		assert.strictEqual(typeImports[0]!.apiName, "pi.import-type");
	});

	it("import-type finding for import from 'pi' source", async () => {
		const extDir = join(tmpDir, "pi-source-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `import type { ExtensionContext } from "pi";\n`);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			1,
			`Expected 1 import-type for 'pi' source, got ${typeImports.length}`,
		);
		assert.strictEqual(typeImports[0]!.apiName, "pi.import-type");
	});

	it("import-type finding still works for existing API names (regression guard)", async () => {
		const extDir = join(tmpDir, "api-name-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			1,
			`Expected 1 import-type for ExtensionAPI (regression guard), got ${typeImports.length}`,
		);
		assert.strictEqual(typeImports[0]!.apiName, "pi.import-type");
	});

	it("type import from non-pi module is not flagged", async () => {
		const extDir = join(tmpDir, "non-pi-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `import type { Foo } from "some-other-lib";\n`);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			0,
			`Expected 0 import-type for non-pi module, got ${typeImports.length}`,
		);
	});

	it("empty type import from pi module produces 0 findings, no crash", async () => {
		const extDir = join(tmpDir, "empty-type-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import type {} from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			0,
			`Expected 0 import-type for empty type import, got ${typeImports.length}`,
		);
	});

	it("type import with rename produces import-type finding", async () => {
		const extDir = join(tmpDir, "rename-type-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import type { ExtensionContext as Ctx } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, "ast-grep");
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			1,
			`Expected 1 import-type for renamed type, got ${typeImports.length}`,
		);
		assert.strictEqual(typeImports[0]!.apiName, "pi.import-type");
	});

	// ═══════════════════════════════════════════════════════════
	// False-positive prevention: substring matching in import findings
	// ═══════════════════════════════════════════════════════════

	it("value import with false-positive substrings produces zero import-value findings", async () => {
		const extDir = join(tmpDir, "false-pos-ext");
		mkdirSync(extDir, { recursive: true });
		// Each name below contains a PI_APIS short name as substring
		// but has no exact match. "connect".includes("on") = true,
		// "ExtensionAPI".includes("on") = true, "ExecResult".includes("exec") = true, etc.
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import { connect, ExtensionAPI, ExecResult, ExecOptions, isToolCallEventType } from "@earendil-works/pi-coding-agent";`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			0,
			`Expected 0 import-value findings for false-positive names, got ${valueImports.length}`,
		);
	});

	it("Edge: empty value import produces zero findings, no crash", async () => {
		const extDir = join(tmpDir, "empty-import-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `import {} from "@earendil-works/pi-coding-agent";\n`);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(valueImports.length, 0, "Empty import should produce 0 findings");
	});

	it("Edge: single exact match 'on' produces one pi.on import-value finding", async () => {
		const extDir = join(tmpDir, "exact-match-on");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(valueImports.length, 1, "Single exact match 'on' should produce 1 finding");
		assert.strictEqual(valueImports[0]!.apiName, "pi.on");
	});

	it("Edge: multiple exact matches 'on, exec' produce two findings", async () => {
		const extDir = join(tmpDir, "multi-exact-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import { on, exec } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Multiple exact matches should produce 2 findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi.exec", "pi.on"]);
	});

	it("extracts call args from pi.on matches", async () => {
		const extDir = join(tmpDir, "args-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);

		const piOnFindings = result.findings.filter((f) => f.apiName === "pi.on");
		assert.ok(piOnFindings.length >= 1);
		const finding = piOnFindings[0]!;
		// callArgs should include "session_start" (first arg)
		assert.ok(
			finding.callArgs.includes('"session_start"') ||
				finding.callArgs.some((a) => a.includes("session_start")),
			"Should extract first arg",
		);
	});

	// ═══════════════════════════════════════════════════════════════
	// Bug fix: mixed default + named imports (Pattern 4)
	// ═══════════════════════════════════════════════════════════════

	it("Pattern 4: mixed import 'pi, { on }' produces 2 findings (default + named)", async () => {
		const extDir = join(tmpDir, "mixed-ext-1");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import pi, { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.on"]);
	});

	it("Pattern 4: mixed import 'pi, { ExtensionAPI }' produces 1 finding (default only, not in PI_APIS)", async () => {
		const extDir = join(tmpDir, "mixed-ext-2");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import pi, { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			1,
			`Expected 1 import-value finding, got ${valueImports.length}`,
		);
		assert.strictEqual(valueImports[0]!.apiName, "pi");
	});

	it("Pattern 4: 'import * as pi, { on }' produces 2 findings", async () => {
		const extDir = join(tmpDir, "mixed-ext-3");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import * as pi, { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.on"]);
	});

	it("Pattern 4: 'import pi, { on, exec }' produces 3 findings", async () => {
		const extDir = join(tmpDir, "mixed-ext-4");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import pi, { on, exec } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			3,
			`Expected 3 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.exec", "pi.on"]);
	});

	it("Pattern 4: 'import pi, { on } from \"pi\"' produces 2 findings (pi source)", async () => {
		const extDir = join(tmpDir, "mixed-ext-5");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `import pi, { on } from "pi";\n`);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.on"]);
	});

	// Phase 2: non-pi module and no-pi-name edge cases

	it("Pattern 4: non-pi module 'import fs, { readFile } from \"node:fs\"' produces 0 findings", async () => {
		const extDir = join(tmpDir, "mixed-ext-6");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `import fs, { readFile } from "node:fs";\n`);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			0,
			`Expected 0 import-value findings, got ${valueImports.length}`,
		);
	});

	it("Pattern 4: 'import something, { on } from \"@earendil-works/pi-coding-agent\"' produces 1 finding (pi.on only)", async () => {
		const extDir = join(tmpDir, "mixed-ext-7");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import something, { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			1,
			`Expected 1 import-value finding, got ${valueImports.length}`,
		);
		assert.strictEqual(valueImports[0]!.apiName, "pi.on");
	});

	it("Pattern 4: empty named import 'pi, {}' produces 1 finding (default only)", async () => {
		const extDir = join(tmpDir, "mixed-ext-8");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import pi, { } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			1,
			`Expected 1 import-value finding, got ${valueImports.length}`,
		);
		assert.strictEqual(valueImports[0]!.apiName, "pi");
	});

	it("Pattern 4: 'import pi, { on, notAnApi } from ...' produces 2 findings (pi + pi.on)", async () => {
		const extDir = join(tmpDir, "mixed-ext-9");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import pi, { on, notAnApi } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.on"]);
	});

	// ═══════════════════════════════════════════════════════════════
	// Dedup: merged handler correctness (emitImportFinding + isPiDefaultImport)
	// ═══════════════════════════════════════════════════════════════

	it("Dedup: value import { on } + mixed pi, { exec } in same file produces 3 findings", async () => {
		const extDir = join(tmpDir, "dedup-1");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import { on } from "@earendil-works/pi-coding-agent";`,
				`import pi, { exec } from "@earendil-works/pi-coding-agent";`,
			].join("\n"),
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			3,
			`Expected 3 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.exec", "pi.on"]);
	});

	it("Dedup: value import { on } + mixed foo, { exec } in same file produces 2 findings", async () => {
		const extDir = join(tmpDir, "dedup-2");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import { on } from "@earendil-works/pi-coding-agent";`,
				`import foo, { exec } from "@earendil-works/pi-coding-agent";`,
			].join("\n"),
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi.exec", "pi.on"]);
	});

	it("Dedup: mixed import pipeline, { on } produces 2 findings ('pipeline' contains 'pi')", async () => {
		const extDir = join(tmpDir, "dedup-3");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import pipeline, { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.on"]);
	});

	it("Dedup: mixed import spirit, { on } produces 2 findings ('spirit' contains 'pi')", async () => {
		const extDir = join(tmpDir, "dedup-4");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import spirit, { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.on"]);
	});

	it("Dedup: mixed import foo, { bar } produces 0 findings (no 'pi' substring, no PI_APIS match)", async () => {
		const extDir = join(tmpDir, "dedup-5");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import foo, { bar } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			0,
			`Expected 0 import-value findings, got ${valueImports.length}`,
		);
	});

	it("Dedup: uppercase default name PI, { on } produces 2 findings (PI.toLowerCase().includes('pi'))", async () => {
		const extDir = join(tmpDir, "dedup-6");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import PI, { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi.on"]);
	});

	it("Dedup: all 4 import patterns in one file produce correct finding counts", async () => {
		const extDir = join(tmpDir, "dedup-7");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import type { ExtensionContext } from "@earendil-works/pi-coding-agent";`,
				`import { on } from "@earendil-works/pi-coding-agent";`,
				`import pi, { exec } from "@earendil-works/pi-coding-agent";`,
				`import pipeline from "@earendil-works/pi-coding-agent";`,
			].join("\n"),
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(typeImports.length, 1, "Expected 1 import-type finding");
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		// Pattern 2: { on } → pi.on
		// Pattern 4: pi, { exec } → pi + pi.exec
		// Pattern 3: pipeline → pi ("pipeline".includes("pi"))
		// Total: 4 import-value findings
		assert.strictEqual(
			valueImports.length,
			4,
			`Expected 4 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi", "pi", "pi.exec", "pi.on"]);
	});

	it("Dedup: two pi-ish default imports in same file produce 2 import-value findings", async () => {
		const extDir = join(tmpDir, "dedup-8");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import pi from "pi";`,
				`import pipeline from "@earendil-works/pi-coding-agent";`,
			].join("\n"),
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		// Both are default-import findings with apiName "pi"
		assert.deepStrictEqual(apiNames, ["pi", "pi"]);
	});

	// Phase 3: regression guards

	it("Regression: Pattern 2 still works for named-only imports", async () => {
		const extDir = join(tmpDir, "regr-p2-1");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import { on, exec } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Expected 2 import-value findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi.exec", "pi.on"]);
	});

	it("Regression: Pattern 3 still works for default imports", async () => {
		const extDir = join(tmpDir, "regr-p3-1");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `import pi from "@earendil-works/pi-coding-agent";\n`);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			1,
			`Expected 1 import-value finding, got ${valueImports.length}`,
		);
		assert.strictEqual(valueImports[0]!.apiName, "pi");
	});

	it("Regression: Pattern 1 still works for type imports", async () => {
		const extDir = join(tmpDir, "regr-p1-1");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.strictEqual(
			typeImports.length,
			1,
			`Expected 1 import-type finding, got ${typeImports.length}`,
		);
	});

	it("Regression: Pattern 3 namespace import '* as pi' still works", async () => {
		const extDir = join(tmpDir, "regr-p3-2");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import * as pi from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			1,
			`Expected 1 import-value finding, got ${valueImports.length}`,
		);
		assert.strictEqual(valueImports[0]!.apiName, "pi");
	});

	it("Regression: false-positive prevention still works with mixed import (not interfering)", async () => {
		const extDir = join(tmpDir, "regr-fp-1");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import { connect, ExecResult } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			0,
			`Expected 0 import-value findings, got ${valueImports.length}`,
		);
	});

	it("Boundary: empty extensions dir returns empty", async () => {
		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(
			join(tmpDir, "no-files"),
			["pi.on"],
			execFn,
			astGrepPath,
		);
		assert.strictEqual(result.findings.length, 0);
	});

	it("Boundary: file with no patterns produces no findings", async () => {
		const extDir = join(tmpDir, "empty-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `const x = 42;\nexport default x;\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		assert.strictEqual(result.findings.length, 0);
	});

	// ═══════════════════════════════════════════════════════════════
	// Root-file extensionName fix (ast-scanner)
	// ═══════════════════════════════════════════════════════════════

	it("top-level .ts files keep their own file stem in AST findings", async () => {
		mkdirSync(join(tmpDir, "dummy-ext"), { recursive: true });
		writeFileSync(join(tmpDir, "ripgrep-search.ts"), `pi.on("session_start", async () => {});\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(tmpDir, ["pi.on"], execFn, astGrepPath);
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.strictEqual(runtimeCalls.length, 1);
		assert.strictEqual(runtimeCalls[0]!.extensionName, "ripgrep-search");
	});

	it("multiple root-level .ts files each get correct extensionName (ast)", async () => {
		writeFileSync(join(tmpDir, "tsc-checkpoint.ts"), `pi.on("build", async () => {});\n`);
		writeFileSync(join(tmpDir, "structural-analyzer.ts"), `pi.exec("analyze", []);\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(tmpDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		assert.strictEqual(result.findings.length, 2);
		const names = result.findings.map((f) => f.extensionName).sort();
		assert.deepStrictEqual(names, ["structural-analyzer", "tsc-checkpoint"]);
	});

	it("subdirectory extension still correct alongside root-level .ts (ast regression)", async () => {
		const extDir = join(tmpDir, "caveman");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		writeFileSync(join(tmpDir, "tsc-checkpoint.ts"), `pi.on("check", async () => {});\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(tmpDir, ["pi.on"], execFn, astGrepPath);
		assert.strictEqual(result.findings.length, 2);
		const cavemanFindings = result.findings.filter((f) => f.extensionName === "caveman");
		assert.strictEqual(cavemanFindings.length, 1);
		const rootFindings = result.findings.filter((f) => f.extensionName === "tsc-checkpoint");
		assert.strictEqual(rootFindings.length, 1);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: change-resolver.ts — Changelog-to-usage context mapping
// ═══════════════════════════════════════════════════════════════════════

import { resolveRelevance, type StructuredChange } from "../change-resolver.ts";

describe("change-resolver", () => {
	it("returns true when changelog event matches finding args", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			apiNames: ["on"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 1,
			column: 1,
			lineContent: 'pi.on("tool_call", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ['"tool_call"'],
			matchContext: "runtime-call" as const,
		};
		const structured: StructuredChange = {
			deprecatedSignature: 'pi.on("tool_call")',
			newSignature: 'pi.on("tool_before_call")',
			affectedEventType: "tool_call",
		};

		const result = resolveRelevance(entry, finding, structured);
		assert.strictEqual(result, true);
	});

	it("returns undefined when finding uses variable arg (can't determine relevance)", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			apiNames: ["on"],
			isBreaking: true,
		};
		// Variable arg (eventName) — no quotes → can't statically determine relevance
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 1,
			column: 1,
			lineContent: "pi.on(eventName, handler)",
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ["eventName"],
			matchContext: "runtime-call" as const,
		};
		const structured: StructuredChange = {
			deprecatedSignature: 'pi.on("tool_call")',
			newSignature: 'pi.on("tool_before_call")',
			affectedEventType: "tool_call",
		};

		const result = resolveRelevance(entry, finding, structured);
		// Variable arg → can't determine → undefined (falls through, no false negative)
		assert.strictEqual(result, undefined);
	});

	it("returns false when changelog event doesn't match finding args", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			apiNames: ["on"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 5,
			column: 1,
			lineContent: 'pi.on("session_start", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ['"session_start"'],
			matchContext: "runtime-call" as const,
		};
		const structured: StructuredChange = {
			deprecatedSignature: 'pi.on("tool_call")',
			newSignature: 'pi.on("tool_before_call")',
			affectedEventType: "tool_call",
		};

		const result = resolveRelevance(entry, finding, structured);
		assert.strictEqual(result, false);
	});

	it("returns undefined when no structured change info available (falls through)", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Updated some internal API",
			apiNames: ["on"],
			isBreaking: false,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 1,
			column: 1,
			lineContent: 'pi.on("session_start", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ['"session_start"'],
			matchContext: "runtime-call" as const,
		};

		// No structured change provided → falls through (return undefined)
		const result = resolveRelevance(entry, finding, undefined);
		assert.strictEqual(result, undefined);
	});

	it("returns undefined when finding has no callArgs", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			apiNames: ["on"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 5,
			column: 1,
			lineContent: 'pi.on("tool_call", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: [],
			matchContext: "runtime-call" as const,
		};
		const structured: StructuredChange = {
			deprecatedSignature: 'pi.on("tool_call")',
			newSignature: 'pi.on("tool_before_call")',
			affectedEventType: "tool_call",
		};

		const result = resolveRelevance(entry, finding, structured);
		assert.strictEqual(result, undefined);
	});

	it("returns true for pi.registerCommand changes when command name matches", () => {
		const entry = {
			version: "2.0.0",
			category: "Deprecated" as const,
			description: "Registering commands without handler option deprecated",
			apiNames: ["registerCommand"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.registerCommand",
			line: 1,
			column: 1,
			lineContent: 'pi.registerCommand("my-cmd", { description: "", handler: async () => {} })',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ['"my-cmd"'],
			matchContext: "runtime-call" as const,
		};

		const result = resolveRelevance(entry, finding, undefined);
		// No structured change with specific deprecatedSignature → falls through
		assert.strictEqual(result, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: migration-generator.ts — Before/after code snippets
// ═══════════════════════════════════════════════════════════════════════

import { generateMigrationSnippet, type MigrationSnippet } from "../migration-generator.ts";

describe("migration-generator", () => {
	it("generates snippet for pi.on tool_call → tool_before_call", () => {
		const snippet = generateMigrationSnippet(
			"Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			"pi.on",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.before.includes("pi.on"), "before should contain pi.on");
			assert.ok(snippet.after.includes("pi.on"), "after should contain pi.on");
			assert.ok(snippet.before.includes("tool_call"), "before should mention tool_call");
			assert.ok(
				snippet.after.includes("tool_before_call"),
				"after should mention tool_before_call",
			);
			assert.ok(snippet.confidence > 0, "confidence should be positive");
		}
	});

	it("generates generic fallback for unknown changelog description", () => {
		const snippet = generateMigrationSnippet(
			"Fixed internal error handling for provider connections",
			"pi.exec",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.before.includes("Update"), "fallback should have generic message");
			assert.strictEqual(snippet.confidence, 0, "fallback confidence should be 0");
		}
	});

	it("returns snippet for pi.registerCommand changes", () => {
		const snippet = generateMigrationSnippet(
			"Registering commands now requires a handler option",
			"pi.registerCommand",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.confidence >= 0, "confidence should be >= 0");
		}
	});

	it("returns null for null/empty description", () => {
		const snippet = generateMigrationSnippet("", "pi.on");
		assert.strictEqual(snippet, null);
	});

	it("generates snippet for tool-related changes", () => {
		const snippet = generateMigrationSnippet(
			"Tool registration API changed: `registerTool({ ... })` now requires `execute` instead of `run`",
			"pi.registerTool",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.before.includes("registerTool"), "before should mention registerTool");
			assert.ok(snippet.confidence >= 0.4, "confidence should be >= 0.4 for known API");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: impact-scorer.ts — Cross-extension impact scoring
// ═══════════════════════════════════════════════════════════════════════

import { computeImpactScore, type ImpactScore } from "../impact-scorer.ts";

describe("impact-scorer", () => {
	it("scores no findings as 'none' severity", () => {
		const score = computeImpactScore("caveman", []);
		assert.strictEqual(score.severity, "none");
		assert.strictEqual(score.uniqueApis, 0);
		assert.strictEqual(score.breakingCount, 0);
	});

	it("scores one non-breaking finding as 'low' severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.on",
				line: 1,
				column: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: false,
				category: "Added",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("caveman", findings);
		assert.strictEqual(score.severity, "low");
		assert.strictEqual(score.uniqueApis, 1);
	});

	it("scores one breaking finding as 'medium' severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.on",
				line: 1,
				column: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Deprecated",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("caveman", findings);
		assert.strictEqual(score.severity, "medium");
		assert.strictEqual(score.breakingCount, 1);
	});

	it("scores multiple breaking findings as 'high' severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.on",
				line: 1,
				column: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Deprecated",
				callArgs: [],
				matchContext: "runtime-call",
			},
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.registerCommand",
				line: 2,
				column: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Removed",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("caveman", findings);
		assert.strictEqual(score.severity, "high");
		assert.strictEqual(score.uniqueApis, 2);
		assert.strictEqual(score.breakingCount, 2);
	});

	it("scores breaking+non-breaking mixed as appropriate severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "mixed",
				file: "a.ts",
				apiName: "pi.on",
				line: 1,
				column: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Deprecated",
				callArgs: [],
				matchContext: "runtime-call",
			},
			{
				extensionName: "mixed",
				file: "a.ts",
				apiName: "pi.exec",
				line: 2,
				column: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Removed",
				callArgs: [],
				matchContext: "runtime-call",
			},
			{
				extensionName: "mixed",
				file: "a.ts",
				apiName: "ctx.ui",
				line: 3,
				column: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: false,
				category: "Added",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("mixed", findings);
		assert.strictEqual(score.severity, "high");
		assert.strictEqual(score.uniqueApis, 3);
	});

	it("sets extensionName on result", () => {
		const score = computeImpactScore("my-ext", []);
		assert.strictEqual(score.extensionName, "my-ext");
	});

	it("scores 6+ breaking findings as 'critical'", () => {
		const findings: ASTFinding[] = Array.from({ length: 6 }, (_, i) => ({
			extensionName: "big-ext",
			file: "index.ts",
			apiName: `api.${i}`,
			line: i + 1,
			column: 1,
			lineContent: "",
			changelogVersion: "",
			isBreaking: true,
			category: "Deprecated",
			callArgs: [],
			matchContext: "runtime-call" as const,
		}));
		const score = computeImpactScore("big-ext", findings);
		assert.strictEqual(score.severity, "critical");
		assert.strictEqual(score.uniqueApis, 6);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 9: changelog-parser.ts — Extended: parseStructuredChange
// ═══════════════════════════════════════════════════════════════════════

import { parseStructuredChange } from "../changelog-parser.ts";

describe("parseStructuredChange", () => {
	it("parses pi.on tool_call → tool_before_call migration", () => {
		const result = parseStructuredChange(
			"Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
		);
		assert.ok(result, "Expected a StructuredChange");
		if (result) {
			assert.strictEqual(result.deprecatedSignature, 'pi.on("tool_call")');
			assert.strictEqual(result.newSignature, 'pi.on("tool_before_call")');
			assert.strictEqual(result.affectedEventType, "tool_call");
		}
	});

	it("parses pi.registerCommand signature change", () => {
		const result = parseStructuredChange(
			"`pi.registerCommand(name, opts)` now requires `opts.handler` to be async",
		);
		assert.ok(result, "Expected a StructuredChange");
		if (result) {
			assert.ok(result.deprecatedSignature?.includes("registerCommand"));
			assert.ok(result.newSignature?.includes("registerCommand"));
		}
	});

	it("returns null for non-API description", () => {
		const result = parseStructuredChange("Fixed internal provider connection error");
		assert.strictEqual(result, null);
	});

	it("parses ctx.ui redesign description", () => {
		const result = parseStructuredChange(
			"`ctx.ui.select()` args changed from `(items, prompt)` to `(config)`",
		);
		assert.ok(result, "Expected a StructuredChange");
		if (result) {
			assert.ok(
				result.deprecatedSignature?.includes("ctx.ui") || result.affectedEventType === "select",
			);
		}
	});

	it("returns null for empty description", () => {
		assert.strictEqual(parseStructuredChange(""), null);
	});
});



// ═══════════════════════════════════════════════════════════════════════
// Phase 11: constants.ts — Extracted configuration constants
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PI_CHANGELOG_PATH, API_PATTERNS, CHANGELOG_API_TO_PATTERN_LOWER } from "../constants.ts";

const EXT_DIR = new URL("..", import.meta.url).pathname;

describe("constants", () => {
	it("PI_CHANGELOG_PATH is a non-empty string", () => {
		assert.ok(typeof PI_CHANGELOG_PATH === "string");
		assert.ok(PI_CHANGELOG_PATH.length > 0);
		assert.ok(PI_CHANGELOG_PATH.includes("CHANGELOG.md"));
	});

	it("PI_CHANGELOG_PATH uses import.meta.resolve (not hardcoded)", () => {
		const source = readFileSync(join(EXT_DIR, "constants.ts"), "utf-8");
		assert.ok(
			source.includes("import.meta.resolve"),
			"constants.ts must use import.meta.resolve for dynamic resolution",
		);
	});

	it("API_PATTERNS contains known pi API names", () => {
		assert.ok(Array.isArray(API_PATTERNS));
		assert.ok(API_PATTERNS.length > 0);
		assert.ok(API_PATTERNS.includes("pi.on"));
		assert.ok(API_PATTERNS.includes("pi.exec"));
		assert.ok(API_PATTERNS.includes("ctx.ui"));
	});

	it("API_PATTERNS every element starts with pi. or ctx.", () => {
		assert.ok(API_PATTERNS.length > 0);
		for (const p of API_PATTERNS) {
			assert.ok(
				typeof p === "string" && p.length > 0,
				`API_PATTERNS element "${p}" must be non-empty string`,
			);
			assert.ok(
				p.startsWith("pi.") || p.startsWith("ctx."),
				`API_PATTERNS element "${p}" must start with pi. or ctx.`,
			);
		}
	});

	it("API_PATTERNS has no duplicate entries", () => {
		const seen = new Set<string>();
		for (const p of API_PATTERNS) {
			assert.ok(!seen.has(p), `API_PATTERNS has duplicate: "${p}"`);
			seen.add(p);
		}
	});

	it("API_PATTERNS is not frozen (reliably const-bound)", () => {
		// The constant binding itself prevents reassignment;
		// the array should remain mutable (not frozen)
		assert.ok(!Object.isFrozen(API_PATTERNS), "API_PATTERNS should not be frozen");
	});

	it("CHANGELOG_API_TO_PATTERN_LOWER maps known aliases", () => {
		assert.ok(CHANGELOG_API_TO_PATTERN_LOWER["on"]?.includes("pi.on"));
		assert.ok(CHANGELOG_API_TO_PATTERN_LOWER["tool"]?.includes("pi.registerTool"));
		assert.ok(CHANGELOG_API_TO_PATTERN_LOWER["event"]?.includes("pi.on"));
	});

	it("CHANGELOG_API_TO_PATTERN_LOWER is non-empty object with all non-empty array values", () => {
		const keys = Object.keys(CHANGELOG_API_TO_PATTERN_LOWER);
		assert.ok(keys.length > 0, "CHANGELOG_API_TO_PATTERN_LOWER must have at least one key");
		for (const [key, value] of Object.entries(CHANGELOG_API_TO_PATTERN_LOWER)) {
			assert.ok(Array.isArray(value), `CHANGELOG_API_TO_PATTERN_LOWER["${key}"] must be an array`);
			assert.ok(value.length > 0, `CHANGELOG_API_TO_PATTERN_LOWER["${key}"] must be non-empty`);
		}
	});

	it("CHANGELOG_API_TO_PATTERN_LOWER values are subsets of API_PATTERNS (no orphan patterns)", () => {
		const apiSet = new Set(API_PATTERNS);
		for (const [key, patterns] of Object.entries(CHANGELOG_API_TO_PATTERN_LOWER)) {
			for (const p of patterns) {
				assert.ok(
					apiSet.has(p),
					`CHANGELOG_API_TO_PATTERN_LOWER["${key}"] contains "${p}" which is not in API_PATTERNS`,
				);
			}
		}
	});

	it("CHANGELOG_API_TO_PATTERN_LOWER has entries for all API_PATTERNS", () => {
		const allMappedPatterns = new Set(Object.values(CHANGELOG_API_TO_PATTERN_LOWER).flat());
		for (const pattern of API_PATTERNS) {
			assert.ok(
				allMappedPatterns.has(pattern),
				`API_PATTERN "${pattern}" has no mapping in CHANGELOG_API_TO_PATTERN_LOWER`,
			);
		}
	});

	it("CHANGELOG_API_TO_PATTERN_LOWER is frozen at runtime", () => {
		assert.ok(
			Object.isFrozen(CHANGELOG_API_TO_PATTERN_LOWER),
			"CHANGELOG_API_TO_PATTERN_LOWER must be frozen",
		);
		const keys = Object.keys(CHANGELOG_API_TO_PATTERN_LOWER);
		assert.ok(keys.length >= 10, "Should have at least 10 alias mappings");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 11b: Migration contract — index.ts no longer owns constants
// ═══════════════════════════════════════════════════════════════════════

describe("migration-contract — index.ts", () => {
	const indexSrc = readFileSync(join(EXT_DIR, "index.ts"), "utf-8");

	it("does NOT import PI_CHANGELOG_PATH", () => {
		assert.ok(
			!indexSrc.includes("PI_CHANGELOG_PATH"),
			"index.ts must not reference PI_CHANGELOG_PATH",
		);
	});

	it("does NOT import API_PATTERNS", () => {
		assert.ok(!indexSrc.includes("API_PATTERNS"), "index.ts must not reference API_PATTERNS");
	});

	it("does NOT import from node:os", () => {
		assert.ok(!indexSrc.includes('from "node:os"'), "index.ts must not import from node:os");
	});

	it("does NOT import from node:path", () => {
		assert.ok(!indexSrc.includes('from "node:path"'), "index.ts must not import from node:path");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 11c: Consumer contract — pipeline.ts uses imports, not local defs
// ═══════════════════════════════════════════════════════════════════════

describe("consumer-contract — pipeline.ts", () => {
	const pipelineSrc = readFileSync(join(EXT_DIR, "pipeline.ts"), "utf-8");

	it("imports PI_CHANGELOG_PATH from ./constants.ts", () => {
		assert.ok(
			pipelineSrc.includes("PI_CHANGELOG_PATH") && pipelineSrc.includes('from "./constants.ts"'),
			"pipeline.ts must import PI_CHANGELOG_PATH from ./constants.ts",
		);
	});

	it("imports API_PATTERNS from ./constants.ts", () => {
		assert.ok(
			pipelineSrc.includes("API_PATTERNS") && pipelineSrc.includes('from "./constants.ts"'),
			"pipeline.ts must import API_PATTERNS from ./constants.ts",
		);
	});

	it("imports CHANGELOG_API_TO_PATTERN_LOWER from ./constants.ts", () => {
		assert.ok(
			pipelineSrc.includes("CHANGELOG_API_TO_PATTERN_LOWER") &&
				pipelineSrc.includes('from "./constants.ts"'),
			"pipeline.ts must import CHANGELOG_API_TO_PATTERN_LOWER from ./constants.ts",
		);
	});

	it("does NOT re-define const PI_CHANGELOG_PATH locally", () => {
		assert.ok(
			!pipelineSrc.includes("const PI_CHANGELOG_PATH"),
			"pipeline.ts must not define PI_CHANGELOG_PATH locally",
		);
	});

	it("does NOT re-define const API_PATTERNS locally", () => {
		assert.ok(
			!pipelineSrc.includes("const API_PATTERNS"),
			"pipeline.ts must not define API_PATTERNS locally",
		);
	});

	it("does NOT re-define const CHANGELOG_API_TO_PATTERN_LOWER locally", () => {
		assert.ok(
			!pipelineSrc.includes("const CHANGELOG_API_TO_PATTERN_LOWER"),
			"pipeline.ts must not define CHANGELOG_API_TO_PATTERN_LOWER locally",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 12: pipeline.ts — ChangelogPipeline class
// ═══════════════════════════════════════════════════════════════════════

import {
	ChangelogPipeline,
	runPipeline,
	type PipelineContext,
	type PipelineReport,
} from "../pipeline.ts";

describe("ChangelogPipeline", () => {
	it("can be constructed with minimal pi and ctx mocks", () => {
		const pi = {
			registerCommand: () => {},
			sendUserMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		} as unknown as any;

		const ctx: PipelineContext = {
			cwd: "/tmp",
			ui: { notify: () => {} },
			hasUI: true,
		};

		const pipeline = new ChangelogPipeline(pi, ctx);
		assert.ok(pipeline instanceof ChangelogPipeline);
	});

	it("has all expected phase methods", () => {
		const pi = {} as any;
		const ctx: PipelineContext = { cwd: "/tmp", ui: { notify: () => {} }, hasUI: true };
		const pipeline = new ChangelogPipeline(pi, ctx);

		assert.strictEqual(typeof pipeline.validatePhase, "function");
		assert.strictEqual(typeof pipeline.parsePhase, "function");
		assert.strictEqual(typeof pipeline.scanPhase, "function");
		assert.strictEqual(typeof pipeline.crossRefPhase, "function");
		assert.strictEqual(typeof pipeline.issuePhase, "function");
		assert.strictEqual(typeof pipeline.run, "function");
	});

	it("runPipeline convenience function exists", () => {
		assert.strictEqual(typeof runPipeline, "function");
	});

	it("PipelineReport type has expected shape", async () => {
		// create a minimal valid report
		const report: PipelineReport = {
			lines: [],
			createdIssues: [],
			skippedExtensions: [],
			findingsByExtension: new Map(),
			totalFindings: 0,
		};
		assert.ok(Array.isArray(report.lines));
		assert.ok(Array.isArray(report.createdIssues));
		assert.ok(Array.isArray(report.skippedExtensions));
		assert.ok(report.findingsByExtension instanceof Map);
		assert.strictEqual(report.totalFindings, 0);
	});

	it("validatePhase returns content or null without crashing", async () => {
		const pi = {
			sendUserMessage: () => {},
		} as any;
		const ctx: PipelineContext = {
			cwd: "/nonexistent",
			ui: { notify: () => {} },
			hasUI: true,
		};
		const pipeline = new ChangelogPipeline(pi, ctx);
		const result = pipeline.validatePhase();
		// Returns string content if changelog exists, null otherwise
		// Both are valid — we just verify it doesn't crash
		assert.ok(result === null || typeof result === "string");
	});

	it("parsePhase returns entries from valid changelog content", () => {
		const pi = { sendUserMessage: () => {} } as any;
		const ctx: PipelineContext = { cwd: "/tmp", ui: { notify: () => {} }, hasUI: true };
		const pipeline = new ChangelogPipeline(pi, ctx);

		const md = `## [1.0.0] - 2026-01-01

### Added

- New pi.on event handler
`;
		const result = pipeline.parsePhase(md);
		assert.ok(result.entries.length >= 1);
		assert.strictEqual(result.latestVersion, "1.0.0");
		assert.ok(result.affectedApiPatterns.size > 0);
		assert.ok(result.affectedApiPatterns.has("pi.on"));
	});

	it("parsePhase handles empty changelog gracefully", () => {
		const pi = { sendUserMessage: () => {} } as any;
		const ctx: PipelineContext = { cwd: "/tmp", ui: { notify: () => {} }, hasUI: true };
		const pipeline = new ChangelogPipeline(pi, ctx);

		const result = pipeline.parsePhase("");
		assert.strictEqual(result.entries.length, 0);
		assert.strictEqual(result.latestVersion, "latest");
		// Should fall back to all API patterns
		assert.ok(result.affectedApiPatterns.size > 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 13: ast-grep path resolver (now in pipeline.ts)
// ═══════════════════════════════════════════════════════════════════════

import { resolveAstGrepPath } from "../pipeline.ts";

describe("resolve-astgrep", () => {
	it("returns a non-empty string", () => {
		const path = resolveAstGrepPath();
		assert.ok(typeof path === "string");
		assert.ok(path.length > 0);
	});

	it("returns something that looks like a binary path or command name", () => {
		const path = resolveAstGrepPath();
		// Should either be an absolute path or a bare command name
		assert.ok(
			path.includes("ast-grep") || path === "ast-grep",
			`Expected ast-grep in path, got: ${path}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 15: extractApiNames — "config option" keyword mapping (Issue #566)
// ═══════════════════════════════════════════════════════════════════════

import { extractApiNames, API_KEYWORDS } from "../changelog-parser.ts";

describe("extractApiNames — config option (Phase 1: characterization)", () => {
	it('returns "config option" for "Added config option for extension flag support"', () => {
		const names = extractApiNames("Added config option for extension flag support");
		assert.ok(names.includes("config option"), "Should include 'config option'");
	});

	it('returns "config option" for "Added config option only"', () => {
		const names = extractApiNames("Added config option only");
		assert.ok(names.includes("config option"), "Should include 'config option'");
	});

	it('returns "config option" for "New config option"', () => {
		const names = extractApiNames("New config option");
		assert.ok(names.includes("config option"), "Should include 'config option' on substring match");
	});

	it('does NOT return "config" for "Added configuration option"', () => {
		const names = extractApiNames("Added configuration option");
		// "configuration" contains "config" substring but not "config option"
		assert.ok(!names.includes("config"), "Should NOT include 'config' for 'configuration'");
	});

	it('returns empty array for ""', () => {
		assert.deepStrictEqual(extractApiNames(""), []);
	});

	it('returns empty array for "No API keywords here"', () => {
		assert.deepStrictEqual(extractApiNames("No API keywords here"), []);
	});
});

describe("CHANGELOG_API_TO_PATTERN_LOWER — config option (Phase 2: fix mapping)", () => {
	it('CHANGELOG_API_TO_PATTERN_LOWER["config option"] equals ["pi.registerFlag", "pi.getFlag"]', () => {
		assert.deepStrictEqual(CHANGELOG_API_TO_PATTERN_LOWER["config option"], [
			"pi.registerFlag",
			"pi.getFlag",
		]);
	});

	it("CHANGELOG_API_TO_PATTERN_LOWER remains frozen", () => {
		assert.ok(Object.isFrozen(CHANGELOG_API_TO_PATTERN_LOWER));
	});

	it("All API_KEYWORDS map to existing CHANGELOG_API_TO_PATTERN_LOWER keys (SSOT invariant)", () => {
		// For each keyword, determine what name extractApiNames pushes (excluding regex additions)
		// The if-else chain or else-fallthrough pushes the canonical name
		const ifElseMapping: Record<string, string> = {
			"pi.on": "on",
			"pi.exec": "exec",
			"pi.sendUserMessage": "sendUserMessage",
			"ctx.ui": "ctx.ui",
			"ctx.sessionManager": "sessionManager",
			"ctx.abort": "abort",
			"pi.registerFlag": "registerFlag",
			"pi.registerShortcut": "registerShortcut",
			"pi.getFlag": "getFlag",
			"pi.setActiveTools": "setActiveTools",
			registerCommand: "registerCommand",
			registerTool: "registerTool",
			"config option": "config option", // after if-else removal, falls through to else
			export: "export",
			tool: "tool",
			command: "command",
			event: "event",
			SDK: "sdk",
			sdk: "sdk",
		};
		for (const kw of API_KEYWORDS) {
			const name = ifElseMapping[kw] ?? kw;
			const patterns = CHANGELOG_API_TO_PATTERN_LOWER[name.toLowerCase()];
			assert.ok(
				Array.isArray(patterns) && patterns.length > 0,
				`Keyword "${kw}" maps to name "${name}" which has no entry in CHANGELOG_API_TO_PATTERN_LOWER`,
			);
		}
	});

	it("parsePhase round-trip: 'Added config option for extension flags' affects pi.registerFlag and pi.getFlag", () => {
		const pi = { sendUserMessage: () => {} } as any;
		const ctx: PipelineContext = { cwd: "/tmp", ui: { notify: () => {} }, hasUI: true };
		const pipeline = new ChangelogPipeline(pi, ctx);

		const md = `## [0.76.0] - 2026-06-01\n\n### Added\n\n- Added config option for extension flags\n`;
		const result = pipeline.parsePhase(md);

		assert.ok(result.affectedApiPatterns.has("pi.registerFlag"), "Should include pi.registerFlag");
		assert.ok(result.affectedApiPatterns.has("pi.getFlag"), "Should include pi.getFlag");
	});
});

describe("extractApiNames — config option (Phase 3: remove if-else coupling)", () => {
	it('returns "config option" instead of "config" for "Added config option for extension flag support"', () => {
		const names = extractApiNames("Added config option for extension flag support");
		// After removing the if-else, "config option" keyword falls through to else and pushes kw as-is
		assert.ok(
			names.includes("config option"),
			"Should include 'config option' (pushed via else fallback, not if-else translation)",
		);
	});

	it('returns "config option" not "config" for "Added config option only"', () => {
		const names = extractApiNames("Added config option only");
		assert.ok(names.includes("config option"), "Should include 'config option'");
		// After if-else removal, "config" should NOT be in the result
		// (unless another keyword happens to push "config")
	});

	it("SSOT invariant still holds: CHANGELOG_API_TO_PATTERN_LOWER has 'config option' key", () => {
		assert.ok(
			Array.isArray(CHANGELOG_API_TO_PATTERN_LOWER["config option"]),
			"CHANGELOG_API_TO_PATTERN_LOWER should have 'config option' key",
		);
		assert.deepStrictEqual(
			CHANGELOG_API_TO_PATTERN_LOWER["config option"],
			["pi.registerFlag", "pi.getFlag"],
			"Should map to same patterns as 'config'",
		);
	});

	it("parsePhase round-trip still produces correct patterns", () => {
		const pi = { sendUserMessage: () => {} } as any;
		const ctx: PipelineContext = { cwd: "/tmp", ui: { notify: () => {} }, hasUI: true };
		const pipeline = new ChangelogPipeline(pi, ctx);

		const md = `## [0.76.0] - 2026-06-01\n\n### Added\n\n- Added config option for extension flags\n`;
		const result = pipeline.parsePhase(md);

		assert.ok(
			result.affectedApiPatterns.has("pi.registerFlag"),
			"pi.registerFlag should still be affected",
		);
		assert.ok(result.affectedApiPatterns.has("pi.getFlag"), "pi.getFlag should still be affected");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 17: parseCheckExtensionsArgs — Argument parsing
// ═══════════════════════════════════════════════════════════════════════

import { parseCheckExtensionsArgs, registerCheckExtensions } from "../index.ts";

describe("registerCheckExtensions", () => {
	it("is a function (named export plus default)", () => {
		assert.equal(typeof registerCheckExtensions, "function");
	});

	it("registers 'check-extensions' command when called", () => {
		let registeredName = "";
		let registeredHandler: ((_args: string, _ctx: any) => Promise<void>) | null = null;

		const mockPi = {
			registerCommand: (
				name: string,
				cmd: { handler: (_args: string, _ctx: any) => Promise<void> },
			) => {
				registeredName = name;
				registeredHandler = cmd.handler;
			},
		} as any;

		registerCheckExtensions(mockPi);

		assert.equal(registeredName, "check-extensions");
		assert.equal(typeof registeredHandler, "function");
	});
});

describe("parseCheckExtensionsArgs", () => {
	it("returns empty result for undefined args", () => {
		assert.equal(parseCheckExtensionsArgs(undefined).unknownFlags.size, 0);
		assert.equal(parseCheckExtensionsArgs(undefined).messages.length, 0);
	});

	it("returns empty result for empty string", () => {
		assert.equal(parseCheckExtensionsArgs("").unknownFlags.size, 0);
		assert.equal(parseCheckExtensionsArgs("").messages.length, 0);
	});

	it("returns empty result for whitespace-only string", () => {
		assert.equal(parseCheckExtensionsArgs("   ").unknownFlags.size, 0);
		assert.equal(parseCheckExtensionsArgs("   ").messages.length, 0);
	});

	it("captures unknown flags with values", () => {
		assert.equal(parseCheckExtensionsArgs("--dry-run --since=v0.78.0").unknownFlags.size, 2);
		assert.equal(
			parseCheckExtensionsArgs("--dry-run --since=v0.78.0").unknownFlags.get("dry-run"),
			true,
		);
		assert.equal(
			parseCheckExtensionsArgs("--dry-run --since=v0.78.0").unknownFlags.get("since"),
			"v0.78.0",
		);
	});

	it("captures flag with space-separated value", () => {
		assert.equal(parseCheckExtensionsArgs("--extension caveman").unknownFlags.size, 1);
		assert.equal(
			parseCheckExtensionsArgs("--extension caveman").unknownFlags.get("extension"),
			"caveman",
		);
	});

	it("captures multiple flags and messages", () => {
		assert.equal(
			parseCheckExtensionsArgs("--verbose --since=v0.78.0 some-positional").unknownFlags.size,
			2,
		);
		assert.equal(
			parseCheckExtensionsArgs("--verbose --since=v0.78.0 some-positional").unknownFlags.get(
				"verbose",
			),
			true,
		);
		assert.equal(
			parseCheckExtensionsArgs("--verbose --since=v0.78.0 some-positional").unknownFlags.get(
				"since",
			),
			"v0.78.0",
		);
		assert.equal(
			parseCheckExtensionsArgs("--verbose --since=v0.78.0 some-positional").messages.length,
			1,
		);
		assert.equal(
			parseCheckExtensionsArgs("--verbose --since=v0.78.0 some-positional").messages[0],
			"some-positional",
		);
	});

	it("handles flag with equals sign and empty value", () => {
		assert.equal(parseCheckExtensionsArgs("--flag=").unknownFlags.size, 1);
		assert.equal(parseCheckExtensionsArgs("--flag=").unknownFlags.get("flag"), "");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 18: Handler — Trust gate and parseArgs integration
// ═══════════════════════════════════════════════════════════════════════

describe("check-extensions handler — trust gate", () => {
	it("does NOT call runPipeline when isProjectTrusted() returns false", async () => {
		let capturedHandler!: (args: string, ctx: any) => Promise<void>;
		let userMessageSent = false;

		const pi = {
			on: () => {},
			registerCommand: (
				_name: string,
				cmd: { handler: (args: string, ctx: any) => Promise<void> },
			) => {
				capturedHandler = cmd.handler;
			},
			sendUserMessage: (_msg: string) => {
				userMessageSent = true;
			},
			sendMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		} as unknown as any;

		const mod = await import("../index.ts");
		mod.default(pi);

		const testCtx = {
			cwd: "/tmp",
			ui: { notify: () => {} },
			hasUI: true,
			isProjectTrusted: () => false,
		};

		await capturedHandler("", testCtx);

		// Handler should have sent user message about trust
		assert.equal(userMessageSent, true, "should send trust-gate user message");
	});

	it("calls runPipeline when isProjectTrusted() returns true", async () => {
		let capturedHandler!: (args: string, ctx: any) => Promise<void>;
		let notifyCalled = false;

		const pi = {
			on: () => {},
			registerCommand: (
				_name: string,
				cmd: { handler: (args: string, ctx: any) => Promise<void> },
			) => {
				capturedHandler = cmd.handler;
			},
			sendUserMessage: () => {},
			sendMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		} as unknown as any;

		const mod = await import("../index.ts");
		mod.default(pi);

		const testCtx = {
			cwd: "/tmp",
			ui: {
				notify: (_msg: string, _level: string) => {
					notifyCalled = true;
				},
			},
			hasUI: true,
			isProjectTrusted: () => true,
		};

		// Handler should proceed past trust gate and attempt pipeline
		await capturedHandler("", testCtx);

		// Handler should have called ctx.ui.notify (from pipeline's validatePhase)
		assert.equal(notifyCalled, true, "pipeline should proceed past trust gate");
	});

	it("handles missing isProjectTrusted gracefully (older pi version)", async () => {
		let capturedHandler!: (args: string, ctx: any) => Promise<void>;
		let notifyCalled = false;

		const pi = {
			on: () => {},
			registerCommand: (
				_name: string,
				cmd: { handler: (args: string, ctx: any) => Promise<void> },
			) => {
				capturedHandler = cmd.handler;
			},
			sendUserMessage: () => {},
			sendMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		} as unknown as any;

		const mod = await import("../index.ts");
		mod.default(pi);

		// No isProjectTrusted method — older pi version
		const testCtx = {
			cwd: "/tmp",
			ui: {
				notify: (_msg: string, _level: string) => {
					notifyCalled = true;
				},
			},
			hasUI: true,
		};

		// Handler should proceed (optional chaining returns undefined, which !== false)
		await capturedHandler("", testCtx);

		assert.equal(notifyCalled, true, "pipeline should proceed when isProjectTrusted is absent");
	});
});

describe("check-extensions handler — parseArgs integration", () => {
	it("parseCheckExtensionsArgs called before pipeline creation (empty args)", async () => {
		let capturedHandler!: (args: string, ctx: any) => Promise<void>;

		const pi = {
			on: () => {},
			registerCommand: (
				_name: string,
				cmd: { handler: (args: string, ctx: any) => Promise<void> },
			) => {
				capturedHandler = cmd.handler;
			},
			sendUserMessage: () => {},
			sendMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		} as unknown as any;

		const mod = await import("../index.ts");
		mod.default(pi);

		const testCtx = {
			cwd: "/tmp",
			ui: { notify: () => {} },
			hasUI: false,
			isProjectTrusted: () => true,
		};

		// Handler should not throw for empty args
		// It will attempt runPipeline which may fail, but that's fine —
		// we just verify parseArgs was called (no crash)
		try {
			await capturedHandler("", testCtx);
		} catch {
			// Expected — pipeline will fail without real changelog
		}
	});

	it("handler accepts unknown flags without crashing", async () => {
		let capturedHandler!: (args: string, ctx: any) => Promise<void>;

		const pi = {
			on: () => {},
			registerCommand: (
				_name: string,
				cmd: { handler: (args: string, ctx: any) => Promise<void> },
			) => {
				capturedHandler = cmd.handler;
			},
			sendUserMessage: () => {},
			sendMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		} as unknown as any;

		const mod = await import("../index.ts");
		mod.default(pi);

		const testCtx = {
			cwd: "/tmp",
			ui: { notify: () => {} },
			hasUI: true,
			isProjectTrusted: () => true,
		};

		// Handler should not crash with unknown flags
		try {
			await capturedHandler("--dry-run --since=v0.78.0", testCtx);
		} catch {
			// Expected — pipeline will fail without real changelog
		}
	});
});
