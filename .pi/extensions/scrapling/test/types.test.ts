/**
 * Tests for types.ts — shared ExecResult/ExecFn extraction
 *
 * Validates that ExecResult and ExecFn are defined once in types.ts
 * and imported by all consumers (no local interface copies).
 *
 * Layer: (D) Domain — source scanning, no I/O beyond filesystem reads.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");

/** Match import from ./types or ./types.ts */
function hasImportFromTypes(source: string, symbols: string[]): boolean {
	// Pattern 1: import type { ..., ExecResult, ..., ExecFn, ... } from "./types(.ts)"
	const typePattern = new RegExp(
		`import\\s+type\\s*\\{[^}]*\\b${symbols[0]}\\b[^}]*\\b${symbols[1]}\\b[^}]*\\}\\s*from\\s+["']\\.\\/types(?:\\.ts)?["']`,
	);
	if (typePattern.test(source)) return true;

	// Pattern 2: import { ..., type ExecResult, ..., type ExecFn, ... } from "./types(.ts)"
	const mixedPattern = new RegExp(
		`import\\s+\\{[^}]*\\btype\\s+${symbols[0]}\\b[^}]*\\btype\\s+${symbols[1]}\\b[^}]*\\}\\s*from\\s+["']\\.\\/types(?:\\.ts)?["']`,
	);
	if (mixedPattern.test(source)) return true;

	// Pattern 3: import type { ExecResult, ExecFn } from "../types(.ts)" (for test files)
	const testPattern = new RegExp(
		`import\\s+type\\s*\\{[^}]*\\b${symbols[0]}\\b[^}]*\\b${symbols[1]}\\b[^}]*\\}\\s*from\\s+["']\\.\\.\\/types(?:\\.ts)?["']`,
	);
	return testPattern.test(source);
}

/** Assert no interface definition (with body) for the given name */
function assertNoLocalInterface(source: string, name: string, fileLabel: string): void {
	assert.ok(
		!new RegExp(`interface\\s+${name}\\s*\\{`).test(source),
		`${fileLabel} should NOT have a local interface ${name}`,
	);
}

/** Assert no full type definition (type X = ... with function signature) for the given name.
 *  Thin type aliases (type Foo = Bar) are allowed — only full definitions are flagged. */
function assertNoLocalFullType(source: string, name: string, fileLabel: string): void {
	// Full type definition: type Foo = (args) => RetType;  (function signature type)
	const signaturePattern = new RegExp(`type\\s+${name}\\s*=\\s*\\(`);
	assert.ok(
		!signaturePattern.test(source),
		`${fileLabel} should NOT have a local full type definition for ${name}`,
	);
}

// ── Phase 1: types.ts exports shared interfaces ──

describe("types.ts exports — shared ExecResult/ExecFn", () => {
	const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");

	it("(D) types.ts exports ExecResult with code, stdout, stderr fields", () => {
		assert.ok(
			/export\s+interface\s+ExecResult/.test(typesSource),
			"types.ts should export interface ExecResult",
		);
		assert.ok(/^\s*code:\s*number;/m.test(typesSource), "ExecResult should have code: number");
		assert.ok(/^\s*stdout:\s*string;/m.test(typesSource), "ExecResult should have stdout: string");
		assert.ok(/^\s*stderr:\s*string;/m.test(typesSource), "ExecResult should have stderr: string");
	});

	it("(D) types.ts exports ExecFn with correct signature", () => {
		assert.ok(
			/export\s+interface\s+ExecFn/.test(typesSource),
			"types.ts should export interface ExecFn",
		);
		assert.ok(
			typesSource.includes("Promise<ExecResult>"),
			"ExecFn should return Promise<ExecResult>",
		);
	});

	it("(D) CrawlParams and OnUpdateCallback remain exported", () => {
		assert.ok(
			/export\s+interface\s+CrawlParams/.test(typesSource),
			"CrawlParams should remain exported",
		);
		assert.ok(
			/export\s+interface\s+OnUpdateCallback/.test(typesSource),
			"OnUpdateCallback should remain exported",
		);
	});
});

// ── Helper: read a source file ──

function readSource(filename: string): string {
	return readFileSync(resolve(extDir, filename), "utf-8");
}

// ── Phase 2: production files remove local copies, import shared ──

describe("venv-setup.ts — no local ExecFn, imports from types.ts", () => {
	const source = readSource("venv-setup.ts");

	it("(D) venv-setup.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "venv-setup.ts");
	});

	it("(D) venv-setup.ts imports ExecFn from ./types.ts", () => {
		const pattern =
			/import\s+type\s*\{[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\/types(?:\.[a-z]+)?["']/;
		assert.ok(pattern.test(source), 'venv-setup.ts should import ExecFn from "./types"');
	});
});

// ── Phase 3: scrapling-script.test.ts — verify SCRAPLING_SCRIPT imports from python-script.ts ──

describe("test/scrapling-script.test.ts — imports SCRAPLING_SCRIPT from ../python-script.ts", () => {
	const source = readSource("test/scrapling-script.test.ts");

	it("(D) imports SCRAPLING_SCRIPT from ../python-script.ts", () => {
		const pattern =
			/import\s+\{[^}]*\bSCRAPLING_SCRIPT\b[^}]*\}\s*from\s+["']\.\.\/python-script(?:\.[a-z]+)?["']/;
		assert.ok(
			pattern.test(source),
			'test/scrapling-script.test.ts should import SCRAPLING_SCRIPT from "../python-script"',
		);
	});
});

// ── Phase 4: venv-setup-scrapling.test.ts — imports ensureScraplingVenv and VENV_DIR ──

describe("test/venv-setup-scrapling.test.ts — imports from ../venv-setup.ts", () => {
	const source = readSource("test/venv-setup-scrapling.test.ts");

	it("(D) imports ensureScraplingVenv from ../venv-setup.ts", () => {
		const pattern =
			/import\s+\{[^}]*\bensureScraplingVenv\b[^}]*\}\s*from\s+["']\.\.\/venv-setup(?:\.[a-z]+)?["']/;
		assert.ok(
			pattern.test(source),
			'test/venv-setup-scrapling.test.ts should import ensureScraplingVenv from "../venv-setup"',
		);
	});

	it("(D) imports VENV_DIR from ../venv-setup.ts", () => {
		const pattern =
			/import\s+\{[^}]*\bVENV_DIR\b[^}]*\}\s*from\s+["']\.\.\/venv-setup(?:\.[a-z]+)?["']/;
		assert.ok(
			pattern.test(source),
			'test/venv-setup-scrapling.test.ts should import VENV_DIR from "../venv-setup"',
		);
	});
});

// ── Phase 5: index.test.ts — verify tool import (no local ExecResult/ExecFn needed since test is self-contained) ──

describe("test/index.test.ts — no local ExecResult/ExecFn definitions", () => {
	const source = readSource("test/index.test.ts");

	it("(D) test/index.test.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/index.test.ts");
	});

	it("(D) test/index.test.ts no local full ExecFn type definition", () => {
		assertNoLocalFullType(source, "ExecFn", "test/index.test.ts");
	});
});

// ── Phase 6: types.ts — new CrawlResult/CrawledPage types ──

describe("types.ts — CrawlResult and CrawledPage types", () => {
	const source = readSource("types.ts");

	it("(D) types.ts exports CrawledPage interface", () => {
		assert.ok(
			/export\s+interface\s+CrawledPage/.test(source),
			"types.ts should export CrawledPage interface",
		);
	});

	it("(D) CrawledPage has url: string", () => {
		assert.ok(/^\s*url:\s*string;/m.test(source), "CrawledPage should have url: string");
	});

	it("(D) CrawledPage has markdown: string", () => {
		assert.ok(/^\s*markdown:\s*string;/m.test(source), "CrawledPage should have markdown: string");
	});

	it("(D) CrawledPage has method discriminator (lightweight | stealth)", () => {
		assert.ok(/method/.test(source), "CrawledPage should have method field");
	});

	it("(D) CrawledPage has rawLength: number", () => {
		assert.ok(/rawLength/.test(source), "CrawledPage should have rawLength");
	});

	it("(D) types.ts exports CrawlResult type", () => {
		assert.ok(
			/export\s+type\s+CrawlResult/.test(source),
			"types.ts should export CrawlResult type",
		);
	});

	it("(D) CrawlResult is a discriminated union with success field", () => {
		assert.ok(/\bsuccess\b/.test(source), "CrawlResult should have a success discriminator");
	});

	it("(D) CrawlResult has error branch with error: string", () => {
		assert.ok(/error:\s*string/.test(source), "CrawlResult error branch should have error: string");
	});

	it("(D) CrawlResult has success branch with results: CrawledPage[]", () => {
		assert.ok(
			/CrawledPage\[\]/.test(source),
			"CrawlResult success branch should have CrawledPage[]",
		);
	});

	it("(D) CrawlParams extended with maxTokens field", () => {
		assert.ok(/maxTokens/.test(source), "CrawlParams should have maxTokens field");
	});
});

describe("python-adapter.ts — CrawlFn type export", () => {
	const source = readSource("python-adapter.ts");

	it("(D) python-adapter.ts exports PythonAdapter class", () => {
		assert.ok(
			/export\s+class\s+PythonAdapter/.test(source),
			"python-adapter.ts should export PythonAdapter class",
		);
	});

	it("(D) python-adapter.ts exports type CrawlFn", () => {
		assert.ok(
			/export\s+type\s+CrawlFn/.test(source),
			"python-adapter.ts should export type CrawlFn",
		);
	});

	it("(D) CrawlFn signature: (params: CrawlParams & { signal?: AbortSignal }) => Promise<CrawlResult>", () => {
		const pattern = /CrawlFn\s*=\s*\(/;
		assert.ok(pattern.test(source), "CrawlFn should be a function type");
		assert.ok(
			/CrawlParams\s*&/.test(source),
			"CrawlFn should accept CrawlParams & { signal?: AbortSignal }",
		);
		assert.ok(/Promise<CrawlResult>/.test(source), "CrawlFn should return Promise<CrawlResult>");
	});

	it("(D) PythonAdapter no longer implements CrawlerEngine", () => {
		assert.ok(
			!/implements\s+CrawlerEngine/.test(source),
			"PythonAdapter should NOT implement CrawlerEngine",
		);
	});

	it("(D) PythonAdapter imports from python-script.ts", () => {
		assert.ok(
			source.includes("python-script"),
			"PythonAdapter should import from python-script.ts",
		);
	});

	it("(D) PythonAdapter imports ensureScraplingVenv from venv-setup.ts", () => {
		assert.ok(source.includes("venv-setup"), "PythonAdapter should import from venv-setup.ts");
	});
});

// ── Phase 7: Deleted files verification ──

describe("crawler-engine.ts — deleted", () => {
	it("(D) crawler-engine.ts no longer exists", () => {
		assert.throws(
			() => readSource("crawler-engine.ts"),
			/ENOENT/,
			"crawler-engine.ts should be deleted",
		);
	});
});

describe("mock-adapter.ts — deleted", () => {
	it("(D) mock-adapter.ts no longer exists", () => {
		assert.throws(
			() => readSource("mock-adapter.ts"),
			/ENOENT/,
			"mock-adapter.ts should be deleted",
		);
	});
});
