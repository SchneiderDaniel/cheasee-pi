/**
 * Tests for the audit-codeflow-analysis skill contract.
 *
 * Text-analysis tests that read SKILL.md and assert the required contract:
 * report references, the skill-owned fetch script, the ask_user confirmation
 * gate before any `gh issue create`, issues-only scope with a locked main,
 * create-internal-issue delegation, best-effort isolation disclosure, and
 * package.json wiring.
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

	it("references the report artifacts and the skill-owned fetch script", () => {
		assert.match(body, /ignore\/codeflow-report\.md/);
		assert.match(body, /ignore\/codeflow-report\.json/);
		assert.match(body, /scripts\/fetch-report\.mts/);
		assert.doesNotMatch(body, /codeflow_analysis_report/, "tool name must be gone");
		assert.doesNotMatch(body, /extensions\/codeflow-analysis/, "extension path must be gone");
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

describe("audit-codeflow-analysis SKILL.md — issue #1976 hardening", () => {
	it("distinguishes exit 2 (agent mistake), 3 (unverified) and 4 (crash, retry once)", () => {
		// Hard Rules must not lump 2 and 3 together as unverified.
		assert.doesNotMatch(body, /exits?[^\n]*`2`[^\n]*`3`[^\n]*unverified/i);
		assert.match(body, /`2`[^\n]*(usage|agent mistake|fix)/i);
		assert.match(body, /`3`[^\n]*(no `VERDICT`|ran, printed no)[^\n]*unverified/i);
		assert.match(body, /`4`[^\n]*(crash|timeout|spawn failure)[^\n]*retry once/i);
		assert.match(body, /retry once/i);
		assert.match(body, /never re-run/i);
		assert.match(body, /recovery/i);
		assert.match(body, /not answer-shopping/i);
	});

	it("makes a 0/1 retry verdict authoritative and only a still-crashing retry unverified", () => {
		assert.match(body, /retry that returns `0`\/`1` is authoritative/i);
		assert.match(body, /only a retry that still exits `3`\/`4` is unverified/i);
	});

	it("names the path-less architecture entries the markdown fallback omits", () => {
		for (const entry of [
			"154 Architecture Violations",
			"6 Duplicate Function Names",
			"3 Similar Code Blocks",
		]) {
			assert.ok(body.includes(entry), `must name ${entry}`);
		}
		assert.match(body, /JSON-only/i);
		assert.match(body, /not a parser fault/i);
	});

	it("discloses JSON-only categories and the owning component via bridge-status", () => {
		assert.match(body, /bridge-status/);
		assert.match(body, /capture/i);
		assert.match(body, /`\/api\/analysis\/report\.json` route is down/i);
		assert.match(body, /duplicates, layer violations, suggestions/);
	});

	it("states the canonical count unit and reconciles the UI security summary separately", () => {
		assert.match(body, /post-`dedupeIssues`/);
		assert.match(body, /\(kind, title, files\)/);
		assert.match(body, /dedupes by rule/i);
		assert.match(body, /UI summary is a different unit/i);
	});

	it("documents the coverage rule and the pre-filter scope", () => {
		assert.match(body, /items > 0 && candidates === 0/);
		assert.match(body, /unparsedItems/);
		assert.match(body, /known-false-positives\.md/);
		assert.match(body, /pre-filter/i);
	});

	it("documents --emit-findings", () => {
		assert.match(body, /--emit-findings/);
		assert.match(body, /NN-<slug>\.md/);
	});

	it("ships references/known-false-positives.md with one row per observed mechanism", () => {
		const refPath = resolve(
			ROOT,
			".pi/skills/audit-codeflow-analysis/references/known-false-positives.md",
		);
		assert.ok(existsSync(refPath), "known-false-positives.md must exist");
		const ref = readFileSync(refPath, "utf-8");
		for (const token of [
			"resolveGitHubToken",
			"UsageColorToken",
			"comment",
			"Shell()",
			"shell: true",
			"TODO",
			"ast-grep",
			"wire()",
		]) {
			assert.ok(ref.includes(token), `reference missing mechanism token ${token}`);
		}
	});

	it("points the validator prompt at the known false-positive reference", () => {
		const validator = readFileSync(
			resolve(ROOT, ".pi/skills/audit-codeflow-analysis/references/finding-validator.md"),
			"utf-8",
		);
		assert.match(validator, /known-false-positives\.md/);
	});
});

describe("package.json test wiring", () => {
	it("npm test globs register the codeflow skill test files", () => {
		for (const file of [
			".pi/extensions/lib/test/codeflow-endpoint.test.mts",
			".pi/skills/audit-codeflow-analysis/test/codeflow-analysis.test.mts",
			".pi/skills/audit-codeflow-analysis/test/report.test.mts",
			".pi/skills/audit-codeflow-analysis/test/fetch-report-cli.test.mts",
			".pi/skills/audit-codeflow-analysis/test/bridge.test.mts",
			".pi/skills/audit-codeflow-analysis/test/dry-run.test.mts",
		]) {
			assert.ok(isRegistered(file), `npm test globs must register ${file}`);
		}
	});
});
