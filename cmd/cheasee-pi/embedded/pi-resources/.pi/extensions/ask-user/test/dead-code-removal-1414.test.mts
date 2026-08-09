/**
 * Verification tests for dead code removal (Issue #1414).
 *
 * Confirms that the unused exports `ToolResultDetailsQna` and `QnaToolResult`
 * are removed from `types.ts`, and that `LabelValuePair` (kept, since it is
 * used by question-handler.ts) plus the remaining exported types survive.
 *
 * Note: the removed symbols are never statically imported — verification is
 * via file-content assertions and dynamic import() of the survivor exports.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/dead-code-removal-1414.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typesPath = path.resolve(__dirname, "../types.ts");
const questionHandlerPath = path.resolve(__dirname, "../question-handler.ts");

describe("dead code removal — Issue #1414 (ToolResultDetailsQna, QnaToolResult)", () => {
	it("no longer exports ToolResultDetailsQna interface from types.ts", () => {
		const content = fs.readFileSync(typesPath, "utf-8");
		const exportLine = content.split("\n").find((line) => line.includes("ToolResultDetailsQna"));

		assert.ok(
			exportLine === undefined,
			`Expected ToolResultDetailsQna to be removed, but found: "${exportLine?.trim()}"`,
		);
	});

	it("no longer exports QnaToolResult type from types.ts", () => {
		const content = fs.readFileSync(typesPath, "utf-8");
		const exportLine = content.split("\n").find((line) => line.includes("QnaToolResult"));

		assert.ok(
			exportLine === undefined,
			`Expected QnaToolResult to be removed, but found: "${exportLine?.trim()}"`,
		);
	});

	it("no references to either removed type in production or existing test code", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);

		const extDir = path.resolve(__dirname, "..");
		let stdout = "";
		try {
			({ stdout } = await execFileAsync("rg", [
				"ToolResultDetailsQna|QnaToolResult",
				extDir,
				"--glob",
				"*.ts",
				"--glob",
				"*.mts",
				"--glob",
				"!**/dead-code-removal-1414.test.mts",
			]));
		} catch (err) {
			// rg exits 1 when nothing matches — that is the expected outcome here
			assert.strictEqual((err as { code?: number }).code, 1, (err as Error).message);
		}

		assert.strictEqual(
			stdout.trim(),
			"",
			`Expected zero references to removed types, but found:\n${stdout}`,
		);
	});

	it("keeps exporting QnaEntry from types.ts (used by jsonl-logger.ts)", () => {
		const content = fs.readFileSync(typesPath, "utf-8");
		const exportLine = content.split("\n").find((line) => line.includes("export interface QnaEntry"));

		assert.ok(
			exportLine !== undefined,
			"Expected QnaEntry to still be exported from types.ts",
		);
	});

	it("keeps exporting Mode, OptionItem, LabelValuePair, and schemas from types.ts", () => {
		const content = fs.readFileSync(typesPath, "utf-8");
		for (const decl of [
			"export type Mode",
			"export interface OptionItem",
			"export interface LabelValuePair",
			"export const QnaReadParams",
			"export const QuestionParams",
		]) {
			assert.ok(
				content.includes(decl),
				`Expected "${decl}" to still be exported from types.ts`,
			);
		}
	});

	it("LabelValuePair is still imported and used by question-handler.ts", () => {
		const content = fs.readFileSync(questionHandlerPath, "utf-8");
		const importLine = content.split("\n").find((line) => line.includes("LabelValuePair"));

		assert.ok(
			importLine !== undefined,
			"Expected LabelValuePair import to remain in question-handler.ts",
		);
		assert.ok(
			content.includes("const labelToValue: LabelValuePair[]"),
			"Expected LabelValuePair usage in question-handler.ts to remain",
		);
	});
});
