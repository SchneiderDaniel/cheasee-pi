/**
 * `on_message` liveness against the real UI sources (issue #2089).
 *
 * CodeFlow reports `on_message` as dead in `ui/src/ws.rs` and
 * `ui/src/retry/tests_wiring.rs`. The finding is a false positive: the call
 * site lives in `retry/wiring.rs` and dispatches through a generic `S: Socket`
 * bound, which text analysis does not resolve. The synthetic fixture in
 * `test/codeflow-fp-filter.test.mts` pins the filter rule; this file pairs it
 * with the real files, so the rule is proven against the tree that ships — and
 * fails if the real trait name or the real call site drifts away from what the
 * filter needs.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-on-message-liveness.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FILTER = resolve(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");

type Suppressed = { deadCode: unknown[] } & Record<string, unknown[]>;

const { sanitizeAnalysisData, readFileFrom } = createRequire(import.meta.url)(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
	) => { data: any; suppressed: Suppressed };
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
};

// Paths exactly as the CodeFlow report records them, so the filter resolves the
// same references the analyzer's own file set would.
const UI_SRC = "cmd/cheasee-pi/embedded/docker/ui/src";
const WS = `${UI_SRC}/ws.rs`;
const RETRY = `${UI_SRC}/retry.rs`;
const WIRING = `${UI_SRC}/retry/wiring.rs`;
const TESTS_WIRING = `${UI_SRC}/retry/tests_wiring.rs`;

/** The real file, as the analyzer hands it to the filter. */
function realFile(path: string): { path: string; content: string } {
	return { path, content: readFileSync(resolve(ROOT, path), "utf8") };
}

/** The two dead-code entries the report raises for this issue. */
function reportedDead(): Array<{ name: string; file: string; line: number; ext: string }> {
	return [
		{ name: "on_message", file: WS, line: 61, ext: "rs" },
		{ name: "on_message", file: TESTS_WIRING, line: 20, ext: "rs" },
	];
}

describe("fp-filter — on_message is live in the real UI sources (issue #2089)", () => {
	it("suppresses both reported entries and reconciles stats.dead", () => {
		const data = {
			files: [realFile(WS), realFile(RETRY), realFile(WIRING), realFile(TESTS_WIRING)],
			deadFunctions: reportedDead(),
			stats: { dead: 2 },
		};
		const { data: filtered, suppressed } = sanitizeAnalysisData(data, readFileFrom(data));

		assert.deepStrictEqual(
			filtered.deadFunctions,
			[],
			"both entries must be suppressed: `wire` in retry/wiring.rs calls `socket.on_message(`, declared by the `Socket` trait in the same module",
		);
		assert.strictEqual(
			suppressed.deadCode.length,
			2,
			"every input entry must be accounted for as suppressed, not dropped silently",
		);
		assert.strictEqual(
			filtered.stats.dead,
			0,
			"stats.dead must follow the filtered list, or the report contradicts its own score",
		);
	});

	it("keeps the entries when the call site cannot be read (fail open)", () => {
		// Only `ws.rs` is readable, so the filter keeps both findings rather than
		// guessing. This also pins where the suppression above comes from: if it
		// ever started resolving inside `ws.rs` (a stray call there) instead of
		// through the real call site in `retry/wiring.rs`, this case would fail.
		const data = {
			files: [realFile(WS)],
			deadFunctions: reportedDead(),
			stats: { dead: 2 },
		};
		const { data: filtered, suppressed } = sanitizeAnalysisData(data, readFileFrom(data));

		assert.deepStrictEqual(
			filtered.deadFunctions.map((entry: { file: string }) => entry.file),
			[WS, TESTS_WIRING],
			"an unreadable call site must keep both findings (fail open)",
		);
		assert.strictEqual(suppressed.deadCode.length, 0, "nothing may be suppressed without evidence");
		assert.strictEqual(
			filtered.stats.dead,
			2,
			"stats.dead must stay unchanged when nothing is dropped",
		);
	});
});
