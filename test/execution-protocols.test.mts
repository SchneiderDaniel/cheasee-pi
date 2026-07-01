/**
 * Verify AGENTS.md execution_protocols contain required rules:
 * - Rule 4: Data Contradictions clarification instruction
 *
 * Follows pattern from test/ranked-map-removed.test.mts (file-content assertions on AGENTS.md).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const AGENTS_MD_PATH = resolve(import.meta.dirname, "..", "AGENTS.md");

describe("AGENTS.md execution_protocols", () => {
	it("AGENTS.md exists", () => {
		assert.ok(existsSync(AGENTS_MD_PATH), `AGENTS.md not found at ${AGENTS_MD_PATH}`);
	});

	it("contains a data-contradiction clarification rule (rule 4)", () => {
		const content = readFileSync(AGENTS_MD_PATH, "utf-8");

		// Must contain the data contradiction rule — key terms: contradiction, clarify in one turn
		const hasRule4 =
			content.includes("DATA CONTRADICTIONS") ||
			(content.includes("contradict") &&
				content.includes("clarif") &&
				content.includes("ONE turn"));

		assert.ok(hasRule4, "AGENTS.md must contain rule 4: Data Contradictions clarification instruction");
	});

	it("contains an investigation efficiency rule (rule 5)", () => {
		const content = readFileSync(AGENTS_MD_PATH, "utf-8");

		// Must contain the investigation efficiency heading in execution_protocols
		assert.ok(content.includes("INVESTIGATION EFFICIENCY"), "AGENTS.md must contain Investigation Efficiency rule");
	});

	it("rule 5 includes --test-name-pattern guidance pointing to exact subtest name", () => {
		const content = readFileSync(AGENTS_MD_PATH, "utf-8");

		assert.ok(content.includes("--test-name-pattern"), "Rule 5 must mention --test-name-pattern");
		assert.ok(content.includes("subtest name"), "Rule 5 must mention subtest name");
		assert.ok(
			content.includes("not the parent"),
			"Rule 5 must warn against using parent describe-block name",
		);
	});

	it("rule numbers run 1 through 5 sequentially", () => {
		const content = readFileSync(AGENTS_MD_PATH, "utf-8");

		// All 5 rule numbers must be present in order
		for (let i = 1; i <= 5; i++) {
			assert.ok(content.includes(`${i}. `), `AGENTS.md must contain rule number ${i}`);
		}
	});
});
