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
});
