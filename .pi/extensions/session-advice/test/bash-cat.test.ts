/**
 * Tests for waste-signals/bash-cat.ts — detectBashCat
 *
 * Pure function: known input → expected WasteSignal[].
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/bash-cat.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectBashCat } from "../waste-signals/bash-cat.ts";
import { makeSession, bashEntry } from "./session-test-helpers.ts";

describe("detectBashCat", () => {
	it("flags 'cat file.ts' → 1 bash-cat signal", () => {
		assert.strictEqual(
			detectBashCat(makeSession([bashEntry("cat file.ts", 0)])).length,
			1,
			"bash cat should be flagged",
		);
		assert.strictEqual(
			detectBashCat(makeSession([bashEntry("cat file.ts", 0)]))[0].signal,
			"bash-cat",
		);
	});

	it("flags 'head -n 20 file.ts'", () => {
		assert.strictEqual(
			detectBashCat(makeSession([bashEntry("head -n 20 file.ts", 0)])).length,
			1,
			"head should be flagged",
		);
	});

	it("flags 'tail -f file.ts'", () => {
		const data = makeSession([bashEntry("tail -f file.ts", 0)]);
		assert.strictEqual(detectBashCat(data).length, 1, "tail should be flagged");
	});

	it("does NOT flag 'npm test'", () => {
		assert.strictEqual(detectBashCat(makeSession([bashEntry("npm test", 0)])).length, 0);
	});

	it("does NOT flag 'node build.js'", () => {
		const data = makeSession([bashEntry("node build.js", 0)]);
		assert.strictEqual(detectBashCat(data).length, 0);
	});

	it("does NOT flag 'grep foo file.ts' (not a file read)", () => {
		const data = makeSession([bashEntry("grep foo file.ts", 0)]);
		assert.strictEqual(detectBashCat(data).length, 0, "grep is not a file read");
	});

	it("multiple cat calls → 1 signal with occurrences = count", () => {
		const data = makeSession([
			bashEntry("cat file-a.ts", 0),
			bashEntry("cat file-b.ts", 1),
			bashEntry("cat file-c.ts", 2),
		]);
		assert.strictEqual(detectBashCat(data).length, 1, "should produce 1 aggregated signal");
		assert.strictEqual(detectBashCat(data)[0].occurrences, 3);
	});

	it("empty session → 0 signals", () => {
		assert.strictEqual(detectBashCat(makeSession([])).length, 0);
	});
});
