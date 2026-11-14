/**
 * The three unused-function findings of issue #2101 against the real tree.
 *
 * CodeFlow reports `defaultSleep`, `defaultIsWritable` and `on_message` as dead.
 * All three are false positives for a reason the filter already encodes: a
 * default-injection seam is mentioned as a value (`opts.sleepFn ?? defaultSleep`,
 * `opts.isWritable ?? defaultIsWritable`) and a Rust trait method is dispatched
 * through its port (`socket.on_message(` in `retry/wiring.rs`, implemented by
 * `impl Socket for BrowserSocket` in `ws.rs`). The synthetic cases in
 * `test/codeflow-fp-filter.test.mts` pin those rules; this file pairs them with
 * the real sources, so the verdict is proven against the tree that ships — and
 * fails if a seam is "fixed" by deleting it instead of keeping it.
 *
 * The third describe block is the guard for that: `defaultSleep` and
 * `defaultIsWritable` are the default-injection seams of their adapters, and
 * `on_message` is the `Socket` trait method, so none of them may be removed to
 * silence the report.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-unused-functions-2101.test.mts
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
type DeadEntry = { name: string; file: string; line: number; ext: string };

const { sanitizeAnalysisData, readFileFrom } = createRequire(import.meta.url)(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
	) => { data: any; suppressed: Suppressed };
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
};

// Paths exactly as the CodeFlow report records them, so the filter resolves the
// same references the analyzer's own file set would.
const RUN = ".pi/skills/audit-codeflow-analysis/lib/codeflow-run.ts";
const BROWSER = ".pi/extensions/scrapling/browser-setup.ts";
const UI_SRC = "cmd/cheasee-pi/embedded/docker/ui/src";
const WS = `${UI_SRC}/ws.rs`;
const RETRY = `${UI_SRC}/retry.rs`;
const WIRING = `${UI_SRC}/retry/wiring.rs`;

/** The real file, as the analyzer hands it to the filter. */
function realFile(path: string): { path: string; content: string } {
	return { path, content: readFileSync(resolve(ROOT, path), "utf8") };
}

/** The three entries the report raises, at the definitions that carry them. */
function reportedDead(): DeadEntry[] {
	return [
		{ name: "defaultSleep", file: RUN, line: 66, ext: "ts" },
		{ name: "defaultIsWritable", file: BROWSER, line: 81, ext: "ts" },
		{ name: "on_message", file: WS, line: 61, ext: "rs" },
	];
}

/** The analyzer's file set for those three definitions, plus the call site. */
function realFiles(): Array<{ path: string; content: string }> {
	return [realFile(RUN), realFile(BROWSER), realFile(WS), realFile(RETRY), realFile(WIRING)];
}

describe("fp-filter — all three unused-function findings are live (issue #2101)", () => {
	it("suppresses every reported entry against the real tree", () => {
		const data = { files: realFiles(), deadFunctions: reportedDead(), stats: { dead: 3 } };
		const { data: filtered, suppressed } = sanitizeAnalysisData(data, readFileFrom(data));

		assert.deepStrictEqual(
			filtered.deadFunctions,
			[],
			"every entry must be suppressed: `const sleep = opts.sleepFn ?? defaultSleep`, " +
				"`const isWritable = opts.isWritable ?? defaultIsWritable`, and `socket.on_message(` " +
				"in retry/wiring.rs against the `impl Socket for BrowserSocket` in ws.rs",
		);
		assert.strictEqual(
			suppressed.deadCode.length,
			3,
			"every input entry must be accounted for as suppressed, not dropped silently",
		);
		assert.strictEqual(
			suppressed.deadCode.length + filtered.deadFunctions.length,
			reportedDead().length,
			"no entry may vanish: kept + suppressed must equal the input length",
		);
	});

	it("moves stats.dead with the surviving list", () => {
		const data = { files: realFiles(), deadFunctions: reportedDead(), stats: { dead: 3 } };
		const { data: filtered } = sanitizeAnalysisData(data, readFileFrom(data));

		assert.strictEqual(
			filtered.stats.dead,
			filtered.deadFunctions.length,
			"stats.dead must follow the filtered list, or the report contradicts its own score",
		);
		assert.notStrictEqual(
			filtered.stats.dead,
			data.stats.dead,
			"the summary count must actually move when entries are dropped",
		);
	});

	it("keeps an entry whose defining file is not analyzed (fail open)", () => {
		// The filter cannot refute a finding without the source it names, so it
		// keeps the entry. This also pins where each suppression comes from: remove
		// the file that carries the definition and only that entry survives.
		for (const dead of reportedDead()) {
			const files = realFiles().filter((file) => file.path !== dead.file);
			const data = { files, deadFunctions: reportedDead(), stats: { dead: 3 } };
			const { data: filtered, suppressed } = sanitizeAnalysisData(data, readFileFrom(data));

			assert.deepStrictEqual(
				filtered.deadFunctions,
				[dead],
				`${dead.name}: an unanalyzed definition file must keep the finding (fail open)`,
			);
			assert.strictEqual(
				suppressed.deadCode.length,
				2,
				`${dead.name}: the other two entries are still refuted by their real sources`,
			);
			assert.strictEqual(
				filtered.stats.dead,
				1,
				`${dead.name}: stats.dead must count the surviving entry, not the input length`,
			);
		}
	});

	it("keeps every entry when the real source cannot be read (fail open)", () => {
		// An incomplete index (a file listed but unreadable) leaves every finding
		// standing rather than risking a wrong attribution.
		const data = { files: realFiles(), deadFunctions: reportedDead(), stats: { dead: 3 } };
		const { data: filtered, suppressed } = sanitizeAnalysisData(data, () => null);

		assert.deepStrictEqual(filtered.deadFunctions, reportedDead());
		assert.strictEqual(suppressed.deadCode.length, 0, "nothing may be suppressed without evidence");
		assert.strictEqual(
			filtered.stats.dead,
			3,
			"stats.dead must stay unchanged when nothing is dropped",
		);
	});
});

describe("default-injection seams and the Socket port stay in place (issue #2101)", () => {
	/** The real file's text, so a deletion fails here rather than in review. */
	function source(path: string): string {
		return readFileSync(resolve(ROOT, path), "utf8");
	}

	it("codeflow-run.ts still declares defaultSleep and binds it as the default", () => {
		const content = source(RUN);
		assert.match(
			content,
			/const defaultSleep: SleepFn =/,
			"`defaultSleep` is the default-injection seam of `ensureReport` — do not delete it to silence the report",
		);
		assert.match(
			content,
			/opts\.sleepFn \?\? defaultSleep\b/,
			"`ensureReport` must still bind `opts.sleepFn ?? defaultSleep`",
		);
	});

	it("browser-setup.ts still declares defaultIsWritable and binds it as the default", () => {
		const content = source(BROWSER);
		assert.match(
			content,
			/function defaultIsWritable\(/,
			"`defaultIsWritable` is the default-injection seam of `ensureStealthBrowser` — do not delete it",
		);
		assert.match(
			content,
			/opts\.isWritable \?\? defaultIsWritable\b/,
			"`ensureStealthBrowser` must still bind `opts.isWritable ?? defaultIsWritable`",
		);
	});

	it("ws.rs still implements on_message and retry/wiring.rs still dispatches it", () => {
		const socket = source(WS);
		assert.match(
			socket,
			/impl Socket for BrowserSocket \{/,
			"`on_message` is a `Socket` trait method implemented by the browser socket",
		);
		assert.match(
			socket,
			/impl Socket for BrowserSocket \{[\s\S]*?fn on_message<F: FnMut\(String\) \+ 'static>/,
			"the production `on_message` implementation must stay inside `impl Socket for BrowserSocket`",
		);
		assert.match(
			source(WIRING),
			/socket\.on_message\(/,
			"`wire` must still dispatch through `socket.on_message(`, the call site that makes it live",
		);
	});
});
