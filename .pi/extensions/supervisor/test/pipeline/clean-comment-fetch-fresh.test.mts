// ─── Tests: clean-code comment deletion (issue #1536) ─────────────
// Rule 2 (self-documenting code): the what-comment "Fetch fresh issue
// data for this iteration" restates the call name fetchFreshIssueData +
// loopFilteredData, so it is deleted. Diff-scope static guards: the
// comment is gone, the call site is byte-identical, the import remains,
// and git diff against origin/main shows exactly one deleted line.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AGENT_LOOP_TS = resolve(__dirname, "../../pipeline/handler/agent-loop.ts");
const REL_AGENT_LOOP = ".pi/extensions/supervisor/pipeline/handler/agent-loop.ts";

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

describe("clean-code #1536 — git diff scope vs origin/main", () => {
	it("diff is exactly 0 insertions and 1 deletion, the sole removed line being the comment", () => {
		const numstat = execFileSync(
			"git",
			["diff", "--numstat", "origin/main", "--", REL_AGENT_LOOP],
			{
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const m = numstat.trim().match(/^(\d+)\s+(\d+)\s+.+$/);
		assert.ok(m, `unexpected numstat output: ${numstat}`);
		assert.equal(m[1], "0", `expected 0 insertions, got ${m[1]}`);
		assert.equal(m[2], "1", `expected 1 deletion, got ${m[2]}`);

		const u0 = execFileSync("git", ["diff", "-U0", "origin/main", "--", REL_AGENT_LOOP], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const removed = u0
			.split("\n")
			.filter((l) => l.startsWith("-") && !l.startsWith("---"))
			.map((l) => l.slice(1));
		assert.equal(removed.length, 1, `expected exactly 1 removed line, got ${removed.length}`);
		assert.equal(removed[0]!.trim(), COMMENT_LINE, `removed line was: ${removed[0]}`);
	});
});
