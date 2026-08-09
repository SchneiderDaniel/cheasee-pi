/**
 * Verification tests for dead code removal (Issue #452, Issue #709).
 *
 * Confirms that unused exports have been removed from `types.ts` and
 * that remaining schemas remain valid after the cleanup.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/dead-code-removal.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QnaReadParams } from "../types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typesPath = path.resolve(__dirname, "../types.ts");
const testFilePath = path.resolve(__dirname, "question-handler.test.mts");

describe("dead code removal — Issue #452", () => {
	it("no longer exports QuestionResult interface from types.ts", () => {
		const content = fs.readFileSync(typesPath, "utf-8");

		// The export keyword + QuestionResult must not appear in the file
		const exportLine = content.split("\n").find((line) => line.includes("QuestionResult"));

		assert.ok(
			exportLine === undefined,
			`Expected QuestionResult to be removed, but found: "${exportLine?.trim()}"`,
		);
	});

	it("no longer has duplicate QuestionResult interface in test file", () => {
		const content = fs.readFileSync(testFilePath, "utf-8");

		// The local interface definition (no export) must also be gone
		const interfaceLine = content
			.split("\n")
			.find((line) => line.includes("interface QuestionResult"));

		assert.ok(
			interfaceLine === undefined,
			`Expected QuestionResult interface to be removed from test file, but found: "${interfaceLine?.trim()}"`,
		);
	});
});

describe("dead code removal — Issue #709 (QnaReadAction)", () => {
	it("no longer exports QnaReadAction type from types.ts", () => {
		const content = fs.readFileSync(typesPath, "utf-8");

		// The export keyword + QnaReadAction must not appear in the file
		const exportLine = content.split("\n").find((line) => line.includes("QnaReadAction"));

		assert.ok(
			exportLine === undefined,
			`Expected QnaReadAction to be removed, but found: "${exportLine?.trim()}"`,
		);
	});

	it("QnaReadParams schema is still exported from types.ts", () => {
		// QnaReadParams should be a defined object after import
		assert.ok(QnaReadParams, "QnaReadParams should be defined");
		assert.strictEqual(typeof QnaReadParams, "object", "QnaReadParams should be an object");
	});

	it("QnaReadParams action property defines correct enum values", () => {
		// Verify the schema structure: action must be a string enum with list/get/query
		const props = QnaReadParams.properties as Record<string, unknown>;
		assert.ok(props.action, "QnaReadParams should have action property");

		const action = props.action as Record<string, unknown>;
		assert.strictEqual(action.type, "string", "action should be a string type");
		assert.ok(Array.isArray(action.enum), "action should have an enum array");
		assert.deepStrictEqual(
			action.enum,
			["list", "get", "query"],
			"action enum should contain list, get, query",
		);
	});

	it("QnaReadParams action enum rejects invalid values structurally", () => {
		// Verify the enum only contains the 3 valid values
		const props = QnaReadParams.properties as Record<string, unknown>;
		const action = props.action as Record<string, unknown>;
		const enumValues = action.enum as string[];
		assert.strictEqual(enumValues.length, 3, "Should have exactly 3 enum values");
		assert.ok(!enumValues.includes("delete"), "delete should not be in enum");
		assert.ok(!enumValues.includes(""), "empty string should not be in enum");
	});
});
