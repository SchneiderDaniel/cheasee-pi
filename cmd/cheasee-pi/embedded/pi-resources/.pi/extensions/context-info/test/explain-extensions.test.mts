/**
 * Tests for context-info/extensions.ts — extractJSDoc, listLocalExtensions
 *
 * Tests pure function extractJSDoc (no I/O) and command registration.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/explain-extensions.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { extractJSDoc } from "../extensions.ts";

// ---------------------------------------------------------------------------
// extractJSDoc — pure function, no I/O
// ---------------------------------------------------------------------------

describe("extractJSDoc", () => {
	it("extracts description from standard JSDoc block", () => {
		const content = `/**
 * My extension
 *
 * Does something useful.
 * More detail here.
 */
export function foo() {}`;
		const result = extractJSDoc(content);
		assert.strictEqual(result, "My extension\n\nDoes something useful.\nMore detail here.");
	});

	it("returns null for content without JSDoc", () => {
		const content = `// Just a comment
export function foo() {}`;
		const result = extractJSDoc(content);
		assert.strictEqual(result, null);
	});

	it("returns null for whitespace-only JSDoc", () => {
		const content = `/**   */\nexport function foo() {}`;
		const result = extractJSDoc(content);
		assert.strictEqual(result, null);
	});

	it("returns null for JSDoc with only whitespace and asterisks", () => {
		const content = `/**
 *
 * 
 */
export function foo() {}`;
		const result = extractJSDoc(content);
		assert.strictEqual(result, null);
	});

	it("returns null for single-line empty JSDoc", () => {
		const content = "/** */\nexport function foo() {}";
		const result = extractJSDoc(content);
		assert.strictEqual(result, null);
	});

	it("strips leading * from each line", () => {
		const content = `/**
 * Line one
 * Line two
   * Line three with indent
 */`;
		const result = extractJSDoc(content);
		assert.strictEqual(result, "Line one\nLine two\nLine three with indent");
	});

	it("preserves empty lines between content", () => {
		const content = `/**
 * First
 *
 * Third
 */`;
		const result = extractJSDoc(content);
		assert.strictEqual(result, "First\n\nThird");
	});

	it("handles JSDoc with @param and @returns tags", () => {
		const content = `/**
 * Counts all extensions
 * @returns number of extensions
 */
export function count() {}`;
		const result = extractJSDoc(content);
		assert.strictEqual(result, "Counts all extensions\n@returns number of extensions");
	});

	it("scans only first 40 lines; JSDoc after line 40 is ignored", () => {
		const lines: string[] = [];
		for (let i = 0; i < 42; i++) {
			lines.push("// line " + i);
		}
		lines.push("/** JSDoc after 40 lines */");
		const content = lines.join("\n");
		const result = extractJSDoc(content);
		assert.strictEqual(result, null);
	});

	it("handles JSDoc at very beginning of file", () => {
		const content = "/** Minimal JSDoc */\nexport function foo() {}";
		const result = extractJSDoc(content);
		assert.strictEqual(result, "Minimal JSDoc");
	});

	it("handles JSDoc with indentation before opening /**", () => {
		const content = "\t/**\n\t * Indented JSDoc\n\t */\nexport function foo() {}";
		const result = extractJSDoc(content);
		assert.strictEqual(result, "Indented JSDoc");
	});

	it("returns null for slash-star (non-JSDoc) comments", () => {
		const content = "/* Not a JSDoc */\nexport function foo() {}";
		const result = extractJSDoc(content);
		assert.strictEqual(result, null);
	});

	it("returns null for triple-asterisk (invalid JSDoc) comments", () => {
		const content = "/*** Not valid JSDoc */\nexport function foo() {}";
		const result = extractJSDoc(content);
		assert.strictEqual(result, null);
	});
});

// ---------------------------------------------------------------------------
// listLocalExtensions — reads from actual .pi/extensions/ directory
// ---------------------------------------------------------------------------

describe("listLocalExtensions", () => {
	it("returns array of ExtensionMeta with name and description", async () => {
		const { listLocalExtensions } = await import("../extensions.ts");
		const extensions = listLocalExtensions();
		assert.ok(Array.isArray(extensions));
		assert.ok(extensions.length > 0);

		for (const ext of extensions) {
			assert.ok(typeof ext.name === "string", `name should be string, got ${typeof ext.name}`);
			assert.ok(ext.name.length > 0, `name should not be empty`);
			assert.ok(typeof ext.filePath === "string", `filePath should be string for ${ext.name}`);
		}
	});

	it("each extension has description string or null", async () => {
		const { listLocalExtensions } = await import("../extensions.ts");
		const extensions = listLocalExtensions();
		for (const ext of extensions) {
			assert.ok(
				ext.description === null || typeof ext.description === "string",
				`description should be string or null for ${ext.name}`,
			);
		}
	});

	it("context-info extension is included in list", async () => {
		const { listLocalExtensions } = await import("../extensions.ts");
		const extensions = listLocalExtensions();
		const ci = extensions.find((e) => e.name === "context-info");
		assert.ok(ci, "context-info should be in the list");
		assert.ok(typeof ci!.description === "string", "context-info should have a JSDoc description");
	});

	it("no 'error' property on readable extensions", async () => {
		const { listLocalExtensions } = await import("../extensions.ts");
		const extensions = listLocalExtensions();
		for (const ext of extensions) {
			// Skip extensions without a JSDoc description — they are not standalone
			// readable extensions. Directory-based modules like lib/ have no index.ts
			// and correctly set error. Filtering here avoids false positives.
			if (ext.description === null && ext.error) continue;
			assert.ok(
				!("error" in ext) || ext.error === undefined,
				`${ext.name} should not have error property`,
			);
		}
	});
});
