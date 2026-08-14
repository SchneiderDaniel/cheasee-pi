/**
 * Adapter tests: output.ts facade (clean-code split #1535).
 *
 * Pins the facade contract:
 *   - all 8 public symbols still resolve from ../agent/output.ts
 *   - leaf internals are NOT re-exported through the facade
 *   - dependency direction is one-way (leaves never import output.ts)
 *   - S104 file-size criterion: facade and leaves under 500 non-blank lines
 *   - decomposition ordering: parse-first, then markers, same as pre-split
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as outputModule from "../agent/output.ts";
import { extractStructuredAuditOutput } from "../agent/output.ts";
import type { StructuredAuditOutput } from "../agent/output.ts";

function readSource(relativePath: string): string {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", relativePath);
	return readFileSync(path, "utf8");
}

function nonBlankLines(source: string): number {
	return source.split("\n").filter((l) => l.trim().length > 0).length;
}

describe("output.ts facade — public surface", () => {
	const publicSymbols = [
		"stripAnsi",
		"normalizeEscapes",
		"parseAgentOutput",
		"isSuccess",
		"extractAgentCommentBody",
		"extractStructuredAuditOutput",
		"stripTrailingMetadata",
	];

	it("exposes all 8 public symbols (7 runtime + StructuredAuditOutput type)", () => {
		for (const name of publicSymbols) {
			assert.equal(
				typeof (outputModule as Record<string, unknown>)[name],
				"function",
				`${name} must be exported from output.ts`,
			);
		}
		// StructuredAuditOutput is type-only — pin it with the typed import above
		const typed: StructuredAuditOutput = { decision: "APPROVED" };
		assert.equal(typed.decision, "APPROVED");
	});

	it("does NOT re-export leaf internals (documented boundary)", () => {
		for (const name of [
			"extractLastJson",
			"validateAgentOutput",
			"sanitizeJsonStrings",
			"extractStructuredAuditMarkers",
		]) {
			assert.equal(name in outputModule, false, `${name} must stay leaf-internal`);
		}
	});
});

describe("output.ts facade — module boundaries", () => {
	const leaves = ["agent/last-json-scanner.ts", "agent/validation.ts", "agent/structured-audit.ts"];

	it("leaf modules never import from output.ts (no ESM cycle)", () => {
		for (const leaf of leaves) {
			const source = readSource(leaf);
			assert.equal(
				source.includes('from "./output.ts"') || source.includes('from "../agent/output.ts"'),
				false,
				`${leaf} must not import from output.ts`,
			);
		}
	});

	it("leaf modules import only from config/types, lib/tool-line (shared leaves)", () => {
		for (const leaf of leaves) {
			const source = readSource(leaf);
			for (const line of source.split("\n")) {
				const match = line.match(/^import[^\n]*from "([^"]+)"/);
				if (match) {
					assert.ok(
						match[1].startsWith("../config/") || match[1].startsWith("../lib/"),
						`${leaf} imports ${match[1]} — must be ../config/* or ../lib/*`,
					);
				}
			}
		}
	});
});

describe("output.ts facade — S104 file-size criterion", () => {
	it("output.ts and every new leaf stay under 500 non-blank lines", () => {
		const files = [
			"agent/output.ts",
			"agent/last-json-scanner.ts",
			"agent/validation.ts",
			"agent/structured-audit.ts",
		];
		for (const file of files) {
			const lines = nonBlankLines(readSource(file));
			assert.ok(lines < 500, `${file} has ${lines} non-blank lines — must be < 500`);
		}
	});
});

describe("extractStructuredAuditOutput — decomposition ordering", () => {
	it("parse-first wins: JSON action APPROVED beats conflicting AUDIT_DECISION: REJECTED text", () => {
		const output = [
			'{"action":"APPROVED","agentName":"auditor","commentBody":"from JSON"}',
			"AUDIT_DECISION: REJECTED",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.deepEqual(result, { decision: "APPROVED", commentBody: "from JSON" });
	});

	it("markers win when JSON parses with non-audit action", () => {
		const output = [
			'{"action":"COMPLETE","agentName":"architect","commentBody":"not an audit"}',
			"AUDIT_DECISION: APPROVED",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.deepEqual(result, { decision: "APPROVED" });
	});

	it("returns null when neither JSON action nor markers apply", () => {
		const output = "just some random prose without any markers";
		assert.equal(extractStructuredAuditOutput(output), null);
	});
});
