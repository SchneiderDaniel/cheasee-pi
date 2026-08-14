/**
 * Split-boundary pins for the AGENTS.md → APPEND_SYSTEM.md migration (#1517).
 *
 * The global operating instructions (system role, tool-routing matrix,
 * prohibited operations, execution protocols, package-safety audit) live in
 * APPEND_SYSTEM.md at the repo root and are installed globally as
 * ~/.pi/agent/APPEND_SYSTEM.md. AGENTS.md is a repo-scoped stub.
 *
 * Single-load invariant: context-file dedup in pi is by path string, not
 * realpath — so a retained full AGENTS.md PLUS the global append would load
 * the instructions twice in cheasee-pi workspaces. These pins enforce the
 * split in both directions.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const AGENTS_PATH = resolve(ROOT, "AGENTS.md");
const APPEND_PATH = resolve(ROOT, "APPEND_SYSTEM.md");

const GLOBAL_SECTIONS = [
	"<system_role>",
	"<tool_routing_matrix>",
	"<prohibited_operations>",
	"<execution_protocols>",
	"<package_safety_audit>",
];

const REPO_ONLY_MARKERS = [
	"tsc:extensions",
	"supervisor.repo",
	"ignore/",
	"THE MAIN BRANCH IS LOCKED",
];

describe("APPEND_SYSTEM.md — global operating instructions", () => {
	it("exists at repo root", () => {
		assert.ok(existsSync(APPEND_PATH), `APPEND_SYSTEM.md not found at ${APPEND_PATH}`);
	});

	it("first line is the H1 dump-context anchor", () => {
		const firstLine = readFileSync(APPEND_PATH, "utf-8").split("\n")[0];
		assert.strictEqual(firstLine, "# Global Cheasee-Pi Operating Instructions");
	});

	it("contains all five global sections", () => {
		const content = readFileSync(APPEND_PATH, "utf-8");
		for (const section of GLOBAL_SECTIONS) {
			assert.ok(content.includes(section), `APPEND_SYSTEM.md must contain ${section}`);
		}
	});

	it("contains execution protocol rules 1 through 5", () => {
		const content = readFileSync(APPEND_PATH, "utf-8");
		for (let i = 1; i <= 5; i++) {
			assert.ok(content.includes(`${i}. `), `APPEND_SYSTEM.md must contain rule number ${i}`);
		}
	});

	it("contains no repo-scoped policy (single-load, no repo policy in foreign repos)", () => {
		const content = readFileSync(APPEND_PATH, "utf-8");
		for (const marker of REPO_ONLY_MARKERS) {
			assert.ok(
				!content.includes(marker),
				`APPEND_SYSTEM.md must NOT contain repo-only marker '${marker}'`,
			);
		}
	});
});

describe("AGENTS.md — repo-scoped stub", () => {
	it("exists at repo root", () => {
		assert.ok(existsSync(AGENTS_PATH), `AGENTS.md not found at ${AGENTS_PATH}`);
	});

	it("retains TYPESCRIPT / npm run tsc:extensions directive", () => {
		const content = readFileSync(AGENTS_PATH, "utf-8");
		assert.ok(content.includes("tsc:extensions"), "stub must retain the tsc:extensions directive");
		assert.ok(content.includes("TYPESCRIPT"), "stub must retain the TYPESCRIPT directive");
	});

	it("retains GITHUB ISSUES / supervisor.repo directive", () => {
		const content = readFileSync(AGENTS_PATH, "utf-8");
		assert.ok(
			content.includes("supervisor.repo"),
			"stub must retain the supervisor.repo directive",
		);
	});

	it("retains TEMPORARY FILES / ignore/ directive", () => {
		const content = readFileSync(AGENTS_PATH, "utf-8");
		assert.ok(content.includes("ignore/"), "stub must retain the ignore/ temp-folder directive");
	});

	it("retains CRITICAL_OVERRIDES main-branch lock", () => {
		const content = readFileSync(AGENTS_PATH, "utf-8");
		assert.ok(
			content.includes("THE MAIN BRANCH IS LOCKED"),
			"stub must retain the main-branch lock",
		);
		assert.ok(
			content.includes("<CRITICAL_OVERRIDES>"),
			"stub must retain the CRITICAL_OVERRIDES block",
		);
	});

	it("points to the global file", () => {
		const content = readFileSync(AGENTS_PATH, "utf-8");
		assert.ok(
			content.includes("APPEND_SYSTEM.md"),
			"stub must point to the global APPEND_SYSTEM.md instructions",
		);
	});

	it("does NOT carry the global sections (single-load invariant — dedup is path-string, not realpath)", () => {
		const content = readFileSync(AGENTS_PATH, "utf-8");
		for (const section of GLOBAL_SECTIONS) {
			assert.ok(
				!content.includes(section),
				`stub AGENTS.md must NOT contain ${section} (would double-load in cheasee-pi workspaces)`,
			);
		}
	});
});
