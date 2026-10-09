/**
 * Migration guard for issue #1977: the CodeFlow capability lives entirely in
 * the `audit-codeflow-analysis` skill — the `.pi/extensions/codeflow-analysis/`
 * extension is gone.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-analysis-migration.test.mts
 */

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { discoverTestFiles } from "./lib/test-discovery.mts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIR = ".pi/skills/audit-codeflow-analysis";

describe("codeflow-analysis extension folded into the skill", () => {
	it("the extension directory is gone", () => {
		assert.ok(
			!existsSync(resolve(ROOT, ".pi/extensions/codeflow-analysis")),
			"extension directory must be deleted",
		);
	});

	it("the parser, fetch use-case and fetch script live under the skill", () => {
		for (const rel of [
			`${SKILL_DIR}/lib/report.ts`,
			`${SKILL_DIR}/lib/fetch-report.ts`,
			`${SKILL_DIR}/scripts/fetch-report.mts`,
		]) {
			assert.ok(existsSync(resolve(ROOT, rel)), `${rel} must exist`);
		}
	});

	it("registers the moved tests and drops the old extension paths", () => {
		const files = discoverTestFiles();
		for (const rel of [
			`${SKILL_DIR}/test/report.test.mts`,
			`${SKILL_DIR}/test/codeflow-analysis.test.mts`,
			`${SKILL_DIR}/test/fetch-report-cli.test.mts`,
			`${SKILL_DIR}/test/bridge.test.mts`,
		]) {
			assert.ok(files.includes(rel), `npm test globs must register ${rel}`);
		}
		assert.ok(
			!files.some((f) => f.startsWith(".pi/extensions/codeflow-analysis/")),
			"old extension test paths must not be registered",
		);
	});

	it("tsconfig type-checks the skill tree and excludes its fixtures", () => {
		const tsconfig = JSON.parse(readFileSync(resolve(ROOT, ".pi/tsconfig.json"), "utf-8"));
		assert.ok(tsconfig.include.includes("skills/**/*.ts"), "include must cover skills/**/*.ts");
		assert.ok(tsconfig.include.includes("skills/**/*.mts"), "include must cover skills/**/*.mts");
		assert.ok(
			tsconfig.exclude.includes("skills/**/fixtures/**"),
			"exclude must drop skills fixtures",
		);
	});
});
