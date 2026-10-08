/**
 * Tests for the audit-codeflow-analysis skill contract.
 *
 * Text-analysis tests that read SKILL.md and assert the required contract:
 * tool/report references, the ask_user confirmation gate before any
 * `gh issue create`, issues-only scope with a locked main, create-internal-issue
 * delegation, best-effort isolation disclosure, and package.json wiring.
 *
 * Run with:
 *   node --experimental-strip-types --test test/audit-codeflow-analysis-skill.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isRegistered } from "./lib/test-discovery.mts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = resolve(ROOT, ".pi/skills/audit-codeflow-analysis/SKILL.md");

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: content };
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		if (/^\s/.test(line)) continue; // nested metadata
		const idx = line.indexOf(":");
		if (idx !== -1) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

const skill = readFileSync(SKILL_PATH, "utf-8");
const { frontmatter, body } = parseFrontmatter(skill);

describe("audit-codeflow-analysis SKILL.md", () => {
	it("exists", () => {
		assert.ok(existsSync(SKILL_PATH), "SKILL.md must exist");
	});

	it("has name: audit-codeflow-analysis and a non-empty description", () => {
		assert.strictEqual(frontmatter.name, "audit-codeflow-analysis");
		assert.ok(
			(frontmatter.description ?? "").replace(/"/g, "").trim().length > 0,
			"description must be non-empty",
		);
	});

	it("references the report artifact and the fetch tool", () => {
		assert.match(body, /ignore\/codeflow-report\.md/);
		assert.match(body, /ignore\/codeflow-report\.json/);
		assert.match(body, /codeflow_analysis_report/);
	});

	it("documents the JSON-only categories and their markdown fallback", () => {
		assert.match(body, /duplicates/i);
		assert.match(body, /layer violation/i);
		assert.match(body, /suggestions?/i);
		assert.match(body, /parseReportJson|structured JSON/i);
	});

	it("mandates ask_user before any issue creation", () => {
		const askIdx = body.search(/ask_user/);
		assert.ok(askIdx !== -1, "must use ask_user");
		assert.match(body, /\ball\b[\s\S]*\bsome\b[\s\S]*\bcancel\b/i, "must offer all/some/cancel");
		assert.match(body, /gh issue create/, "must name the gated command");
		assert.match(body, /before/i, "must state the gate ordering");
	});

	it("states issues only, main locked, and delegates filing to create-internal-issue", () => {
		assert.match(body, /issues only/i);
		assert.match(body, /main.*locked|locked.*main/i);
		assert.match(body, /create-internal-issue/);
	});

	it("requires best-effort file isolation and overlap disclosure", () => {
		assert.match(body, /best-effort/i);
		assert.match(body, /overlap/i);
		assert.match(body, /disclos/i, "must require disclosing overlap in the issue body");
	});
});

describe("package.json test wiring", () => {
	it("npm test globs register the new codeflow test files", () => {
		for (const file of [
			".pi/extensions/lib/test/codeflow-endpoint.test.mts",
			".pi/extensions/codeflow-analysis/test/codeflow-analysis.test.mts",
			".pi/extensions/codeflow-analysis/test/report.test.mts",
			".pi/extensions/codeflow-analysis/test/bridge.test.mts",
		]) {
			assert.ok(isRegistered(file), `npm test globs must register ${file}`);
		}
	});
});
