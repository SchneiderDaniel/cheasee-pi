// Shipped-artifact coherence: the config, criteria, and SKILL.md an operator
// reads must match what the code enforces, and must never carry a secret.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CRITERIA_IDS } from "../lib/decision.ts";

const SKILL_DIR = dirname(import.meta.dirname);

function read(relative: string): string {
	return readFileSync(join(SKILL_DIR, relative), "utf8");
}

describe("artifacts: config.json", () => {
	const config = JSON.parse(read("config.json")) as Record<string, unknown>;

	it("declares the provider, model, and run knobs", () => {
		assert.equal(typeof config.provider, "string");
		assert.ok((config.provider as string).length > 0);
		assert.equal(typeof config.model, "string");
		assert.ok((config.model as string).length > 0);
		assert.equal(Number.isInteger(config.concurrency), true);
		assert.ok((config.concurrency as number) >= 1);
		assert.equal(Number.isInteger(config.maxAttempts), true);
		assert.equal(Number.isInteger(config.haltAfterConsecutiveFailures), true);
	});

	it("keeps the BAD threshold inside [0, 1]", () => {
		assert.equal(typeof config.badConfidenceThreshold, "number");
		assert.ok((config.badConfidenceThreshold as number) >= 0);
		assert.ok((config.badConfidenceThreshold as number) <= 1);
	});

	it("carries no credential", () => {
		const raw = read("config.json");
		assert.doesNotMatch(raw, /sk-[A-Za-z0-9]/);
		assert.doesNotMatch(raw, /API_KEY"/);
		assert.equal(
			Object.keys(config).some((key) => /key|token|secret/i.test(key)),
			false,
		);
	});
});

describe("artifacts: criteria.md", () => {
	const criteria = read("criteria.md");

	it("defines exactly the criterion ids the parser accepts", () => {
		const ids = [...criteria.matchAll(/^## (C\d+) —/gm)].map((match) => match[1]);

		assert.deepEqual(ids, [...CRITERIA_IDS]);
	});

	it("marks the BAD-qualifying criteria and forbids style-only BAD verdicts", () => {
		assert.match(criteria, /C1[^\n]*BAD-qualifying/);
		assert.match(criteria, /C2[^\n]*BAD-qualifying/);
		assert.match(criteria, /C3[^\n]*BAD-qualifying/);
		assert.match(criteria, /never BAD-qualifying alone/);
		assert.match(criteria, /Not grounds for BAD/);
		assert.match(criteria, /verbatim/);
	});

	it("cites the four established sources", () => {
		for (const url of [
			"https://abseil.io/resources/swe-book/html/ch12.html",
			"https://testing.googleblog.com/2010/12/test-sizes.html",
			"https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-best-practices",
			"https://martinfowler.com/articles/practical-test-pyramid.html",
		]) {
			assert.ok(criteria.includes(url), `criteria.md must cite ${url}`);
		}
	});

	it("quotes its sources verbatim rather than paraphrasing", () => {
		const quotes = [...criteria.matchAll(/^> .+$/gm)].map((match) => match[0]);
		assert.ok(quotes.length >= 8, `expected several quoted passages, found ${quotes.length}`);

		// Verbatim modulo markdown line wrapping.
		const flat = criteria.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
		assert.ok(flat.includes("the ideal test is unchanging"));
		assert.ok(flat.includes("Test for observable behaviour instead"));
		assert.ok(flat.includes("isn't an indicator of success"));
		assert.ok(flat.includes("public API rather than its implementation details"));
	});
});

describe("artifacts: SKILL.md", () => {
	const skill = read("SKILL.md");

	it("is a skill-manifest with model invocation disabled", () => {
		assert.match(skill, /^---\nname: test-validator\n/);
		assert.match(skill, /disable-model-invocation: true/);
		assert.match(skill, /description: ".+"/);
	});

	it("documents the workflow, artifacts, and exit codes", () => {
		assert.match(skill, /criteria\.md/);
		assert.match(skill, /config\.json/);
		assert.match(skill, /ignore\/test-validator\/checkpoint\.jsonl/);
		assert.match(skill, /ignore\/test-validator\/report\.json/);
		assert.match(skill, /--restart/);
		assert.match(skill, /achieve|resume/i);
		for (const code of ["0", "1", "2", "3"]) {
			assert.match(
				skill,
				new RegExp(`\\|\\s*\`${code}\``),
				`SKILL.md must document exit code ${code}`,
			);
		}
	});

	it("states the hard rules the run enforces", () => {
		assert.match(skill, /never removes|does not remove|never delete/i);
		assert.match(skill, /one issue|exactly one issue/i);
		assert.match(skill, /GOOD or BAD/);
		assert.match(skill, /supervisor\.repo/);
	});
});
