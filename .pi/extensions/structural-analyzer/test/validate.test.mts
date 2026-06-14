/**
 * Tests: validate.ts — pattern validation
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { validatePattern } from "../validate.ts";

describe("validatePattern", () => {
	it("rejects single word 'TODO' (collision rule)", () => {
		assert.notStrictEqual(validatePattern("TODO"), null);
		assert.ok(validatePattern("TODO")!.includes("ripgrep"), "Error should mention ripgrep");
	});

	it("rejects single identifier 'verify_token'", () => {
		assert.notStrictEqual(validatePattern("verify_token"), null);
		assert.ok(validatePattern("verify_token")!.includes("ripgrep"));
	});

	it("rejects empty string", () => {
		assert.notStrictEqual(validatePattern(""), null);
	});

	it("rejects whitespace-only string", () => {
		assert.notStrictEqual(validatePattern("   "), null);
	});

	it("rejects null input", () => {
		assert.notStrictEqual(validatePattern(null as unknown as string), null);
		assert.ok(validatePattern(null as unknown as string)!.includes("non-empty"));
	});

	it("rejects undefined input", () => {
		assert.notStrictEqual(validatePattern(undefined as unknown as string), null);
		assert.ok(validatePattern(undefined as unknown as string)!.includes("non-empty"));
	});

	it("accepts pattern with $ meta variable: console.log($A)", () => {
		assert.strictEqual(validatePattern("console.log($A)"), null);
	});

	it("accepts try/catch pattern with $$$BODY and $A", () => {
		assert.strictEqual(validatePattern("try { $$$BODY } catch (e) { $A }"), null);
	});

	it("accepts function pattern with parentheses and $", () => {
		assert.strictEqual(validatePattern("function($A, $B)"), null);
	});

	it("accepts class pattern with $", () => {
		assert.strictEqual(validatePattern("class $NAME"), null);
	});

	it("accepts single word with structural char like {x}", () => {
		assert.strictEqual(validatePattern("{x}"), null);
	});

	it("accepts pattern with only $", () => {
		assert.strictEqual(validatePattern("$"), null);
	});
});
