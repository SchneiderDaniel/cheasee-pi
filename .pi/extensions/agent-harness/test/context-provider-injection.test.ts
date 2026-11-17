/**
 * Issue #2093 — Context Provider: construction-time injection of the tool-info
 * port.
 *
 * Verifies the removed surface stays removed (`setToolInfoProvider`,
 * `ToolMetaLookup.resetWarning`), that the harness applies the port without an
 * injection step, that the `hasUI` cast is gone, and that the docs describe
 * construction-time injection rather than a `session_start` setter.
 *
 * The scans below read source text (same precedent as
 * `test/dead-code-removal.test.ts`). This file is excluded from its own scans
 * because it necessarily names the removed symbols.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/agent-harness/test/context-provider-injection.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { AgentHarness } from "../index.ts";

const EXT_ROOT = resolve(import.meta.dirname, "..");
const SELF = resolve(import.meta.dirname, "context-provider-injection.test.ts");
const HARNESS_SOURCE = resolve(EXT_ROOT, "agent-harness.ts");
const DISPATCH_TEST = resolve(EXT_ROOT, "test", "index-dispatch.test.ts");
const README = resolve(EXT_ROOT, "README.md");
const EXT_DOC = resolve(EXT_ROOT, "..", "..", "..", "docs", "extensions", "agent-harness.md");

/**
 * Every non-test `.ts`/`.mts` source under the extension.
 *
 * Test files are excluded by design: they must name the removed symbols in
 * order to assert their absence (`tool-meta.test.ts`, this file).
 */
function collectSources(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			collectSources(full, acc);
			continue;
		}
		if (full === SELF) continue;
		if (!/\.(ts|mts)$/.test(entry)) continue;
		if (/\.test\.(ts|mts)$/.test(entry)) continue;
		acc.push(full);
	}
	return acc;
}

function read(path: string): string {
	return readFileSync(path, "utf-8");
}

// ── Removed surface ────────────────────────────────────────────

describe("Issue #2093 — setToolInfoProvider removed", () => {
	it("is absent from the instance and the prototype", () => {
		const harness = new AgentHarness();
		assert.equal("setToolInfoProvider" in harness, false, "no setter on the instance");
		assert.equal(
			(AgentHarness.prototype as unknown as Record<string, unknown>).setToolInfoProvider,
			undefined,
			"no setter on the prototype",
		);
	});

	it("surviving surface is intact: handleToolCall, handleTurnStart, setRules, reset", () => {
		const harness = new AgentHarness();
		for (const method of ["handleToolCall", "handleTurnStart", "setRules", "reset"]) {
			assert.equal(typeof (harness as unknown as Record<string, unknown>)[method], "function");
		}
	});
});

// ── Source scans ───────────────────────────────────────────────

describe("Issue #2093 — removed symbols absent from extension sources", () => {
	it("no source file mentions setToolInfoProvider", () => {
		const offenders = collectSources(EXT_ROOT).filter((f) =>
			read(f).includes("setToolInfoProvider"),
		);
		assert.deepEqual(offenders, [], "setToolInfoProvider must be fully removed");
	});

	it("no source file mentions resetWarning", () => {
		const offenders = collectSources(EXT_ROOT).filter((f) => read(f).includes("resetWarning"));
		assert.deepEqual(offenders, [], "resetWarning must be fully removed");
	});

	it("handleToolCall takes a typed ctx — no `as any` cast, no `_ctx` parameter", () => {
		const source = read(HARNESS_SOURCE);
		const start = source.indexOf("handleToolCall(event: ToolCallEvent");
		assert.ok(start > -1, "handleToolCall(event, ctx) must exist");
		const end = source.indexOf("\n\t}", start);
		assert.ok(end > start, "method body boundary found");
		const body = source.slice(start, end);
		assert.ok(!body.includes("as any"), "no `as any` cast in handleToolCall");
		assert.ok(!body.includes("_ctx"), "parameter is named ctx, not _ctx");
		assert.ok(body.includes("ctx.hasUI"), "hasUI is read through the port type");
	});

	it("agent-harness.ts header documents the real public surface", () => {
		const source = read(HARNESS_SOURCE);
		const header = source.slice(0, source.indexOf("export class AgentHarness"));
		assert.ok(!header.includes("setToolInfoProvider"), "header must not cite the removed setter");
		assert.ok(header.includes("setRules"), "header mentions setRules");
		assert.ok(header.includes("handleTurnStart"), "header mentions handleTurnStart");
		assert.ok(/constructor/i.test(header), "header describes constructor-injected port");
	});
});

// ── Test migration ─────────────────────────────────────────────

describe("Issue #2093 — index-dispatch.test.ts migrated to constructor injection", () => {
	const source = read(DISPATCH_TEST);

	it("contains zero setToolInfoProvider occurrences", () => {
		assert.equal(source.match(/setToolInfoProvider/g), null);
	});

	it("keeps the annotation-derived test titles (28+ cases)", () => {
		const titles = [
			"read-only annotated tool is not error-tracked",
			"explicit config trackErrors:true overrides the read-only annotation",
			"destructive annotated tool escalates (tightens) the cascade threshold",
			"provider is consulted lazily on tool_call, not eagerly",
			"provider throw → fail-open, one warning, call passes",
			"nested errors under a read-only parent are not tracked (no error block)",
		];
		for (const title of titles) {
			assert.ok(source.includes(title), `missing migrated case: ${title}`);
		}
		const count = (source.match(/\n\tit\(/g) ?? []).length;
		assert.ok(count >= 28, `expected at least 28 cases, found ${count}`);
	});
});

// ── Docs ──────────────────────────────────────────────────────

describe("Issue #2093 — docs describe construction-time injection", () => {
	it("README no longer claims the port is injected on session_start", () => {
		const readme = read(README);
		assert.ok(
			!readme.includes("On `session_start` the harness injects"),
			"stale session_start injection claim removed",
		);
		assert.ok(
			readme.includes("construction"),
			"README states the port is provided at construction",
		);
		assert.match(
			readme,
			/reset\(\)[^.]{0,80}provider/,
			"README states reset() keeps the port (clears state only)",
		);
	});

	it("docs/extensions/agent-harness.md carries no session_start injection claim", () => {
		const doc = read(EXT_DOC);
		assert.ok(!doc.includes("On `session_start` the harness injects"));
		assert.ok(
			/construction|constructor/i.test(doc),
			"reference doc describes construction-time wiring",
		);
	});
});
