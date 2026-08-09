/**
 * Verification tests for unused parameter removal (Issue #541).
 *
 * Confirms that:
 *   1. question-ui.ts no longer imports LabelValuePair
 *   2. renderScrollableDialog signature no longer has _labelToValue or _otherLabel
 *   3. renderChoiceDialog passes exactly 5 arguments to renderScrollableDialog
 *   4. renderChoiceDialog no longer references LabelValuePair (the type cast is gone)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/unused-params-removal.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const questionUiPath = path.resolve(__dirname, "../question-ui.ts");
const questionHandlerPath = path.resolve(__dirname, "../question-handler.ts");

describe("unused params removal — Issue #541", () => {
	// ── Phase 1 — question-ui.ts ────────────────────────────────────────────

	it("no longer imports LabelValuePair from question-ui.ts", () => {
		const content = fs.readFileSync(questionUiPath, "utf-8");
		const importLine = content.split("\n").find((line) => line.includes("LabelValuePair"));

		assert.ok(
			importLine === undefined,
			`Expected LabelValuePair import to be removed from question-ui.ts, but found: "${importLine?.trim()}"`,
		);
	});

	it("renderScrollableDialog signature omits _labelToValue and _otherLabel params", () => {
		const content = fs.readFileSync(questionUiPath, "utf-8");

		// Find the function declaration line(s)
		const lines = content.split("\n");

		// Check that no underscore-prefixed params remain in the signature
		const underscoreParamLine = lines.find(
			(line) =>
				line.includes("function renderScrollableDialog") ||
				(line.includes("_") &&
					line.includes(":") &&
					lines.indexOf(line) >
						lines.findIndex((l) => l.includes("function renderScrollableDialog"))),
		);

		// Look specifically for _labelToValue or _otherLabel anywhere in the file
		const hasLabelToValue = lines.some((line) => line.includes("_labelToValue"));
		const hasOtherLabel = lines.some((line) => line.includes("_otherLabel"));

		assert.ok(
			!hasLabelToValue,
			"Expected _labelToValue to be removed from question-ui.ts but it was found",
		);
		assert.ok(
			!hasOtherLabel,
			"Expected _otherLabel to be removed from question-ui.ts but it was found",
		);
	});

	// ── Phase 2 — question-handler.ts ───────────────────────────────────────

	it("renderChoiceDialog passes exactly 5 args to renderScrollableDialog", () => {
		const content = fs.readFileSync(questionHandlerPath, "utf-8");

		// Find the call to renderScrollableDialog inside renderChoiceDialog
		const lines = content.split("\n");
		const callLine = lines.find(
			(line) => line.includes("renderScrollableDialog(") && line.trim().startsWith("return"),
		);

		assert.ok(callLine !== undefined, "Expected to find a call to renderScrollableDialog");

		// Count the arguments by counting commas before the closing paren
		// The call is: renderScrollableDialog(tui, theme, done, question, items)
		// which has 5 args and 4 commas
		const callTrimmed = callLine.trim();
		// Extract the args part between renderScrollableDialog( and )
		const argsMatch = callTrimmed.match(/renderScrollableDialog\(([^)]*)\)/);
		assert.ok(argsMatch !== null, "Could not extract arguments from renderScrollableDialog call");

		const argsString = argsMatch[1]!;
		const argCount = argsString.split(",").length;

		assert.strictEqual(
			argCount,
			5,
			`Expected renderScrollableDialog to have 5 arguments, but found ${argCount}. Args: "${argsString}"`,
		);
	});

	it("renderChoiceDialog no longer references LabelValuePair type", () => {
		const content = fs.readFileSync(questionHandlerPath, "utf-8");

		// Find the renderChoiceDialog function
		const lines = content.split("\n");
		const funcStartIdx = lines.findIndex((line) => line.includes("function renderChoiceDialog"));

		// Find the end of renderChoiceDialog (next function or end of file)
		let funcEndIdx = lines.length;
		for (let i = funcStartIdx + 1; i < lines.length; i++) {
			if (lines[i]!.includes("function ") && !lines[i]!.includes("renderChoiceDialog")) {
				funcEndIdx = i;
				break;
			}
		}

		// Only check the renderChoiceDialog function body
		const funcBody = lines.slice(funcStartIdx, funcEndIdx).join("\n");

		const hasLabelValuePairCast = funcBody.includes("LabelValuePair");

		assert.ok(
			!hasLabelValuePairCast,
			"Expected LabelValuePair type cast to be removed from renderChoiceDialog, but it was found",
		);
	});

	it("LabelValuePair import remains in question-handler.ts (still used elsewhere)", () => {
		const content = fs.readFileSync(questionHandlerPath, "utf-8");
		const importLine = content.split("\n").find((line) => line.includes("LabelValuePair"));

		assert.ok(
			importLine !== undefined,
			"Expected LabelValuePair import to remain in question-handler.ts (used for labelToValue: LabelValuePair[])",
		);
	});
});
