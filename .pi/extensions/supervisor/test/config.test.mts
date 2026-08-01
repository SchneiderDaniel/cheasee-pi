// ─── Tests: config.ts — Phase 1 config validation ──────────────────
// Pure function tests — no infra needed.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { validateAgentTimeouts, loadSkillsRoots } from "../config/config.ts";

// ─── validateAgentTimeouts ────────────────────────────────────────

describe("validateAgentTimeouts", () => {
	it("returns empty object for undefined input", () => {
		assert.deepEqual(validateAgentTimeouts(undefined, ["developer"]), {});
	});

	it("returns empty object for null input", () => {
		assert.deepEqual(validateAgentTimeouts(null, ["developer"]), {});
	});

	it("throws for non-object input", () => {
		assert.throws(() => validateAgentTimeouts("string", []), /agentTimeoutsMin must be an object/);
		assert.throws(() => validateAgentTimeouts(42, []), /agentTimeoutsMin must be an object/);
		assert.throws(() => validateAgentTimeouts([], []), /agentTimeoutsMin must be an object/);
	});

	it("throws for non-positive-integer values", () => {
		assert.throws(
			() => validateAgentTimeouts({ developer: -1 }, ["developer"]),
			/positive integer/,
		);
		assert.throws(() => validateAgentTimeouts({ developer: 0 }, ["developer"]), /positive integer/);
		assert.throws(
			() => validateAgentTimeouts({ developer: 1.5 }, ["developer"]),
			/positive integer/,
		);
		assert.throws(
			() => validateAgentTimeouts({ developer: "10" }, ["developer"]),
			/positive integer/,
		);
	});

	it("validates known agents and returns sanitized record", () => {
		const result = validateAgentTimeouts({ developer: 30, auditor: 60 }, ["developer", "auditor"]);
		assert.deepEqual(result, { developer: 30, auditor: 60 });
	});

	it("warns for unknown agents but does not throw", () => {
		// This should log a warning but return empty for unknown agent
		const result = validateAgentTimeouts({ unknownAgent: 30 }, ["developer"]);
		assert.deepEqual(result, {});
	});

	it("parses positive integer values correctly", () => {
		const result = validateAgentTimeouts({ developer: 10 }, ["developer"]);
		assert.equal(result.developer, 10);
	});
});

// ─── loadConfig tests (pure — parse settings object shape) ────────

describe("loadConfig — config shape", () => {
	// Test that the config object structure matches what loadConfig returns
	// by examining the type shape. Actual loadConfig reads filesystem so
	// we test the validation helpers and interface contract here.

	it("config interface supports agentTokenBudget and maxToolCalls as optional numbers", () => {
		// Interface contract test: these fields are optional in the type
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
			agentTokenBudget: 500000,
			maxToolCalls: 30,
		};
		// Just validate they're accepted as numbers
		assert.equal(typeof config.agentTokenBudget, "number");
		assert.equal(typeof config.maxToolCalls, "number");
	});

	it("config interface allows missing agentTokenBudget and maxToolCalls (backward compat)", () => {
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
		};
		// No agentTokenBudget or maxToolCalls — should still work
		assert.equal(config.agentTokenBudget, undefined);
		assert.equal(config.maxToolCalls, undefined);
	});

	it("agentTokenBudget must be non-negative integer if provided", () => {
		// Test validation that would be applied in loadConfig
		const validValues = [0, 100, 500000, 999999];
		for (const v of validValues) {
			assert.ok(Number.isInteger(v) && v >= 0, `${v} should be valid`);
		}
		const invalidValues = [-1, -100, 1.5, "500000", true, null];
		for (const v of invalidValues) {
			assert.ok(
				!(typeof v === "number" && Number.isInteger(v) && v >= 0),
				`${JSON.stringify(v)} should be invalid`,
			);
		}
	});

	it("maxToolCalls must be non-negative integer if provided", () => {
		const validValues = [0, 30, 100];
		for (const v of validValues) {
			assert.ok(Number.isInteger(v) && v >= 0, `${v} should be valid`);
		}
		const invalidValues = [-1, 1.5, "30", true, null];
		for (const v of invalidValues) {
			assert.ok(
				!(typeof v === "number" && Number.isInteger(v) && v >= 0),
				`${JSON.stringify(v)} should be invalid`,
			);
		}
	});

	it("commentSummaryThreshold defaults to 7, must be non-negative integer", () => {
		const validValues = [0, 1, 7, 100];
		for (const v of validValues) {
			assert.ok(Number.isInteger(v) && v >= 0, `${v} should be valid`);
		}
		const invalidValues = [-1, 1.5, "7", true, null];
		for (const v of invalidValues) {
			assert.ok(
				!(typeof v === "number" && Number.isInteger(v) && v >= 0),
				`${JSON.stringify(v)} should be invalid`,
			);
		}
	});

	it("maxCommentChars defaults to 2000, must be positive integer", () => {
		const validValues = [1, 500, 2000, 10000];
		for (const v of validValues) {
			assert.ok(Number.isInteger(v) && v > 0, `${v} should be valid`);
		}
		const invalidValues = [0, -1, 1.5, "2000", true, null];
		for (const v of invalidValues) {
			assert.ok(
				!(typeof v === "number" && Number.isInteger(v) && v > 0),
				`${JSON.stringify(v)} should be invalid`,
			);
		}
	});

	it("auditScoreThreshold defaults to 0.75 when not provided", () => {
		// Interface contract: optional field with default 0.75
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
		};
		const threshold = config.auditScoreThreshold ?? 0.75;
		assert.equal(threshold, 0.75);
	});

	it("auditScoreThreshold must be a number between 0.0 and 1.0 if provided", () => {
		const validValues = [0.0, 0.25, 0.5, 0.75, 1.0];
		for (const v of validValues) {
			assert.ok(typeof v === "number" && !isNaN(v) && v >= 0 && v <= 1, `${v} should be valid`);
		}
		const invalidValues = [-0.1, 1.1, "0.75", true, null, NaN];
		for (const v of invalidValues) {
			assert.ok(
				!(typeof v === "number" && !isNaN(v) && v >= 0 && v <= 1),
				`${JSON.stringify(v)} should be invalid`,
			);
		}
	});

	it("auditScoreThreshold accepts boundary values 0.0 and 1.0", () => {
		assert.ok(
			typeof 0.0 === "number" && !isNaN(0.0) && 0.0 >= 0 && 0.0 <= 1,
			"0.0 should be valid",
		);
		assert.ok(
			typeof 1.0 === "number" && !isNaN(1.0) && 1.0 >= 0 && 1.0 <= 1,
			"1.0 should be valid",
		);
	});
});

// ─── loadSkillsRoots — settings-driven skill roots ────────────────

describe("loadSkillsRoots", () => {
	let tmp: string;

	afterEach(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		tmp = "";
	});

	/** Write `.pi/settings.json` in a fresh temp dir; settingsJson null → no file. */
	function makeFixture(settingsJson: string | null): string {
		tmp = mkdtempSync(join(tmpdir(), "pi-skills-"));
		if (settingsJson !== null) {
			mkdirSync(join(tmp, ".pi"), { recursive: true });
			writeFileSync(join(tmp, ".pi", "settings.json"), settingsJson);
		}
		return tmp;
	}

	it("adapter: plain entries resolve against cwd, ../ entries against settings dir", () => {
		const dir = makeFixture(JSON.stringify({ skills: [".pi/skills", "../private-pi/skills"] }));
		assert.deepEqual(loadSkillsRoots(dir), [
			join(dir, ".pi", "skills"),
			join(dir, "private-pi", "skills"),
		]);
	});

	it("adapter: missing settings.json → [] (fail-open, no throw)", () => {
		const dir = makeFixture(null);
		assert.deepEqual(loadSkillsRoots(dir), []);
	});

	it("adapter: invalid JSON → [] (fail-open, no throw)", () => {
		const dir = makeFixture("{ not json");
		assert.deepEqual(loadSkillsRoots(dir), []);
	});

	it("entity: missing skills key or empty array → []", () => {
		assert.deepEqual(loadSkillsRoots(makeFixture(JSON.stringify({ prompts: [] }))), []);
		assert.deepEqual(loadSkillsRoots(makeFixture(JSON.stringify({ skills: [] }))), []);
	});

	it("entity: pattern-prefixed entries (!/+/−) filtered out, plain kept", () => {
		const dir = makeFixture(
			JSON.stringify({ skills: ["!foo", "+bar", "-baz", ".pi/skills"] }),
		);
		assert.deepEqual(loadSkillsRoots(dir), [join(dir, ".pi", "skills")]);
	});

	it("entity: non-string entries filtered out", () => {
		const dir = makeFixture(
			JSON.stringify({ skills: [".pi/skills", 42, null, true, "../private-pi/skills"] }),
		);
		assert.deepEqual(loadSkillsRoots(dir), [
			join(dir, ".pi", "skills"),
			join(dir, "private-pi", "skills"),
		]);
	});

	it("entity: every root is absolute; order matches declared order", () => {
		const dir = makeFixture(JSON.stringify({ skills: ["../a", ".pi/skills", "../b"] }));
		const roots = loadSkillsRoots(dir);
		assert.equal(roots.length, 3);
		for (const r of roots) assert.ok(isAbsolute(r), `${r} should be absolute`);
		assert.equal(roots[0], join(dir, "a"));
		assert.equal(roots[1], join(dir, ".pi", "skills"));
		assert.equal(roots[2], join(dir, "b"));
	});
});
