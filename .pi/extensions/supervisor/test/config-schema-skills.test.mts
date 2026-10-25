// ─── Tests: config.ts — Phase 1 config validation ──────────────────
// Pure function tests — no infra needed.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
	validateAgentTimeouts,
	loadSkillsRoots,
	SupervisorConfigSchema,
	MAX_AGENT_TIMEOUT_SEC,
} from "../config/config.ts";

// Split from config.test.mts (issue #2035 Long File refactor).
// ─── SupervisorConfigSchema — agentTimeoutSec / agentKillGraceSec ──

describe("SupervisorConfigSchema — per-agent timeout fields", () => {
	const base = {
		repo: "owner/repo",
		projectNumber: 1,
		statusMapping: { todo: "developer" },
		codeowners: ["user"],
	};

	it("accepts agentTimeoutSec as non-negative ints per agent", () => {
		const result = SupervisorConfigSchema.parse({ ...base, agentTimeoutSec: { developer: 60 } });
		assert.deepEqual(result.agentTimeoutSec, { developer: 60 });
	});

	it("accepts agentTimeoutSec 0 (no timeout)", () => {
		const result = SupervisorConfigSchema.parse({ ...base, agentTimeoutSec: { developer: 0 } });
		assert.deepEqual(result.agentTimeoutSec, { developer: 0 });
	});

	it("rejects negative, non-integer, and non-number agentTimeoutSec values", () => {
		for (const bad of [{ developer: -1 }, { developer: 1.5 }, { developer: "60" }]) {
			assert.throws(
				() => SupervisorConfigSchema.parse({ ...base, agentTimeoutSec: bad }),
				undefined as any,
				`should reject ${JSON.stringify(bad)}`,
			);
		}
	});

	it("rejects agentTimeoutSec values above the Node timer range (audit finding #3)", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({
					...base,
					agentTimeoutSec: { developer: MAX_AGENT_TIMEOUT_SEC + 1 },
				}),
			/timer limit/,
		);
		assert.deepEqual(
			SupervisorConfigSchema.parse({
				...base,
				agentTimeoutSec: { developer: MAX_AGENT_TIMEOUT_SEC },
			}).agentTimeoutSec,
			{ developer: MAX_AGENT_TIMEOUT_SEC },
		);
	});

	it("agentKillGraceSec is optional (bare schema — effective default in runner)", () => {
		const result = SupervisorConfigSchema.parse(base);
		assert.equal(result.agentKillGraceSec, undefined);
	});

	it("agentTimeoutTierScale is optional (no .default() — typed fixtures stay stable)", () => {
		assert.equal(SupervisorConfigSchema.parse(base).agentTimeoutTierScale, undefined);
	});

	it("agentTimeoutTierScale accepts a partial tier→multiplier object", () => {
		const result = SupervisorConfigSchema.parse({ ...base, agentTimeoutTierScale: { large: 2 } });
		assert.deepEqual(result.agentTimeoutTierScale, { large: 2 });
	});

	it("agentTimeoutTierScale rejects non-objects, bad multipliers and unknown tier keys", () => {
		for (const bad of ["x", [], { large: 0 }, { large: -1 }, { large: Infinity }, { huge: 2 }]) {
			assert.throws(
				() => SupervisorConfigSchema.parse({ ...base, agentTimeoutTierScale: bad }),
				undefined as any,
				`should reject ${JSON.stringify(bad)}`,
			);
		}
	});

	it("agentKillGraceSec accepts non-negative ints, incl. 0 (immediate SIGKILL)", () => {
		assert.equal(
			SupervisorConfigSchema.parse({ ...base, agentKillGraceSec: 0 }).agentKillGraceSec,
			0,
		);
		assert.equal(
			SupervisorConfigSchema.parse({ ...base, agentKillGraceSec: 10 }).agentKillGraceSec,
			10,
		);
	});

	it("agentKillGraceSec rejects negative and non-integer values", () => {
		for (const bad of [-1, 1.5, "10"]) {
			assert.throws(
				() => SupervisorConfigSchema.parse({ ...base, agentKillGraceSec: bad }),
				undefined as any,
				`should reject ${JSON.stringify(bad)}`,
			);
		}
	});

	it("agentKillGraceSec rejects values above the Node timer range (audit finding #3)", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({
					...base,
					agentKillGraceSec: MAX_AGENT_TIMEOUT_SEC + 1,
				}),
			/timer limit|Too big|too_big/i,
		);
	});

	it("legacy validateAgentTimeouts still rejects 0/negative (deprecated alias contract)", () => {
		assert.throws(() => validateAgentTimeouts({ developer: 0 }, ["developer"]), /positive integer/);
		assert.throws(
			() => validateAgentTimeouts({ developer: -1 }, ["developer"]),
			/positive integer/,
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
		const dir = makeFixture(JSON.stringify({ skills: ["!foo", "+bar", "-baz", ".pi/skills"] }));
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
