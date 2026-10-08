// ─── Tests: agent-loop issue refresh import edge (issue #1866) ─────
// The former byte-identical call-site and git-diff scope guards asserted
// source text; the import edge is the structural invariant worth keeping.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph } from "../../../lib/test/source-graph.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_LOOP_STEPS_TS = resolve(__dirname, "../../pipeline/handler/agent-loop-steps.ts");

describe("agent-loop steps — fetch fresh issue data import edge", () => {
	it("consumes fetchFreshIssueData from ../helpers.ts", () => {
		const graph = readGraph(AGENT_LOOP_STEPS_TS);
		assert.ok(
			graph.importedNames.includes("fetchFreshIssueData"),
			"fetchFreshIssueData imported by the agent loop steps",
		);
		assert.ok(graph.specifiers.includes("../helpers.ts"), "imported from ../helpers.ts");
	});
});
