/**
 * Issue #1878 — dead-code guard: unused `existsSync` import removed from
 * prettier-adapter.mts.
 *
 * Phase 1: static absence + compiler oracle (TS6133 scoped to `existsSync`).
 * Phase 2: adapter dependency surface preserved (over-deletion guard).
 * Phase 3: adapter runtime contract unchanged (regression guard).
 * Phase 4: live `existsSync` at the index.ts boundary untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = resolve(TEST_DIR, "../prettier-adapter.mts");
const INDEX_PATH = resolve(TEST_DIR, "../index.ts");
const REPO_ROOT = resolve(TEST_DIR, "../../../..");

const adapterSource = readFileSync(ADAPTER_PATH, "utf-8");
const indexSource = readFileSync(INDEX_PATH, "utf-8");

// `--listFiles` also emits the compiled program's file list, which lets the
// oracle prove the adapter was actually analysed instead of passing vacuously.
const TSC_CMD =
	"npx tsc --noEmit --noUnusedLocals --listFiles --project .pi/tsconfig.json";

/**
 * Run the strict compiler and return its combined output.
 *
 * A diagnostics-bearing run exits 1/2 (pre-existing TS6133s in this repo make a
 * clean 0 unreachable). Any other exit — spawn ENOENT, signal kill, crash — or a
 * nonzero exit without a real `error TS` line means the compiler never verified
 * the program; fail loudly rather than let the symbol assertion pass vacuously.
 */
function runStrictTsc(): string {
	try {
		return execSync(TSC_CMD, {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const e = err as { status?: number | null; stdout?: string; stderr?: string };
		const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
		assert.ok(
			e.status === 1 || e.status === 2,
			`tsc did not run to diagnostics (status=${String(e.status)}):\n${output}`,
		);
		assert.ok(
			/error TS\d+/.test(output),
			`tsc exited ${String(e.status)} with no TS diagnostic — abnormal exit, cannot verify:\n${output}`,
		);
		return output;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1 — dead import removed (static absence + compiler oracle)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1 — dead existsSync import removed", () => {
	it("adapter source contains no existsSync token anywhere", () => {
		assert.ok(
			!/\bexistsSync\b/.test(adapterSource),
			`existsSync must not appear in ${ADAPTER_PATH}`,
		);
	});

	it("adapter imports nothing from non-promises node:fs", () => {
		assert.ok(
			!/from\s+"node:fs"/.test(adapterSource),
			'adapter must not import from bare "node:fs"',
		);
		assert.ok(
			/from\s+"node:fs\/promises"/.test(adapterSource),
			'adapter must import from "node:fs/promises"',
		);
	});

	it("tsc --noUnusedLocals reports no TS6133 for existsSync in prettier-adapter.mts", () => {
		const output = runStrictTsc();

		// Proof the compiler included the target file in its program (via
		// --listFiles). Without this the symbol assertion could pass even though
		// the adapter was never compiled.
		assert.ok(
			output.includes("format-on-save/prettier-adapter.mts"),
			`compiler file list does not include prettier-adapter.mts — oracle inconclusive:\n${output}`,
		);

		const adapterErrors = output
			.split("\n")
			.filter((line) => line.includes("prettier-adapter.mts") && line.includes("error TS"))
			.join("\n");
		assert.ok(
			!adapterErrors.includes("'existsSync' is declared but its value is never read"),
			`unexpected TS6133 for existsSync:\n${adapterErrors}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2 — adapter dependency surface preserved (over-deletion guard)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2 — adapter dependency surface preserved", () => {
	it("still imports readFile and writeFile from node:fs/promises", () => {
		const line = adapterSource
			.split("\n")
			.find((l) => l.includes('from "node:fs/promises"'));
		assert.ok(line, "node:fs/promises import line missing");
		assert.ok(line!.includes("readFile"), "readFile specifier missing");
		assert.ok(line!.includes("writeFile"), "writeFile specifier missing");
	});

	it("still imports resolve from node:path", () => {
		assert.ok(/\bresolve\b[^\n]*from\s+"node:path"/.test(adapterSource));
	});

	it("dynamic import resolves and PrettierFormatter is constructable", async () => {
		const mod = await import("../prettier-adapter.mts");
		assert.strictEqual(typeof mod.PrettierFormatter, "function");
		assert.doesNotThrow(() => new mod.PrettierFormatter("/tmp"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3 — adapter runtime contract unchanged (regression guard)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3 — PrettierFormatter runtime contract", () => {
	it("format() happy path returns formatted=true and writes via injected FileSystem", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const writes: string[] = [];
		const mockPrettier = {
			format: async () => "const x = 1;\n",
			resolveConfig: async () => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => "const x = 1\n",
			writeFile: async (_p: string, content: string) => {
				writes.push(content);
			},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as never, mockFs as never);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, true);
		assert.deepStrictEqual(writes, ["const x = 1;\n"]);
	});

	it("format() no-op path returns formatted=false with no error", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const source = "const x = 1;\n";
		const mockPrettier = {
			format: async () => source,
			resolveConfig: async () => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => source,
			writeFile: async () => {},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as never, mockFs as never);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.strictEqual(result.error, undefined);
	});

	it("format() surfaces ENOENT from injected readFile", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const mockPrettier = {
			format: async () => "",
			resolveConfig: async () => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => {
				throw new Error("ENOENT: file not found");
			},
			writeFile: async () => {},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as never, mockFs as never);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.ok(result.error?.includes("ENOENT"));
	});

	it("resolveConfig receives the root-only .prettierrc path", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		let configPath = "";
		const mockPrettier = {
			format: async () => "",
			resolveConfig: async (_p: string, opts: Record<string, unknown>) => {
				configPath = opts.config as string;
				return null;
			},
		};
		const mockFs = {
			readFile: async () => "const x = 1\n",
			writeFile: async () => {},
		};
		const f = new PrettierFormatter(
			"/my/project",
			mockPrettier as never,
			mockFs as never,
		);
		await f.format("/my/project/src/file.ts");
		assert.strictEqual(configPath, "/my/project/.prettierrc");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4 — live existsSync at the index.ts boundary untouched
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4 — index.ts existsSync boundary untouched", () => {
	it("index.ts still imports existsSync from node:fs", () => {
		assert.ok(
			/import\s*\{[^}]*\bexistsSync\b[^}]*\}\s*from\s*"node:fs"/.test(indexSource),
			"index.ts must still import existsSync from node:fs",
		);
	});

	it("index.ts still calls existsSync in its existence guard", () => {
		assert.ok(/\bexistsSync\(/.test(indexSource), "index.ts must still call existsSync");
	});
});
