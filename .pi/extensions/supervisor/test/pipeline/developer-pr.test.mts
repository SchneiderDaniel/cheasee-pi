// ─── Tests: developer PR upsert stage — source pins (issue #1827) ─
// Ordering and router pins (AC1/AC4): the call order inside the agent
// loop, the router shape of the post-agent stage, the barrel's explicit
// re-export, and the developer agent contract.
//
// Behavioural coverage lives in developer-pr-upsert.test.mts (the stage)
// and developer-pr-wiring.test.mts (the wiring).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Structural pins ─────────────────────────────────────────────

const SUPERVISOR_DIR = join(__dirname, "../..");

function read(relPath: string): string {
	return readFileSync(join(SUPERVISOR_DIR, relPath), "utf-8");
}

describe("ordering + router pins (AC1)", () => {
	it("agent-loop.ts calls handlePostAgentSuccess before runPreTransitionHooks", () => {
		const src = read("pipeline/handler/agent-loop.ts");
		const postIdx = src.indexOf("handlePostAgentSuccess(");
		const gateIdx = src.indexOf("runPreTransitionHooks(");
		assert.ok(postIdx >= 0, "handlePostAgentSuccess call present");
		assert.ok(gateIdx >= 0, "runPreTransitionHooks call present");
		assert.ok(postIdx < gateIdx, "PR upsert runs before the pre-audit gates");
	});

	it("handlePostAgentSuccess delegates the upsert and stays a router", () => {
		const src = read("pipeline/stages/post-agent-success.ts");
		assert.ok(src.includes("upsertDeveloperPr"), "upsert delegated to the stage");
		const devBranchIdx = src.indexOf('agentName === "developer"');
		const upsertIdx = src.indexOf("await upsertDeveloperPr(");
		assert.ok(devBranchIdx >= 0 && upsertIdx > devBranchIdx, "upsert inside the developer branch");
		for (const forbidden of [
			"listPullRequestsForBranch",
			"createPullRequest",
			"buildPipelineSummary",
		]) {
			assert.ok(!src.includes(forbidden), `router must not reference ${forbidden}`);
		}
	});

	it("stages barrel re-exports upsertDeveloperPr explicitly", () => {
		const src = read("pipeline/stages/index.ts");
		assert.ok(src.includes("upsertDeveloperPr"), "barrel exports the stage");
		assert.ok(!src.includes("export *"), "no wildcard re-exports");
	});

	it("developer agent contract unchanged (AC4)", () => {
		const src = read("agents/developer.md");
		assert.ok(src.includes("**NEVER**"));
		assert.ok(src.includes("create pull requests"));
		assert.ok(src.includes("do NOT run git commands"));
	});
});
