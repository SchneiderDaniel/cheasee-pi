/**
 * Verify zzz-dump-context captures the working-directory line whole, even when
 * the cwd path contains whitespace (space/tab) — issue #1619.
 *
 * splitSections() used to extract the cwd with /Current working directory: \S+/,
 * which cannot span spaces: a cwd like /workspaces/My Project captured only
 * /workspaces/My and left " Project" to leak into the following section.
 *
 * The fix anchors the label to column 0 as a standalone line and captures to
 * end-of-line, so the whole path is captured and the line is removed cleanly.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { splitSections } from "../index.ts";

const APPEND_SECTION_LABEL = "System prompt append (APPEND_SYSTEM.md)";
const BASE_SECTION_LABEL = "Base system prompt";
const CWD_SECTION_LABEL = "Working directory";

/** Assembled-prompt fixture mirroring pi's buildSystemPrompt order:
 *  base → append (bare text) → <project_context> → skills → cwd → injections.
 *  The cwd line and presence of injections are parameterized. */
function fixture(opts: { cwd: string; injections?: boolean }): string {
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
	const injections = [
		"## Caveman Mode",
		"LEVEL: full",
		"## Past Session Lessons",
		"- lesson one",
	].join("\n");

	const parts = [base, append, ctx, skills, opts.cwd];
	if (opts.injections !== false) parts.push(injections);
	return parts.join("\n");
}

function cwdBody(sections: ReturnType<typeof splitSections>): string | undefined {
	return sections.find((s) => s.label === CWD_SECTION_LABEL)?.body;
}

describe("dump-context cwd attribution (spaced paths)", () => {
	it("captures a spaced cwd whole with no tail leak into other sections", () => {
		const cwdLine = "Current working directory: /workspaces/My Project";
		const sections = splitSections(fixture({ cwd: cwdLine }));

		assert.strictEqual(cwdBody(sections), cwdLine, "cwd body must be the full label line");

		for (const s of sections) {
			if (s.label === CWD_SECTION_LABEL) continue;
			assert.ok(
				!s.body.includes("Project"),
				`path tail "Project" leaked into ${s.label} section: …${s.body.slice(-80)}`,
			);
		}
	});

	it("keeps the section count and order unchanged for a spaced cwd", () => {
		const labels = splitSections(
			fixture({ cwd: "Current working directory: /workspaces/My Project" }),
		).map((s) => s.label);
		assert.deepStrictEqual(labels, [
			BASE_SECTION_LABEL,
			APPEND_SECTION_LABEL,
			"Project context",
			"Skills",
			CWD_SECTION_LABEL,
			"Extension injections",
		]);
	});

	it("captures a tab-and-space cwd verbatim", () => {
		const cwdLine = "Current working directory: /home/user/My\tTabbed Project";
		const sections = splitSections(fixture({ cwd: cwdLine }));
		assert.strictEqual(cwdBody(sections), cwdLine);
		for (const s of sections) {
			if (s.label === CWD_SECTION_LABEL) continue;
			assert.ok(!s.body.includes("Tabbed"), `path tail leaked into ${s.label} section`);
		}
	});

	it("captures a Windows spaced path whole", () => {
		const cwdLine = "Current working directory: C:\\Program Files\\pi agent";
		const sections = splitSections(fixture({ cwd: cwdLine }));
		assert.strictEqual(cwdBody(sections), cwdLine);
	});

	it("captures a cwd on the final line with no trailing newline", () => {
		const cwdLine = "Current working directory: /workspaces/My Project";
		const sections = splitSections(fixture({ cwd: cwdLine, injections: false }));
		assert.strictEqual(cwdBody(sections), cwdLine);
	});
});

describe("dump-context cwd column-0 contract (boundaries)", () => {
	it("does not extract an indented label, keeping the line intact in rest", () => {
		const cwdLine = "  Current working directory: /a b";
		const sections = splitSections(fixture({ cwd: cwdLine }));

		assert.strictEqual(cwdBody(sections), undefined, "indented label must not yield a cwd section");
		const append = sections.find((s) => s.label === APPEND_SECTION_LABEL);
		assert.ok(append, "append section must still exist");
		assert.ok(
			append.body.includes(cwdLine),
			"indented label line must remain intact in the rest-attributed section",
		);
	});

	it("does not let a mid-line prose occurrence hijack extraction", () => {
		const base = [
			"You are pi, an autonomous coding agent.",
			"See how prompts are reported in Current working directory: /x y dumps for details.",
			"Follow the system directives.",
			"",
		].join("\n");
		const full = fixture({ cwd: "Current working directory: /workspaces/My Project" });
		// Replace the base block with the prose-bearing base
		const oldBase = "You are pi, an autonomous coding agent.\nFollow the system directives.";
		const sections = splitSections(full.replace(oldBase, base.trimEnd()));

		assert.strictEqual(
			cwdBody(sections),
			"Current working directory: /workspaces/My Project",
			"real column-0 label must be extracted whole",
		);
		const baseSection = sections.find((s) => s.label === BASE_SECTION_LABEL);
		assert.ok(baseSection, "base section must exist");
		assert.ok(
			baseSection.body.includes("Current working directory: /x y dumps"),
			"prose occurrence must remain verbatim in its section",
		);
	});

	it("does not match an empty path (no regression) and leaves the line intact", () => {
		const cwdLine = "Current working directory: ";
		const sections = splitSections(fixture({ cwd: cwdLine }));

		assert.strictEqual(cwdBody(sections), undefined, "empty path must not yield a cwd section");
		const carriesLine = sections.some((s) => s.body.includes(cwdLine.trim()));
		assert.ok(carriesLine, "empty-path label line must remain intact in rest content");
	});
});
