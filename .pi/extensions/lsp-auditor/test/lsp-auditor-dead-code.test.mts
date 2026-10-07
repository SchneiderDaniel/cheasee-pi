/**
 * Tests verifying dead code removal for lsp-auditor (#1879)
 *
 * `formatting.ts` imported `AuditResult` from `./types.ts` but only ever
 * referenced `LspDiagnostic`. The unused type specifier is removed.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/lsp-auditor-dead-code.test.mts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const dir = import.meta.dirname;
const formattingSrc = readFileSync(resolve(dir, "..", "formatting.ts"), "utf8");
const typesSrc = readFileSync(resolve(dir, "..", "types.ts"), "utf8");

const typesImportLine = formattingSrc
	.split("\n")
	.find((l) => /import\s+type\s*\{[^}]*\}\s*from\s*["']\.\/types\.ts["']/.test(l));

describe("AuditResult dead-code removal (#1879)", () => {
	it("formatting.ts no longer imports AuditResult from ./types.ts", () => {
		assert.ok(typesImportLine, "expected a type import from ./types.ts in formatting.ts");
		assert.ok(
			!typesImportLine.includes("AuditResult"),
			`AuditResult must be removed from the import; got: ${typesImportLine}`,
		);
	});

	it("formatting.ts still imports LspDiagnostic (surgical removal)", () => {
		assert.ok(typesImportLine?.includes("LspDiagnostic"), "LspDiagnostic must survive the edit");
	});

	it("types.ts still exports AuditResult (no collateral damage)", () => {
		assert.match(typesSrc, /export\s+interface\s+AuditResult\b/);
	});

	it("formatting.ts runtime exports remain intact", async () => {
		const mod = await import("../formatting.ts");
		for (const fn of [
			"formatDiagnostics",
			"filterBySeverity",
			"severityValue",
			"thresholdValue",
			"truncateMessage",
		] as const) {
			assert.strictEqual(typeof mod[fn], "function", `${fn} should still be exported`);
		}
	});
});
