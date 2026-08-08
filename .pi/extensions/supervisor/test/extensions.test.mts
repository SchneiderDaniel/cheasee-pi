// ─── Tests: extensions.ts — resolveSkillPaths() ──────────────────
// Pure function tests — use dependency injection for existsSync.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { resolveSkillPaths, resolveSkillPathsWithFs } from "../lib/extensions.ts";

// ─── resolveSkillPaths (uses real fs) ────────────────────────────

afterEach(() => mock.restoreAll());

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

	it("resolves extension-spec (real SKILL.md exists in a configured root)", () => {
		const result = resolveSkillPaths("extension-spec");
		if (fs.existsSync(resolvePath(process.cwd(), "private-pi/skills/extension-spec/SKILL.md"))) {
			assert.equal(result.length, 1);
			assert.ok(
				result[0]!.endsWith("extension-spec/SKILL.md"),
				`got ${result[0]}`,
			);
		} else {
			// Host-side private-pi clone absent (e.g. fresh clone) → fail-open
			assert.deepEqual(result, []);
		}
	});

	it("warns and skips for nonexistent skill (fail-open, no throw)", () => {
		const warnSpy = mock.method(console, "warn");
		const result = resolveSkillPaths("nonexistent-skill-xyz");
		warnSpy.mock.restore();
		assert.deepEqual(result, []);
		assert.ok(warnSpy.mock.calls.length >= 1, "should warn for missing skill");
		assert.ok(
			String(warnSpy.mock.calls[0]?.arguments[0] ?? "").includes("nonexistent-skill-xyz"),
		);
	});

	it("warning message includes skill name and all tried paths", () => {
		const warnSpy = mock.method(console, "warn");
		const result = resolveSkillPaths("nosuchskill");
		warnSpy.mock.restore();
		assert.deepEqual(result, []);
		const msg = String(warnSpy.mock.calls[0]?.arguments[0] ?? "");
		assert.ok(msg.includes("nosuchskill"), `Message should include skill name: ${msg}`);
		assert.ok(
			msg.includes("nosuchskill.md") && msg.includes("SKILL.md"),
			`Message should include tried paths: ${msg}`,
		);
	});

	it("adapter: settings-driven roots resolve temp-dir skill (real fs)", () => {
		const tmp = fs.mkdtempSync(join(tmpdir(), "pi-skills-"));
		try {
			fs.mkdirSync(join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(
				join(tmp, ".pi", "settings.json"),
				JSON.stringify({ skills: [".pi/skills", "../private-pi/skills"] }),
			);
			fs.mkdirSync(join(tmp, "private-pi", "skills", "x"), { recursive: true });
			fs.writeFileSync(join(tmp, "private-pi", "skills", "x", "SKILL.md"), "---\n");

			const result = resolveSkillPaths("x", tmp);
			assert.deepEqual(result, [join(tmp, "private-pi", "skills", "x", "SKILL.md")]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
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

	it("warns and skips when no root has the skill (no throw)", () => {
		const warnSpy = mock.method(console, "warn");
		const result = resolveSkillPathsWithFs("bad-skill", "/root", () => false);
		warnSpy.mock.restore();
		assert.deepEqual(result, []);
		assert.ok(warnSpy.mock.calls.length >= 1, "should warn for missing skill");
	});

	it("warning message includes name and both tried paths", () => {
		const warnSpy = mock.method(console, "warn");
		const result = resolveSkillPathsWithFs("bad-skill", "/root", () => false);
		warnSpy.mock.restore();
		assert.deepEqual(result, []);
		const msg = String(warnSpy.mock.calls[0]?.arguments[0] ?? "");
		assert.ok(msg.includes("bad-skill"));
		assert.ok(msg.includes("bad-skill.md"));
		assert.ok(msg.includes("SKILL.md"));
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

	it("returns present skills and skips missing one (partial results, single warning)", () => {
		const warnSpy = mock.method(console, "warn");
		const mockExists = (p: string): boolean => {
			return p.includes(".pi/skills/skill-a.md");
		};
		const result = resolveSkillPathsWithFs("skill-a, missing-skill", "/root", mockExists);
		warnSpy.mock.restore();
		assert.equal(result.length, 1);
		assert.ok(result[0]!.endsWith("skill-a.md"));
		assert.equal(warnSpy.mock.calls.length, 1, "warning emitted only for the missing skill");
		assert.ok(String(warnSpy.mock.calls[0]?.arguments[0] ?? "").includes("missing-skill"));
	});

	it("injected roots: resolves via later root when earlier roots miss (the bug fix)", () => {
		const roots = ["/root/.pi/skills", "/root/private-pi/skills"];
		const mockExists = (p: string): boolean => {
			return p === "/root/private-pi/skills/extension-spec/SKILL.md";
		};
		const result = resolveSkillPathsWithFs("extension-spec", "/root", mockExists, roots);
		assert.deepEqual(result, ["/root/private-pi/skills/extension-spec/SKILL.md"]);
	});

	it("injected roots: first hit wins when name exists in multiple roots", () => {
		const roots = ["/root/.pi/skills", "/root/private-pi/skills"];
		const mockExists = (p: string): boolean => {
			return (
				p === "/root/.pi/skills/dup.md" || p === "/root/private-pi/skills/dup.md"
			);
		};
		const result = resolveSkillPathsWithFs("dup", "/root", mockExists, roots);
		assert.deepEqual(result, ["/root/.pi/skills/dup.md"]);
	});

	it("per-root probe order: root-1 SKILL.md beats root-2 .md", () => {
		const roots = ["/root/.pi/skills", "/root/private-pi/skills"];
		const mockExists = (p: string): boolean => {
			return (
				p === "/root/.pi/skills/x/SKILL.md" || p === "/root/private-pi/skills/x.md"
			);
		};
		const result = resolveSkillPathsWithFs("x", "/root", mockExists, roots);
		assert.deepEqual(result, ["/root/.pi/skills/x/SKILL.md"]);
	});

	it("missing across all injected roots → warn containing name and all tried root paths", () => {
		const roots = ["/root/.pi/skills", "/root/private-pi/skills"];
		const warnSpy = mock.method(console, "warn");
		const result = resolveSkillPathsWithFs("ghost", "/root", () => false, roots);
		warnSpy.mock.restore();
		assert.deepEqual(result, []);
		const msg = String(warnSpy.mock.calls[0]?.arguments[0] ?? "");
		assert.ok(msg.includes("ghost"), `should include skill name: ${msg}`);
		assert.ok(msg.includes("/root/.pi/skills"), `should include root-1 paths: ${msg}`);
		assert.ok(msg.includes("/root/private-pi/skills"), `should include root-2 paths: ${msg}`);
	});

	it("pattern-prefixed entries in roots list are never probed as literal dirs", () => {
		const roots = ["!foo", "/root/.pi/skills"];
		const warnSpy = mock.method(console, "warn");
		const mockExists = (p: string): boolean => {
			return p.includes(".pi/skills/ok.md");
		};
		const result = resolveSkillPathsWithFs("ok", "/root", mockExists, roots);
		warnSpy.mock.restore();
		assert.deepEqual(result, [resolvePath("/root/.pi/skills", "ok.md")]);
		assert.equal(warnSpy.mock.calls.length, 0, "no warning for resolvable skill");
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
