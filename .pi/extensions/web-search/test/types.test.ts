/**
 * Tests for types.ts — shared types for web-search extension
 *
 * Validates that SearchResult, SearchParams, SearchCacheEntry match expected shapes.
 * Layer: (D) Domain — source scanning, no I/O beyond filesystem reads.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { WebSearchOutputSchema } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");

function readSource(filename: string): string {
	return readFileSync(resolve(extDir, filename), "utf-8");
}

/** Assert no local interface definition (with body) for the given name */
function assertNoLocalInterface(source: string, name: string, fileLabel: string): void {
	assert.ok(
		!new RegExp(`interface\\s+${name}\\s*\\{`).test(source),
		`${fileLabel} should NOT have a local interface ${name}`,
	);
}

// ── WebSearchOutputSchema: ok-discriminated union (output contract) ──

describe("WebSearchOutputSchema — ok-discriminated union", () => {
	const success = {
		ok: true,
		query: "q",
		returned: 1,
		results: [{ title: "T", url: "https://t.example", snippet: "s" }],
	};
	const failure = { ok: false, query: "q", error: "boom" };

	it("(entity) success payload validates", () => {
		assert.ok(Value.Check(WebSearchOutputSchema, success));
	});

	it("(entity) error payload validates", () => {
		assert.ok(Value.Check(WebSearchOutputSchema, failure));
	});

	it("(entity) branches discriminate — each payload rejects the other branch's fields", () => {
		assert.equal(
			Value.Check(WebSearchOutputSchema, { ok: true, query: "q", error: "boom" }),
			false,
		);
		assert.equal(
			Value.Check(WebSearchOutputSchema, { ok: false, query: "q", returned: 1, results: [] }),
			false,
		);
	});

	it("(entity) missing or wrong ok discriminator fails", () => {
		assert.equal(Value.Check(WebSearchOutputSchema, { query: "q", returned: 0, results: [] }), false);
		assert.equal(
			Value.Check(WebSearchOutputSchema, { ok: "true", query: "q", returned: 0, results: [] }),
			false,
		);
		assert.equal(
			Value.Check(WebSearchOutputSchema, { ok: 1, query: "q", returned: 0, results: [] }),
			false,
		);
		assert.equal(
			Value.Check(WebSearchOutputSchema, { ok: null, query: "q", returned: 0, results: [] }),
			false,
		);
	});

	it("(entity) error branch requires a string error", () => {
		assert.equal(Value.Check(WebSearchOutputSchema, { ok: false, query: "q" }), false);
		assert.equal(Value.Check(WebSearchOutputSchema, { ok: false, query: "q", error: 42 }), false);
	});

	it("(entity) success branch requires a results array", () => {
		assert.equal(Value.Check(WebSearchOutputSchema, { ok: true, query: "q", returned: 0 }), false);
		assert.equal(
			Value.Check(WebSearchOutputSchema, { ok: true, query: "q", returned: 0, results: "x" }),
			false,
		);
	});

	it("(entity) boundary: zero results validate", () => {
		assert.ok(Value.Check(WebSearchOutputSchema, { ok: true, query: "q", returned: 0, results: [] }));
	});

	it("(entity) serialized schema round-trips and still validates both branches", () => {
		const roundTripped = JSON.parse(JSON.stringify(WebSearchOutputSchema));
		assert.ok(Value.Check(roundTripped, success));
		assert.ok(Value.Check(roundTripped, failure));
	});
});

// ── Phase 1: types.ts exports shared interfaces ──

describe("types.ts exports — SearchResult, SearchParams, SearchCacheEntry", () => {
	const typesSource = readSource("types.ts");

	it("(D) types.ts exports SearchResult with title, url, snippet fields", () => {
		assert.ok(
			/export\s+interface\s+SearchResult/.test(typesSource),
			"types.ts should export interface SearchResult",
		);
		assert.ok(/^\s*title:\s*string;/m.test(typesSource), "SearchResult should have title: string");
		assert.ok(/^\s*url:\s*string;/m.test(typesSource), "SearchResult should have url: string");
		assert.ok(
			/^\s*snippet:\s*string;/m.test(typesSource),
			"SearchResult should have snippet: string",
		);
	});

	it("(D) types.ts exports SearchParams with query, maxResults, proxy", () => {
		assert.ok(
			/export\s+interface\s+SearchParams/.test(typesSource),
			"types.ts should export interface SearchParams",
		);
		assert.ok(/^\s*query:\s*string;/m.test(typesSource), "SearchParams should have query: string");
		assert.ok(
			/^\s*maxResults\??:\s*number;/m.test(typesSource),
			"SearchParams should have maxResults: number",
		);
		assert.ok(
			/^\s*proxy\??:\s*string;/m.test(typesSource),
			"SearchParams should have proxy: string",
		);
	});

	it("(D) types.ts exports SearchCacheEntry with results and timestamp", () => {
		assert.ok(
			/export\s+interface\s+SearchCacheEntry/.test(typesSource),
			"types.ts should export interface SearchCacheEntry",
		);
		assert.ok(
			/^\s*results:\s*SearchResult\[\];/m.test(typesSource),
			"SearchCacheEntry should have results: SearchResult[]",
		);
		assert.ok(
			/^\s*timestamp:\s*number;/m.test(typesSource),
			"SearchCacheEntry should have timestamp: number",
		);
	});

	it("(D) types.ts re-exports ExecResult from lib/port-types.ts", () => {
		const reexport = /export\s+type\s*\{[^}]*\bExecResult\b[^}]*\}\s*from\s+["']\.\.\/lib\/port-types\.ts["']/;
		assert.ok(
			reexport.test(typesSource),
			"types.ts should re-export ExecResult from lib/port-types.ts",
		);
	});

	it("(D) types.ts re-exports ExecFn from lib/port-types.ts", () => {
		const reexport = /export\s+type\s*\{[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/lib\/port-types\.ts["']/;
		assert.ok(
			reexport.test(typesSource),
			"types.ts should re-export ExecFn from lib/port-types.ts",
		);
	});

	it("(D) types.ts re-exports OnUpdateCallback from lib/port-types.ts", () => {
		const reexport = /export\s+type\s*\{[^}]*\bOnUpdateCallback\b[^}]*\}\s*from\s+["']\.\.\/lib\/port-types\.ts["']/;
		assert.ok(
			reexport.test(typesSource),
			"types.ts should re-export OnUpdateCallback from lib/port-types.ts",
		);
	});
});

// ── Phase 2: production files import shared types ──

describe("python-script.ts — no local types, imports from types.ts", () => {
	const source = readSource("python-script.ts");

	it("(D) python-script.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "python-script.ts");
	});

	it("(D) python-script.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "python-script.ts");
	});

	it("(D) python-script.ts no local interface SearchResult", () => {
		assertNoLocalInterface(source, "SearchResult", "python-script.ts");
	});
});

describe("executor.ts — no local types, imports from types.ts", () => {
	const source = readSource("executor.ts");

	it("(D) executor.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "executor.ts");
	});

	it("(D) executor.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "executor.ts");
	});

	it("(D) executor.ts no local interface SearchResult", () => {
		assertNoLocalInterface(source, "SearchResult", "executor.ts");
	});

	it("(D) executor.ts no local interface SearchParams", () => {
		assertNoLocalInterface(source, "SearchParams", "executor.ts");
	});

	it("(D) executor.ts imports ExecResult and ExecFn from ./types.ts", () => {
		const pattern =
			/import\s+type\s*\{[^}]*\bExecResult\b[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\/(?:types|types\.ts)["']/;
		assert.ok(
			pattern.test(source),
			'executor.ts should import ExecResult and ExecFn from "./types"',
		);
	});
});

describe("index.ts — no local types, imports from types.ts", () => {
	const source = readSource("index.ts");

	it("(D) index.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "index.ts");
	});

	it("(D) index.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "index.ts");
	});

	it("(D) index.ts no local interface SearchResult", () => {
		assertNoLocalInterface(source, "SearchResult", "index.ts");
	});

	it("(D) index.ts no local interface SearchParams", () => {
		assertNoLocalInterface(source, "SearchParams", "index.ts");
	});
});

// ── Phase 3: test files import from types.ts ──

describe("test/types.test.ts — no local types", () => {
	const source = readSource("test/types.test.ts");

	// Self-check: our own test should NOT define the interfaces it tests
	it("(D) test/types.test.ts no local interface SearchResult", () => {
		assertNoLocalInterface(source, "SearchResult", "test/types.test.ts");
	});

	it("(D) test/types.test.ts no local interface SearchParams", () => {
		assertNoLocalInterface(source, "SearchParams", "test/types.test.ts");
	});

	it("(D) test/types.test.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/types.test.ts");
	});
});

describe("test/executor.test.ts — no local types, imports from types.ts", () => {
	const source = readSource("test/executor.test.ts");

	it("(D) test/executor.test.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/executor.test.ts");
	});

	it("(D) test/executor.test.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "test/executor.test.ts");
	});

	it("(D) test/executor.test.ts no local interface SearchResult", () => {
		assertNoLocalInterface(source, "SearchResult", "test/executor.test.ts");
	});

	it("(D) test/executor.test.ts imports ExecResult and ExecFn from ../types.ts", () => {
		const pattern =
			/import\s+type\s*\{[^}]*\bExecResult\b[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/(?:types|types\.ts)["']/;
		assert.ok(
			pattern.test(source),
			'test/executor.test.ts should import ExecResult and ExecFn from "../types"',
		);
	});
});

describe("test/index.test.ts — no local types, imports from types.ts", () => {
	const source = readSource("test/index.test.ts");

	it("(D) test/index.test.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/index.test.ts");
	});

	it("(D) test/index.test.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "test/index.test.ts");
	});

	it("(D) test/index.test.ts no local interface SearchResult", () => {
		assertNoLocalInterface(source, "SearchResult", "test/index.test.ts");
	});
});

// ── Phase 5: output-contract source guards (no schema/type drift) ──

describe("types.ts — output contract source guards", () => {
	const typesSource = readSource("types.ts");

	it("(entity) declares WebSearchOutputSchema via Type.Union with both Literal branches", () => {
		assert.ok(
			/WebSearchOutputSchema\s*=\s*Type\.Union\(\[/.test(typesSource),
			"WebSearchOutputSchema must be declared as Type.Union([",
		);
		assert.ok(/Type\.Literal\(true\)/.test(typesSource), "must declare the ok: true branch");
		assert.ok(/Type\.Literal\(false\)/.test(typesSource), "must declare the ok: false branch");
	});

	it("(entity) declares no hand-written WebSearchErrorPayload", () => {
		assert.ok(
			!/WebSearchErrorPayload/.test(typesSource),
			"WebSearchErrorPayload must be removed — the union covers the error branch",
		);
	});

	it("(entity) WebSearchPayload is derived from the schema via Static<>", () => {
		assert.ok(
			/export\s+type\s+WebSearchPayload\s*=\s*Static<typeof\s+WebSearchOutputSchema>/.test(
				typesSource,
			),
			"WebSearchPayload must be Static<typeof WebSearchOutputSchema>",
		);
	});
});

describe("README.md — output-contract docs guard", () => {
	const readme = readSource("README.md");

	it("(docs) structured output bullet states the ok discriminator", () => {
		assert.ok(/structuredContent: \{ ok: true/.test(readme), "success payload must show ok: true");
	});

	it("(docs) error signaling states the ok: false payload", () => {
		assert.ok(/\(ok: false, query, error\)|\{ ok: false, query, error \}/.test(readme));
		assert.ok(!/\{ error, query \}/.test(readme), "stale non-discriminated error payload removed");
	});
});
