// ─── Tests: extensions.ts — resolveSkillPaths() ──────────────────
// Pure function tests — use dependency injection for existsSync.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { resolveSkillPaths, resolveSkillPathsWithFs } from "../lib/extensions.ts";

// ─── resolveSkillPaths (uses real fs) ────────────────────────────

describe("resolveSkillPaths", () => {
	it("returns empty array for undefined", () => {
		assert.deepEqual(resolveSkillPaths(undefined), []);
	});

	it("returns empty array for empty string", () => {
		assert.deepEqual(resolveSkillPaths(""), []);
	});

	it("returns empty array for whitespace-only string", () => {
		assert.deepEqual(resolveSkillPaths("   "), []);
	});

	it("resolves extension-spec (real SKILL.md exists)", () => {
		const result = resolveSkillPaths("extension-spec");
		assert.equal(result.length, 1);
		assert.ok(result[0]!.endsWith(".pi/skills/extension-spec/SKILL.md"));
	});

	it("throws for nonexistent skill", () => {
		assert.throws(() => resolveSkillPaths("nonexistent-skill-xyz"), /nonexistent-skill-xyz/);
	});

	it("throw message includes both attempted paths", () => {
		try {
			resolveSkillPaths("nosuchskill");
			assert.fail("Expected error");
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			assert.ok(msg.includes("nosuchskill"), `Message should include skill name: ${msg}`);
			assert.ok(
				msg.includes("nosuchskill.md") || msg.includes("nosuchskill.md"),
				`Message should include .md path: ${msg}`,
			);
			assert.ok(
				msg.includes("SKILL.md") || msg.includes("nosuchskill/SKILL.md"),
				`Message should include SKILL.md path: ${msg}`,
			);
		}
	});
});

// ─── resolveSkillPathsWithFs (injected existsSync) ─────────────

describe("resolveSkillPathsWithFs", () => {
	it("resolves single skill via .md file", () => {
		const mockExists = (p: string): boolean => {
			return p.includes(".pi/skills/my-skill.md");
		};
		const result = resolveSkillPathsWithFs("my-skill", "/root", mockExists);
		assert.equal(result.length, 1);
		assert.ok(result[0]!.endsWith(".pi/skills/my-skill.md"));
	});

	it("falls back to SKILL.md when .md missing", () => {
		const mockExists = (p: string): boolean => {
			return p.includes(".pi/skills/my-skill/SKILL.md");
		};
		const result = resolveSkillPathsWithFs("my-skill", "/root", mockExists);
		assert.equal(result.length, 1);
		assert.ok(result[0]!.endsWith(".pi/skills/my-skill/SKILL.md"));
	});

	it(".md takes priority when both exist", () => {
		const mockExists = (p: string): boolean => {
			return p.includes(".pi/skills/my-skill.md") || p.includes(".pi/skills/my-skill/SKILL.md");
		};
		const result = resolveSkillPathsWithFs("my-skill", "/root", mockExists);
		assert.equal(result.length, 1);
		assert.ok(result[0]!.endsWith(".pi/skills/my-skill.md"));
	});

	it("throws when neither path exists", () => {
		const mockExists = (): boolean => false;
		assert.throws(() => resolveSkillPathsWithFs("bad-skill", "/root", mockExists), /bad-skill/);
	});

	it("throw message includes both paths", () => {
		const mockExists = (): boolean => false;
		try {
			resolveSkillPathsWithFs("bad-skill", "/root", mockExists);
			assert.fail("Expected error");
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			assert.ok(msg.includes("bad-skill"));
			assert.ok(msg.includes("bad-skill.md"));
			assert.ok(msg.includes("SKILL.md"));
		}
	});

	it("resolves multiple skills", () => {
		const existing = new Set(["skill-a", "skill-b"]);
		const mockExists = (p: string): boolean => {
			for (const name of existing) {
				if (p.includes(`.pi/skills/${name}.md`)) return true;
			}
			return false;
		};
		const result = resolveSkillPathsWithFs("skill-a, skill-b", "/root", mockExists);
		assert.equal(result.length, 2);
		assert.ok(result[0]!.endsWith("skill-a.md"));
		assert.ok(result[1]!.endsWith("skill-b.md"));
	});

	it("throws on missing skill in multiple (fail-fast)", () => {
		const mockExists = (p: string): boolean => {
			return p.includes(".pi/skills/skill-a.md");
		};
		assert.throws(
			() => resolveSkillPathsWithFs("skill-a, missing-skill", "/root", mockExists),
			/missing-skill/,
		);
	});

	it("respects custom cwd parameter", () => {
		const mockExists = (p: string): boolean => {
			return p === "/custom/path/.pi/skills/my-skill.md";
		};
		const result = resolveSkillPathsWithFs("my-skill", "/custom/path", mockExists);
		assert.equal(result.length, 1);
		assert.equal(result[0], "/custom/path/.pi/skills/my-skill.md");
	});

	it("empty/undefined returns empty array regardless of mock", () => {
		const mockExists = (): boolean => true;
		assert.deepEqual(resolveSkillPathsWithFs(undefined, "/root", mockExists), []);
		assert.deepEqual(resolveSkillPathsWithFs("", "/root", mockExists), []);
		assert.deepEqual(resolveSkillPathsWithFs("   ", "/root", mockExists), []);
	});
});
