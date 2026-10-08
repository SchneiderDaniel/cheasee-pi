/**
 * Tests: Removal of dead constant `MAX_TASK_PREVIEW_CHARS`.
 *
 * `session/message-renderers/constants.ts` exported `MAX_TASK_PREVIEW_CHARS`
 * with zero production consumers; its only guard restated the assignment
 * literal. Verifies the constant and that guard are gone, the two live
 * constants and their consumers survive, and the header names both consumers.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-max-task-preview-chars-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
	return readFileSync(resolve(ROOT, relativePath), "utf8");
}

function filesUnder(relativeDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(full);
		}
	};
	walk(resolve(ROOT, relativeDir));
	return out;
}

describe("session/message-renderers/constants.ts — dead MAX_TASK_PREVIEW_CHARS removed", () => {
	const source = readSource("session/message-renderers/constants.ts");

	it("no longer contains MAX_TASK_PREVIEW_CHARS token", () => {
		assert.equal(
			source.includes("MAX_TASK_PREVIEW_CHARS"),
			false,
			"MAX_TASK_PREVIEW_CHARS must be deleted from constants.ts",
		);
	});

	it("remaining exports survive verbatim", () => {
		assert.equal(source.includes("export const MAX_EXPANDED_TOOL_CALLS = 30;"), true);
		assert.equal(source.includes("export const MAX_NESTED_CALLS = 30;"), true);
	});

	it("header no longer claims a single source of truth and names both consumers", () => {
		assert.equal(source.includes("Single source of truth"), false);
		assert.equal(source.includes("MAX_EXPANDED_TOOL_CALLS"), true);
		assert.equal(source.includes("MAX_NESTED_CALLS"), true);
	});
});

describe("MAX_TASK_PREVIEW_CHARS — gone repo-wide under session/ and event/", () => {
	for (const dir of ["session", "event"]) {
		const offenders = filesUnder(dir).filter(
			(f) => f.endsWith(".ts") && readFileSync(f, "utf8").includes("MAX_TASK_PREVIEW_CHARS"),
		);
		it(`no production file under ${dir}/ references it`, () => {
			assert.deepEqual(offenders, []);
		});
	}
});

describe("live caps keep their consumers", () => {
	it("render-subagent.ts slices and detects overflow against MAX_EXPANDED_TOOL_CALLS", () => {
		const source = readSource("session/message-renderers/render-subagent.ts");
		assert.match(source, /\.slice\(0, MAX_EXPANDED_TOOL_CALLS\)/);
		assert.match(source, /details\.toolCalls\.length > MAX_EXPANDED_TOOL_CALLS/);
	});

	it("event/adapter/handlers.ts cap-checks against MAX_NESTED_CALLS", () => {
		const source = readSource("event/adapter/handlers.ts");
		assert.match(source, /calls\.length < MAX_NESTED_CALLS/);
	});
});

describe("test/message-renderers.test.mts — tautological constants block removed", () => {
	const source = readSource("test/message-renderers.test.mts");

	it("no longer imports or asserts MAX_TASK_PREVIEW_CHARS", () => {
		assert.equal(source.includes("MAX_TASK_PREVIEW_CHARS"), false);
	});

	it("no longer restates MAX_EXPANDED_TOOL_CALLS's own declaration", () => {
		assert.equal(source.includes("assert.equal(MAX_EXPANDED_TOOL_CALLS, 30)"), false);
	});
});
