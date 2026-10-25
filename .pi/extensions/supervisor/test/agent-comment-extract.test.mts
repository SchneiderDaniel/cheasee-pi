// ─── Agent comment body extraction (issue #2033 split) ──────────────
// `extractAgentCommentBody` moved out of `agent/output.ts` so the parser is
// imported one way (no ESM cycle). `parseAgentOutput` stays the facade.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAgentCommentBody } from "../agent/comment-extract.ts";
import { getRefusalInfo, parseAgentOutput } from "../agent/output.ts";

describe("getRefusalInfo", () => {
	it("returns null for a successful payload", () => {
		assert.equal(
			getRefusalInfo('```json\n{"action":"COMPLETE","agentName":"developer"}\n```'),
			null,
		);
	});

	it("returns the refusal with its reason", () => {
		const info = getRefusalInfo(
			'```json\n{"refusal":"the worktree is missing a lock file","commentBody":"blocked"}\n```',
		);
		assert.notEqual(info, null);
		assert.equal(info?.refusal, "the worktree is missing a lock file");
	});
});

describe("extractAgentCommentBody", () => {
	it("prefers the structured commentBody", () => {
		assert.equal(
			extractAgentCommentBody(
				'```json\n{"action":"COMPLETE","agentName":"developer","commentBody":"## Notes"}\n```',
			),
			"## Notes",
		);
	});

	it("falls back to the COMMENT_BODY markers", () => {
		const out = "COMMENT_BODY:\n## From markers\nCOMMENT_BODY_END";
		assert.equal(extractAgentCommentBody(out), "## From markers");
	});

	it("returns null when no body is present", () => {
		assert.equal(extractAgentCommentBody("just prose, no payload"), null);
	});

	it("does not re-shape a non-blank refusal body", () => {
		assert.equal(
			extractAgentCommentBody('```json\n{"refusal":"nope","commentBody":"  keep me  "}\n```'),
			"  keep me  ",
		);
	});
});

describe("parseAgentOutput", () => {
	it("is still exported from the output facade", () => {
		assert.equal(typeof parseAgentOutput, "function");
	});
});
