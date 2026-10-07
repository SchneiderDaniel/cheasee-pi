// ─── Tests: clean-code comment deletion (issue #1536) ─────────────
// Rule 2 (self-documenting code): the what-comment "Fetch fresh issue
// data for this iteration" restates the call name fetchFreshIssueData +
// loopFilteredData, so it is deleted. Static guards: the comment is gone,
// the call site is byte-identical, the import remains.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AGENT_LOOP_TS = resolve(__dirname, "../../pipeline/handler/agent-loop.ts");

const COMMENT_LINE = "// Fetch fresh issue data for this iteration";

// Expected call block verbatim: 2-tab call, 3-tab args, 2-tab closing `);`.
const EXPECTED_CALL = [
	"\t\tconst loopFilteredData = await fetchFreshIssueData(",
	"\t\t\texec,",
	"\t\t\tconfig,",
	"\t\t\tissueNum,",
	"\t\t\tissueData,",
	"\t\t\tcollector,",
	"\t\t);",
].join("\n");

describe("clean-code #1536 — redundant what-comment removed", () => {
	it("agent-loop.ts contains neither the comment nor its text", () => {
		const src = readFileSync(AGENT_LOOP_TS, "utf-8");
		assert.ok(!src.includes(COMMENT_LINE), "comment line still present in agent-loop.ts");
		assert.ok(
			!src.includes("Fetch fresh issue data for this iteration"),
			"comment text still present in agent-loop.ts",
		);
	});

	it("fetchFreshIssueData call site is byte-identical (error behavior preserved)", () => {
		const src = readFileSync(AGENT_LOOP_TS, "utf-8");
		assert.ok(
			src.includes(EXPECTED_CALL),
			"expected fetchFreshIssueData call block not found verbatim",
		);
	});

	it("fetchFreshIssueData import on line 55 is still present", () => {
		const src = readFileSync(AGENT_LOOP_TS, "utf-8");
		assert.ok(
			src.includes(
				'import { fetchFreshIssueData, loadAgentFile as loadAgentFileHelper } from "../helpers.ts";',
			),
			"fetchFreshIssueData import line removed — breaks the build",
		);
	});
});
