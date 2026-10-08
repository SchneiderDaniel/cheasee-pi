/**
 * Tests for the audit-codeflow-analysis skill contract.
 *
 * Text-analysis tests that read SKILL.md and assert the required contract:
 * report references, the skill-owned fetch script, the ask_user confirmation
 * gate before any `gh issue create`, issues-only scope with a locked main,
 * git-issue-create-internal delegation, best-effort isolation disclosure, and
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

	it("states issues only, main locked, and delegates filing to git-issue-create-internal", () => {
		assert.match(body, /issues only/i);
		assert.match(body, /main.*locked|locked.*main/i);
		assert.match(body, /git-issue-create-internal/);
	});

	it("requires best-effort file isolation and overlap disclosure", () => {
		assert.match(body, /best-effort/i);
		assert.match(body, /overlap/i);
		assert.match(body, /disclos/i, "must require disclosing overlap in the issue body");
	});
});

describe("audit-codeflow-analysis SKILL.md — issue #1983 headless run", () => {
	it("drops the manual UI precondition and documents the on-demand run route", () => {
		assert.doesNotMatch(
			body,
			/UI has been run at least once/i,
			"the manual UI precondition must be gone",
		);
		assert.match(body, /headless analyzer/i);
		assert.match(body, /POST \/api\/analysis\/run/);
		assert.match(body, /run-status/);
		assert.match(body, /browser bridge/i, "the browser bridge stays the alternative producer");
	});

	it("keeps the 0/1/2 exit semantics", () => {
		assert.match(body, /`0`[^\n]*report fetched/i);
		assert.match(body, /`1`[^\n]*transport/i);
		assert.match(body, /`2`[^\n]*no report/i);
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

	it("documents the target model that keeps path-less architecture entries", () => {
		// A `**Affected:**` item may name a path, a layer edge or a bare symbol; all
		// three keep the finding as a candidate. The old "JSON-only in practice"
		// exemption blessed the drop and is gone.
		assert.match(body, /layer\s+-?\s*edge/i);
		assert.match(body, /symbol/i);
		assert.match(body, /targets?/i);
		assert.doesNotMatch(body, /JSON-only in practice/i);
		assert.doesNotMatch(body, /expected, not a parser fault/i);
	});

	it("lets a layer-edge or symbol finding be filed without naming a file", () => {
		// Verification must not require a file: a validated `utils → ui` or `execFn`
		// candidate has no path and would otherwise be unreachable at filing time.
		assert.match(body, /cites at least one `target`/);
		assert.match(body, /a layer edge\s*\(`utils → ui`\), or a symbol/);
	});

	it("discloses JSON-only categories and the owning component via bridge-status", () => {
		assert.match(body, /bridge-status/);
		assert.match(body, /capture/i);
		assert.match(body, /`\/api\/analysis\/report\.json` route is down/i);
		assert.match(body, /duplicates, layer violations, suggestions/);
	});

	it("states the canonical count unit and reconciles the UI security summary separately", () => {
		assert.match(body, /post-`dedupeIssues`/);
		assert.match(body, /\(kind, title, targets\)/);
		assert.match(body, /file-only projection/i);
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

	it("validates only bug-class candidates in the documented Step 3 loop", () => {
		assert.match(body, /issueType: bug/);
		assert.ok(body.includes("Issue type:"), "the Step 3 loop must filter on the triage tag");
		assert.ok(body.includes("|| continue"), "the Step 3 loop must skip non-bug candidates");
		assert.match(body, /never reach\s+the validator/i);
	});

	it("refers to classifyFinding without restating the kind → issue-type mapping", () => {
		assert.match(body, /classifyFinding/);
		assert.doesNotMatch(body, /`anti-pattern` is chore/);
		assert.doesNotMatch(body, /`pattern` is informational/);
		assert.doesNotMatch(body, /use the bug template/);
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

describe("audit-codeflow-analysis SKILL.md — issue #1992 disposition routing", () => {
	it("files chore metrics/anti-patterns as refactor issues, never route-or-drop", () => {
		assert.match(body, /`chore`[^\n]*refactor/i);
		assert.ok(
			!body.includes("route it through the freeform"),
			"the route-or-drop clause must be gone",
		);
		assert.doesNotMatch(body, /or\s+\n?\s*drop it, but never send it to the bug validator/i);
	});

	it("offers informational facts as an opt-in disposition", () => {
		assert.match(body, /`offer-optional`/);
		assert.match(body, /`informational`[^\n]*opt-in|opt-in[^\n]*`informational`/i);
	});

	it("documents the disposition field returned by classifyFinding", () => {
		assert.match(body, /disposition/i);
	});
});

describe("package.json test wiring", () => {
	it("npm test globs register the codeflow skill test files", () => {
		for (const file of [
			".pi/extensions/lib/test/codeflow-endpoint.test.mts",
			".pi/skills/audit-codeflow-analysis/test/codeflow-analysis.test.mts",
			".pi/skills/audit-codeflow-analysis/test/codeflow-run.test.mts",
			".pi/skills/audit-codeflow-analysis/test/report.test.mts",
			".pi/skills/audit-codeflow-analysis/test/fetch-report-cli.test.mts",
			".pi/skills/audit-codeflow-analysis/test/bridge.test.mts",
			".pi/skills/audit-codeflow-analysis/test/dry-run.test.mts",
			"test/codeflow-run-analysis.test.mts",
		]) {
			assert.ok(isRegistered(file), `npm test globs must register ${file}`);
		}
	});
});
