// ─── Tests: extensions.ts — resolveSkillPaths() ──────────────────
// Pure function tests — use dependency injection for existsSync.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import {
	resolveSkillPaths,
	resolveSkillPathsWithFs,
	discoverExtensionTools,
	resolveTools,
} from "../lib/extensions.ts";

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

// ─── discoverExtensionTools / resolveTools (real fs, cwd-scoped) ──

const roots: string[] = [];
function tmpRoot(): string {
	const r = fs.mkdtempSync(join(tmpdir(), "pi-ext-"));
	roots.push(r);
	return r;
}
function writeExt(root: string, rel: string, content: string): void {
	const file = join(root, ".pi", "extensions", rel);
	fs.mkdirSync(dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}
const regTool = (name: string): string => `.registerTool({ name: "${name}", description: "x" })`;

afterEach(() => {
	for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("discoverExtensionTools", () => {
	it("regression: honors cwd — two cwds return their own extension sets", () => {
		const a = tmpRoot();
		writeExt(a, "extA.ts", regTool("toolA"));
		const b = tmpRoot();
		writeExt(b, "extB.ts", regTool("toolB"));

		assert.deepEqual(discoverExtensionTools(a).get("extA"), ["toolA"]);
		assert.deepEqual(discoverExtensionTools(b).get("extB"), ["toolB"]);
		assert.equal(discoverExtensionTools(a).has("extB"), false);
		assert.equal(discoverExtensionTools(b).has("extA"), false);
	});

	it("order independence: reverse order yields same cwd-scoped results", () => {
		const a = tmpRoot();
		writeExt(a, "extA.ts", regTool("toolA"));
		const b = tmpRoot();
		writeExt(b, "extB.ts", regTool("toolB"));

		assert.deepEqual(discoverExtensionTools(b).get("extB"), ["toolB"]);
		assert.deepEqual(discoverExtensionTools(a).get("extA"), ["toolA"]);
	});

	it("interleaved A,B,A: no cross-contamination", () => {
		const a = tmpRoot();
		writeExt(a, "extA.ts", regTool("toolA"));
		const b = tmpRoot();
		writeExt(b, "extB.ts", regTool("toolB"));

		discoverExtensionTools(a);
		discoverExtensionTools(b);
		const third = discoverExtensionTools(a);
		assert.deepEqual(third.get("extA"), ["toolA"]);
		assert.equal(third.has("extB"), false);
	});

	it("cwd with no .pi/extensions dir → empty map, no throw", () => {
		const r = tmpRoot();
		assert.deepEqual([...discoverExtensionTools(r)], []);
	});

	it("empty-dir cwd first does not poison later valid cwd", () => {
		const empty = tmpRoot();
		const valid = tmpRoot();
		writeExt(valid, "extB.ts", regTool("toolB"));

		discoverExtensionTools(empty);
		assert.deepEqual(discoverExtensionTools(valid).get("extB"), ["toolB"]);
	});

	it("file without .registerTool is absent from map", () => {
		const r = tmpRoot();
		writeExt(r, "noTools.ts", "export default {};");
		assert.equal(discoverExtensionTools(r).has("noTools"), false);
	});

	it("file with two registerTool calls keeps both, in source order", () => {
		const r = tmpRoot();
		writeExt(r, "multi.ts", `${regTool("t1")};\n${regTool("t2")};`);
		assert.deepEqual(discoverExtensionTools(r).get("multi"), ["t1", "t2"]);
	});

	it("directory extension keys on dir name and reads index.ts", () => {
		const r = tmpRoot();
		writeExt(r, "dirExt/index.ts", regTool("dirTool"));
		assert.deepEqual(discoverExtensionTools(r).get("dirExt"), ["dirTool"]);
		assert.equal(discoverExtensionTools(r).has("index"), false);
	});

	it("no-arg defaults to process.cwd()", () => {
		assert.deepEqual(
			[...discoverExtensionTools()],
			[...discoverExtensionTools(process.cwd())],
		);
	});
});

describe("resolveTools", () => {
	it("reflects the passed cwd, not the first caller's", () => {
		const a = tmpRoot();
		writeExt(a, "extA.ts", regTool("toolA"));
		const b = tmpRoot();
		writeExt(b, "extB.ts", regTool("toolB"));

		assert.equal(resolveTools("base", "extA", a), "base,toolA");
		assert.equal(resolveTools("base", "extB", b), "base,toolB");
	});

	it("extension missing in cwd → agent tools only", () => {
		const b = tmpRoot();
		writeExt(b, "extB.ts", regTool("toolB"));
		assert.equal(resolveTools("base", "extA", b), "base");
	});

	it("filters supervisor from ext list, merges the rest", () => {
		const a = tmpRoot();
		writeExt(a, "extA.ts", regTool("toolA"));
		assert.equal(resolveTools("base", "supervisor,extA", a), "base,toolA");
	});

	it("undefined/empty ext names leaves agent tools unchanged", () => {
		assert.equal(resolveTools("base", undefined), "base");
		assert.equal(resolveTools("base", "   "), "base");
	});
});
