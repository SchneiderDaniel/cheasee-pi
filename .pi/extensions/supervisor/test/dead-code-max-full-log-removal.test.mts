/**
 * Tests: Removal of dead constant `MAX_FULL_LOG` from event/adapter/handlers.ts
 *
 * `handlers.ts` declared a module-private `const MAX_FULL_LOG = 500` but never
 * referenced it. The live constant lives in agent/state-helpers.ts and is the
 * sole owner of the log-cap invariant via `pushLog()`.
 *
 * Verifies:
 *   - `MAX_FULL_LOG` no longer appears in event/adapter/handlers.ts
 *   - `MAX_ARGS_STRING_LEN` and its consumer `truncateArgsForDisplay` survive
 *   - `phasePriority` survives
 *   - the live `MAX_FULL_LOG` in agent/state-helpers.ts is unchanged and still
 *     referenced inside `pushLog`
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-max-full-log-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", relativePath);
	return readFileSync(path, "utf8");
}

describe("event/adapter/handlers.ts — dead MAX_FULL_LOG removed", () => {
	const source = readSource("event/adapter/handlers.ts");

	it("MAX_FULL_LOG is no longer present in handlers.ts", () => {
		assert.equal(
			source.includes("MAX_FULL_LOG"),
			false,
			"MAX_FULL_LOG must be deleted from handlers.ts",
		);
	});

	it("MAX_ARGS_STRING_LEN is still declared (live const)", () => {
		assert.equal(
			source.includes("const MAX_ARGS_STRING_LEN = 100;"),
			true,
			"MAX_ARGS_STRING_LEN must be kept",
		);
	});

	it("truncateArgsForDisplay still references MAX_ARGS_STRING_LEN", () => {
		assert.match(
			source,
			/value\.length > MAX_ARGS_STRING_LEN/,
			"truncateArgsForDisplay must keep its MAX_ARGS_STRING_LEN usage",
		);
	});

	it("handlers.ts still defines truncateArgsForDisplay and phasePriority", () => {
		assert.equal(source.includes("function truncateArgsForDisplay("), true);
		assert.equal(source.includes("function phasePriority("), true);
	});
});

describe("agent/state-helpers.ts — live MAX_FULL_LOG preserved", () => {
	const source = readSource("agent/state-helpers.ts");

	it("exports the live MAX_FULL_LOG = 500", () => {
		assert.equal(
			source.includes("export const MAX_FULL_LOG = 500;"),
			true,
			"the live constant must remain in state-helpers.ts",
		);
	});

	it("MAX_FULL_LOG is still referenced inside pushLog", () => {
		const pushLogSection = source.slice(source.indexOf("function pushLog"));
		assert.match(
			pushLogSection,
			/state\.fullLog\.length > MAX_FULL_LOG/,
			"pushLog must keep its MAX_FULL_LOG cap check",
		);
	});
});
