/**
 * Verify zzz-dump-context attributes the global APPEND_SYSTEM.md append
 * (#1517) to its own section instead of folding it into the base prompt.
 *
 * pi concatenates the append (installed globally as ~/.pi/agent/APPEND_SYSTEM.md)
 * as bare text immediately after the base prompt, before <project_context>.
 * The first line of APPEND_SYSTEM.md is an H1 anchor that splitSections uses
 * as the split seam.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { splitSections, findPromptDupes } from "../index.ts";

const APPEND_SECTION_LABEL = "System prompt append (APPEND_SYSTEM.md)";

/** Minimal assembled-prompt fixture mirroring pi's buildSystemPrompt order:
 *  base → append (bare text) → <project_context> → skills → cwd → injections. */
function fixture(): string {
	const base = [
		"You are pi, an autonomous coding agent.",
		"Follow the system directives.",
		"",
	].join("\n");
	const append = [
		"# Global Cheasee-Pi Operating Instructions",
		"",
		"<system_role>",
		"  You are Cheasee-Pi, an autonomous coding agent.",
		"</system_role>",
		"",
		"<tool_routing_matrix>",
		"- IF searching literal text -> USE `ripgrep_search`",
		"</tool_routing_matrix>",
		"",
	].join("\n");
	const ctx = [
		"<project_context>",
		'<project_instructions path="AGENTS.md">',
		"Repository-specific directives only.",
		"</project_instructions>",
		"</project_context>",
	].join("\n");
	const skills = [
		"<available_skills>",
		"<skill><name>writing-voice</name></skill>",
		"</available_skills>",
	].join("\n");
	const cwd = "Current working directory: /workspaces/main";
	const injections = [
		"## Caveman Mode",
		"LEVEL: full",
		"## Past Session Lessons",
		"- lesson one",
	].join("\n");

	return [base, append, ctx, skills, cwd, injections].join("\n");
}

describe("dump-context append attribution", () => {
	it("splits the append into its own section on the H1 anchor", () => {
		const sections = splitSections(fixture());
		const labels = sections.map((s) => s.label);

		const appendSection = sections.find((s) => s.label === APPEND_SECTION_LABEL);
		assert.ok(appendSection, `append must get its own section (labels: ${labels.join(", ")})`);
		assert.ok(
			appendSection.body.includes("<system_role>"),
			"append section must carry the append content (system_role present)",
		);
		assert.ok(
			appendSection.body.includes("<tool_routing_matrix>"),
			"append section must carry the tool-routing matrix",
		);
	});

	it("does not fold the append into the base prompt", () => {
		const sections = splitSections(fixture());
		const baseSection = sections.find((s) => s.label === "Base system prompt");
		assert.ok(baseSection, "base prompt section must exist");
		assert.ok(
			!baseSection.body.includes("Global Cheasee-Pi Operating Instructions"),
			"base section must not contain append content",
		);
		assert.ok(
			!baseSection.body.includes("<system_role>"),
			"base section must not contain append content",
		);
	});

	it("orders sections base → append → project context → skills → cwd → injections", () => {
		const labels = splitSections(fixture()).map((s) => s.label);
		const expectedOrder = [
			"Base system prompt",
			APPEND_SECTION_LABEL,
			"Project context",
			"Skills",
			"Working directory",
			"Extension injections",
		];
		assert.deepStrictEqual(labels, expectedOrder);
	});

	it("reports no duplicate 80-char blocks for the single-loaded fixture", () => {
		const dups = findPromptDupes(fixture());
		assert.deepStrictEqual(dups, [], "single-loaded append must not produce duplicate blocks");
	});

	it("falls back to base-only attribution when no append is present", () => {
		const full = fixture();
		// Strip the whole append block (H1 anchor through <project_context>)
		const start = full.indexOf("# Global Cheasee-Pi Operating Instructions");
		const end = full.indexOf("<project_context>");
		const withoutAppend = full.slice(0, start) + full.slice(end);
		const sections = splitSections(withoutAppend);
		assert.ok(
			!sections.some((s) => s.label === APPEND_SECTION_LABEL),
			"no append section when no append text present",
		);
		assert.ok(
			sections.some((s) => s.label === "Base system prompt"),
			"base prompt section must still exist",
		);
	});
});
