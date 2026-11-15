/**
 * Regression guard for issue #2086 — CodeFlow `LOW: Debug Statements`
 * ("18 / 11 / 33 console statements found") on
 *
 *   .pi/extensions/structural-analyzer/test/index.test.mts        (33 hits)
 *   .pi/extensions/structural-analyzer/test/index-part2.test.mts  (18 hits)
 *   .pi/extensions/structural-analyzer/test/index-part3.test.mts  (11 hits)
 *
 * The finding is a false positive: every cited hit is a string literal — an
 * ast-grep pattern argument (`"console.log($A)"`) or a fixture snippet
 * (`"console.log('App started')"`) passed to `createMatchJson`. No file owns a
 * runtime `console` call. Editing those strings to dodge a substring match
 * would delete the behaviour under test, so this file pins the truth instead:
 *
 *   Phase 1 — a TypeScript-AST walk proves the cited files carry zero `console`
 *             call expressions and do carry the `console.` literals the report
 *             counts, with walker self-checks so the guard cannot pass vacuously.
 *   Phase 2 — the shipped `fp-filter.js` hygiene rule suppresses exactly those
 *             three paths and keeps real debug output in shipping source.
 *   Phase 3 — the existing filter suites must stay green (see the command below).
 *
 * Run with:
 *   node --experimental-strip-types --test test/debug-statements-fp-2086.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const requireCjs = createRequire(import.meta.url);
// The CJS module the container ships, required the same way the headless runner
// does, so these assertions pin the exact production file.
const FILTER = join(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");

type Suppressed = {
	security: unknown[];
	layerViolations: unknown[];
	hygiene: unknown[];
	deadCode: unknown[];
	duplicates: unknown[];
	suggestions: unknown[];
};

const { isFalsePositiveHygiene, sanitizeAnalysisData } = requireCjs(FILTER) as {
	isFalsePositiveHygiene: (issue: unknown, readFile?: (path: unknown) => string | null) => boolean;
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
		opts?: { deriveSuggestions?: (filtered: any) => unknown },
	) => { data: any; suppressed: Suppressed };
};

// The three cited files, with the per-file totals the CodeFlow report states.
const CITED_FILES: ReadonlyArray<{ path: string; reported: number }> = [
	{ path: ".pi/extensions/structural-analyzer/test/index.test.mts", reported: 33 },
	{ path: ".pi/extensions/structural-analyzer/test/index-part2.test.mts", reported: 18 },
	{ path: ".pi/extensions/structural-analyzer/test/index-part3.test.mts", reported: 11 },
];

// The one cited file that also carries a *real* debug call in the test tree
// (characterization only — see Phase 2).
const REAL_DEBUG_TEST_FILE = ".pi/extensions/structural-analyzer/test/structural-analyzer.test.mts";
const SHIPPING_SOURCE = ".pi/extensions/structural-analyzer/index.ts";

const nullReadFile = () => null;

// --- AST helpers -----------------------------------------------------------

type Hit = { line: number; text: string };

function parse(source: string, fileName: string): ts.SourceFile {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function forEachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
	visit(node);
	node.forEachChild((child) => forEachNode(child, visit));
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Does `node` resolve to the global `console` binding? Walks the receiver chain
 * so `console.log`, `console?.log` and `globalThis`-free aliases of the same
 * shape are recognised, and stops at anything else (a local `logger.log`, a
 * member of a call result).
 */
function rootsAtConsole(node: ts.Expression): boolean {
	let current: ts.Expression = node;
	for (;;) {
		if (ts.isIdentifier(current)) return current.text === "console";
		if (ts.isPropertyAccessExpression(current)) {
			current = current.expression;
			continue;
		}
		if (ts.isElementAccessExpression(current)) {
			current = current.expression;
			continue;
		}
		if (
			ts.isNonNullExpression(current) ||
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isSatisfiesExpression(current)
		) {
			current = current.expression;
			continue;
		}
		return false;
	}
}

/** Every `console.*(...)` call expression in `source` (runtime debug output). */
function consoleCallHits(source: string, fileName = "guard.mts"): Hit[] {
	const sourceFile = parse(source, fileName);
	const hits: Hit[] = [];
	forEachNode(sourceFile, (node) => {
		if (!ts.isCallExpression(node)) return;
		if (!rootsAtConsole(node.expression)) return;
		hits.push({ line: lineOf(sourceFile, node), text: node.getText(sourceFile) });
	});
	return hits;
}

/**
 * Every string or template literal in `source` whose text contains `console.`
 * — the only thing the CodeFlow heuristic matched in the cited files.
 */
function consoleLiteralHits(source: string, fileName = "guard.mts"): Hit[] {
	const sourceFile = parse(source, fileName);
	const hits: Hit[] = [];
	forEachNode(sourceFile, (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			if (node.text.includes("console."))
				hits.push({ line: lineOf(sourceFile, node), text: node.text });
			return;
		}
		if (ts.isTemplateExpression(node)) {
			const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
			if (parts.some((part) => part.includes("console.")))
				hits.push({ line: lineOf(sourceFile, node), text: parts.join("${...}") });
		}
	});
	return hits;
}

function readCited(sourcePath: string): string {
	return readFileSync(join(ROOT, sourcePath), "utf8");
}

/** A LOW hygiene finding as the analyzer emits it: no snippet of its own. */
function hygieneFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		severity: "low",
		title: "Debug Statements",
		description: "console statements found. Remove before production.",
		path: CITED_FILES[0]!.path,
		line: 1,
		code: "",
		...over,
	};
}

// --- Phase 1: the cited hits are fixture strings ---------------------------

describe("#2086 Phase 1 — the cited `console.` hits are string literals", () => {
	it("the walker recognises runtime console calls (self-check, not vacuous)", () => {
		const snippet = "console.log('x');\nconsole.warn(\"y\");";
		assert.deepStrictEqual(
			consoleCallHits(snippet).map((hit) => hit.text),
			["console.log('x')", 'console.warn("y")'],
			"the call rule must see real debug output, or every Phase 1 pass is empty",
		);
		assert.deepStrictEqual(
			consoleLiteralHits(snippet),
			[],
			"no literal in this snippet says `console.`",
		);
	});

	it("the walker ignores `console.` inside a pattern string (self-check)", () => {
		const snippet = 'const pattern = "console.log($A)";';
		assert.deepStrictEqual(consoleCallHits(snippet), [], "a quoted pattern is data, not a call");
		assert.deepStrictEqual(consoleLiteralHits(snippet), [{ line: 1, text: "console.log($A)" }]);
	});

	it("a createMatchJson payload line is fixture data, not a call (self-check)", () => {
		const snippet = `createMatchJson("src/app.ts", "10-10", "console.log('App started')");`;
		assert.deepStrictEqual(consoleCallHits(snippet), []);
		const literalHits = consoleLiteralHits(snippet);
		assert.strictEqual(literalHits.length, 1);
		assert.strictEqual(literalHits[0]!.text, "console.log('App started')");
	});

	for (const { path, reported } of CITED_FILES) {
		it(`${path} carries no runtime console call`, () => {
			const hits = consoleCallHits(readCited(path), path);
			assert.deepStrictEqual(
				hits,
				[],
				`expected zero console call expressions in ${path}, found:\n` +
					hits.map((hit) => `  L${hit.line}: ${hit.text}`).join("\n"),
			);
		});

		it(`${path} carries the console. literals the report counts (${reported})`, () => {
			const hits = consoleLiteralHits(readCited(path), path);
			assert.ok(
				hits.length >= 1,
				`expected the detector's target (a string literal containing \`console.\`) in ${path}; ` +
					`observed ${hits.length} literal hits against the ${reported} the report cites — ` +
					"if the count reached zero the fixture no longer exercises the pattern",
			);
			assert.ok(
				hits.every((hit) => hit.text.includes("console.")),
				"every collected hit must itself be a literal mentioning `console.`",
			);
		});
	}
});

// --- Phase 2: the FP filter suppresses the cited paths ---------------------

describe("#2086 Phase 2 — the hygiene rule suppresses the cited test paths", () => {
	it("suppresses LOW `Debug Statements` on each cited path", () => {
		for (const { path } of CITED_FILES) {
			assert.strictEqual(
				isFalsePositiveHygiene({ severity: "low", title: "Debug Statements", path }, nullReadFile),
				true,
				path,
			);
		}
	});

	it("is case-insensitive on severity and path", () => {
		assert.strictEqual(
			isFalsePositiveHygiene(
				{
					severity: "LOW",
					title: "Debug Statements",
					path: ".PI/EXTENSIONS/STRUCTURAL-ANALYZER/TEST/INDEX.TEST.MTS",
				},
				nullReadFile,
			),
			true,
		);
	});

	it("routes the three cited findings to suppressed.hygiene, keeping shipping source", () => {
		const cited = CITED_FILES.map(({ path }, index) => hygieneFinding({ path, line: index + 1 }));
		const shipping = hygieneFinding({
			path: SHIPPING_SOURCE,
			code: "console.log('debug')",
		});

		const { data, suppressed } = sanitizeAnalysisData(
			{ securityIssues: [...cited, shipping] },
			nullReadFile,
		);

		assert.deepStrictEqual(
			data.securityIssues,
			[shipping],
			"only the shipping-source finding may survive the filter",
		);
		assert.deepStrictEqual(
			suppressed.hygiene,
			cited,
			"suppressed findings are kept, in input order, so the silence stays observable",
		);
		assert.strictEqual(suppressed.hygiene.length, CITED_FILES.length);
		assert.deepStrictEqual(suppressed.security, []);
	});

	it("does not suppress another LOW title on a cited path (title-gated control)", () => {
		for (const { path } of CITED_FILES) {
			assert.strictEqual(
				isFalsePositiveHygiene({ severity: "low", title: "Hardcoded Secret", path }, nullReadFile),
				false,
				path,
			);
		}
	});

	it("does not suppress `Debug Statements` in the shipping analyzer source (path-gated control)", () => {
		assert.strictEqual(
			isFalsePositiveHygiene(
				{ severity: "low", title: "Debug Statements", path: SHIPPING_SOURCE },
				nullReadFile,
			),
			false,
			"real debug output in shipping source must stay reported",
		);
	});

	it("characterization: a real console.warn inside a test file is suppressed as a test artifact", () => {
		// `.pi/extensions/structural-analyzer/test/structural-analyzer.test.mts`
		// does carry a runtime `console.warn`. The hygiene rule is path-class only,
		// so it is suppressed too — accepted, because a test's diagnostic output is
		// not shipping debug output. This asserts current behaviour; if it changes,
		// report it rather than editing the pattern strings or the filter.
		const source = readCited(REAL_DEBUG_TEST_FILE);
		const calls = consoleCallHits(source, REAL_DEBUG_TEST_FILE);
		assert.ok(
			calls.length >= 1,
			`expected the documented real console call in ${REAL_DEBUG_TEST_FILE}; found none`,
		);

		assert.strictEqual(
			isFalsePositiveHygiene(
				{ severity: "low", title: "Debug Statements", path: REAL_DEBUG_TEST_FILE },
				nullReadFile,
			),
			true,
		);
	});
});
