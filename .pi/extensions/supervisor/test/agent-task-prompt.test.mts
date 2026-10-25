// ─── Task prompt + issue summary (issue #2033 split) ────────────────
// `buildAgentTask` keeps the orchestration; prompt rendering moved to
// `agent/task-prompt.ts` and issue summarisation to `agent/issue-summary.ts`.
// These pin the moved contracts, including the auditor checklist verbatim.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAuditChecklist, buildSystemPromptSection } from "../agent/task-prompt.ts";
import { hasDockerfileRelevance, summarizeComments } from "../agent/issue-summary.ts";

describe("buildSystemPromptSection", () => {
	it("emits nothing without options or content", () => {
		assert.equal(buildSystemPromptSection(), "");
		assert.equal(buildSystemPromptSection({}), "");
		assert.equal(buildSystemPromptSection({ selectedTools: [], skills: [], contextFiles: [] }), "");
	});

	it("renders the active tool list", () => {
		const section = buildSystemPromptSection({ selectedTools: ["read", "bash"] });
		assert.match(section, /## Available Tools/);
		assert.match(section, /\*\*Tools:\*\* read, bash/);
	});
});

describe("buildAuditChecklist", () => {
	it("keeps the eleven dimension lines verbatim and in order", () => {
		const lines = buildAuditChecklist(11).split("\n");
		assert.equal(lines.length, 11);
		assert.deepEqual(lines.slice(0, 7), [
			"Architecture compliance: ✓",
			"Ticket fulfillment: ✓",
			"Tests passed: ✓",
			"Test quality: ✓",
			"Correctness & Safety: ✓",
			"Code quality: ✓",
			"Completeness: ✓",
		]);
		assert.match(lines[7]!, /^Duplicate code: /);
		assert.match(lines[8]!, /^Dead code: /);
		assert.match(lines[9]!, /^Package safety: /);
		assert.match(lines[10]!, /^Research incorporation: /);
	});
});

describe("hasDockerfileRelevance", () => {
	it("matches whole words only", () => {
		assert.equal(hasDockerfileRelevance("t", "installation guide"), false);
		assert.equal(hasDockerfileRelevance("add a tool", ""), true);
	});
});

describe("summarizeComments", () => {
	it("states the absence of comments", () => {
		assert.equal(summarizeComments([]), "(no trusted comments)");
	});

	it("labels each comment verbatim, in order", () => {
		const out = summarizeComments([
			{ author: "a", body: "first" },
			{ author: "b", body: "second" },
		]);
		assert.equal(out, "--- Comment #1 by @a ---\nfirst\n\n--- Comment #2 by @b ---\nsecond");
	});
});
