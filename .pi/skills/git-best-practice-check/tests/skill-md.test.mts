// Phase 5 — SKILL.md contract + checklist parity.
//
// The skill is the interactive surface, so its contract is text: frontmatter
// shape, the user-invocation gate, the four trigger phrases, and the consent
// loop. The checklist itself lives in SKILL.md, while the status rules live in
// scripts/evaluate.jq — the parity assertions keep the two from drifting.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SKILL_DIR = resolve(import.meta.dirname, "..");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const EVALUATE = join(SKILL_DIR, "scripts", "evaluate.jq");

const source = readFileSync(SKILL_MD, "utf8");

const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
const frontmatterRaw = frontmatterMatch ? frontmatterMatch[1] : "";
const body = frontmatterMatch ? source.slice(frontmatterMatch[0].length) : source;

function frontmatterFields(): Map<string, string> {
	const fields = new Map<string, string>();
	for (const line of frontmatterRaw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) continue;
		fields.set(m[1], m[2].trim());
	}
	return fields;
}

function ruleIds(): string[] {
	const out = execFileSync("jq", ["-n", "-r", "-f", EVALUATE, "--arg", "mode", "list-ids"], {
		encoding: "utf8",
	});
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function checklistIds(): string[] {
	const ids: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const m = line.match(/^\|\s*`([a-z0-9-]+)`\s*\|/);
		if (m) ids.push(m[1]);
	}
	return ids;
}

describe("SKILL.md frontmatter", () => {
	it("parses and carries exactly the three supported keys", () => {
		assert.ok(frontmatterMatch, "SKILL.md must start with a YAML frontmatter block");
		const fields = frontmatterFields();
		assert.deepEqual(
			[...fields.keys()].sort(),
			["description", "disable-model-invocation", "name"],
			"frontmatter must only declare name, description and disable-model-invocation",
		);
	});

	it("has a name matching the skill directory", () => {
		const fields = frontmatterFields();
		assert.equal(fields.get("name"), "git-best-practice-check");
		assert.equal(dirname(SKILL_MD).split(/[\\/]/).pop(), fields.get("name"));
	});

	it("disables model invocation so no agent can auto-trigger the interactive flow", () => {
		const fields = frontmatterFields();
		assert.equal(fields.get("disable-model-invocation"), "true");
	});

	it("declares a description that names the interaction model", () => {
		const description = frontmatterFields().get("description") ?? "";
		assert.ok(description.length > 20, "description must be a real sentence");
		assert.match(description, /user[- ]initiated|interactive/i);
	});
});

describe("user-invocation gate wording", () => {
	it("states the skill is user-initiated and interactive", () => {
		assert.match(body, /user[- ]initiated/i);
		assert.match(body, /interactive/i);
	});

	it("forbids agents from invoking it", () => {
		assert.match(body, /[Aa]gents? (must|never|may not)/);
		assert.match(body, /never\s+auto-?invoke/i);
	});

	it("lists the four trigger phrases", () => {
		for (const phrase of [
			"git best practice",
			"best practice check",
			"repo health check",
			"check best practices",
		]) {
			assert.ok(
				body.toLowerCase().includes(phrase),
				`body must mention the trigger phrase "${phrase}"`,
			);
		}
	});
});

describe("checklist parity", () => {
	it("lists every canonical check id in the checklist table", () => {
		const ids = checklistIds();
		const expected = [
			"branch-protection",
			"dependabot-alerts",
			"code-scanning",
			"secret-scanning",
			"community-readme",
			"community-code-of-conduct",
			"community-contributing",
			"community-license",
			"community-security-policy",
			"community-issue-templates",
			"community-pull-request-template",
		];
		assert.deepEqual([...ids].sort(), [...expected].sort());
	});

	it("keeps SKILL.md and evaluate.jq rule ids in sync", () => {
		assert.deepEqual([...checklistIds()].sort(), [...ruleIds()].sort());
	});

	it("documents every implemented check id exactly once", () => {
		const ids = checklistIds();
		assert.equal(new Set(ids).size, ids.length, "duplicate check id in the checklist");
	});
});

describe("consent loop contract", () => {
	it("prescribes a per-practice consent question", () => {
		assert.match(body, /Remediate/i);
		assert.match(body, /\(y\/n\)/i);
	});

	it("prescribes skip-on-no and post-remediation re-verification", () => {
		assert.match(body, /skip/i);
		assert.match(body, /re-?verify/i);
	});
});

describe("transport delegation", () => {
	it("contains no raw gh api command strings", () => {
		assert.equal(
			/gh\s+api/.test(source),
			false,
			"SKILL.md must not carry transport commands; the scripts own them",
		);
	});

	it("references only script paths that exist", () => {
		const referenced = new Set<string>();
		for (const m of source.matchAll(/`([A-Za-z0-9_./-]+\.(?:sh|jq))`/g)) {
			referenced.add(m[1]);
		}
		assert.ok(referenced.size > 0, "SKILL.md must reference its scripts");
		for (const ref of referenced) {
			const candidates = [join(SKILL_DIR, ref), join(SKILL_DIR, "scripts", ref)];
			assert.ok(
				candidates.some((p) => existsSync(p)),
				`SKILL.md references \`${ref}\` but no such file exists under ${SKILL_DIR}`,
			);
		}
	});
});
