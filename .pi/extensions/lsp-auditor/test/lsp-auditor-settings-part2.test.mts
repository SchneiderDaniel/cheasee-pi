/** Regression coverage for settings diagnostics added after the original suite. */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServerMappings } from "../server-mappings.ts";
import { readSettings } from "../settings.ts";

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

describe("readSettings → buildServerMappings — malformed-entry warnings", () => {
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
				assert.ok(
					warnMessages.some((m) => m.includes("123") && m.includes("[lsp-auditor]")),
					"console.warn should mention the malformed entry",
				);
				assert.ok(
					warnMessages.some((m) => m.includes("Dropped malformed server entry")),
					"console.warn should say 'Dropped malformed server entry'",
				);
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
			{ lspAuditor: { servers: [{ extensions: [".ts"], command: "ts-ls", args: "--stdio" }] } },
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

	it("settings with a leading '-' command drops that entry, keeps valid siblings", () => {
		warnMessages = [];
		console.warn = (...args: unknown[]) => {
			warnMessages.push(args.join(" "));
		};

		withTempSettings(
			{
				lspAuditor: {
					servers: [
						{ extensions: [".ts"], command: "-a" },
						{ extensions: [".py"], command: "pyright-langserver", args: ["--stdio"] },
					],
				},
			},
			(worktree) => {
				const settings = readSettings(worktree);
				assert.ok(settings, "settings should not be null");
				assert.ok(
					warnMessages.some((m) => m.includes("Dropped malformed server entry")),
					"the malformed entry must be dropped with a warning",
				);
				const mappings = buildServerMappings(settings!.lspAuditor);
				assert.ok(!mappings.some((m) => m.command === "-a"));
				assert.ok(mappings.some((m) => m.command === "pyright-langserver"));
			},
		);

		console.warn = originalWarn;
	});
});
