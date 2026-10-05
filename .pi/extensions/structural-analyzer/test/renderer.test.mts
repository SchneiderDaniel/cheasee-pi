/**
 * Tests: renderer.ts — TUI rendering
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderStructuralSearchResult } from "../renderer.ts";

/**
 * Canonical link target the renderer must use: pathToFileURL(absPath) + "#L" + start line.
 * Computed in-test (never hardcoded) so the assertion is exact, not substring-based.
 */
function expectedUri(cwd: string, file: string, lines: string): string {
	return pathToFileURL(path.resolve(cwd, file)).href + "#L" + lines.split("-")[0];
}

// Mock theme: fg returns text unchanged (identity function)
const mockTheme = {
	fg: (_color: string, text: string) => text,
};

const defaultCwd = "/tmp";

function makeDetails(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		success: true,
		matches: 0,
		results: [],
		...overrides,
	};
}

function makeResult(
	details: Record<string, unknown>,
	contentText?: string,
): { content: Array<{ type: string; text: string }>; details: unknown } {
	return {
		content: [{ type: "text", text: contentText ?? JSON.stringify(details) }],
		details,
	};
}

/** Render the component and return joined string (ignoring padding lines). */
function renderToString(
	comp: ReturnType<typeof renderStructuralSearchResult>,
	_width = 120,
): string {
	return comp.render(_width).join("\n").trim();
}

describe("renderStructuralSearchResult", () => {
	it("exports a function named renderStructuralSearchResult", () => {
		assert.strictEqual(typeof renderStructuralSearchResult, "function");
	});

	it("isPartial=true returns Text containing 'Searching...'", () => {
		const result = makeResult(makeDetails());
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: true },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(output.includes("Searching..."), `expected 'Searching...' in output: ${output}`);
	});

	it("success=false details returns Text with error text from content", () => {
		const result = makeResult(
			{ success: false, exitCode: 1, stderr: "error msg" },
			"ast-grep failed: unknown language",
		);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(
			output.includes("ast-grep failed: unknown language"),
			`expected error text in output: ${output}`,
		);
	});

	it("isError result with structuredContent still renders the error text (renderer reads details only)", () => {
		const result = {
			content: [{ type: "text", text: "ast-grep failed (exit code 1): unknown language" }],
			details: { success: false, exitCode: 1, stderr: "unknown language" },
			structuredContent: { matches: 0, results: [], language: "badlang", error: "unknown" },
			isError: true,
		};
		const comp = renderStructuralSearchResult(
			result as any,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(
			output.includes("ast-grep failed (exit code 1): unknown language"),
			`expected error text in output: ${output}`,
		);
		assert.ok(!output.includes("badlang"), "structuredContent must not leak into the renderer");
	});

	it("details.matches=0 returns Text with 'No matches found'", () => {
		const result = makeResult(makeDetails({ matches: 0, results: [] }));
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(
			output.includes("No matches found"),
			`expected 'No matches found' in output: ${output}`,
		);
	});

	it("2 matches, expanded=true → hyperlinked file paths, line numbers, snippets, URIs", () => {
		const results = [
			{
				file: "api/auth.py",
				lines: "22-28",
				snippet: "try:\n    verify_token(token)\nexcept AuthError:",
			},
			{ file: "src/app.ts", lines: "10-10", snippet: "console.log('App started')" },
		];
		const details = makeDetails({ matches: 2, results });
		const result = makeResult(details);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: "/home/project" },
		);
		const output = renderToString(comp);

		// Should contain file paths (relative, as display text)
		assert.ok(output.includes("api/auth.py"), `expected api/auth.py in output:\n${output}`);
		assert.ok(output.includes("src/app.ts"), `expected src/app.ts in output:\n${output}`);

		// POSITIONAL: OSC 8 opening must be followed by the URI, then the RELATIVE path as
		// visible text. The buggy order emitted the URI as text and the relative path as target.
		const apiUri = expectedUri("/home/project", "api/auth.py", "22-28");
		const appUri = expectedUri("/home/project", "src/app.ts", "10-10");
		assert.ok(
			output.includes(`\x1b]8;;${apiUri}\x1b\\api/auth.py\x1b]8;;\x1b\\`),
			`expected positional OSC 8 hyperlink (uri target, relative display) for api/auth.py:\n${output}`,
		);
		assert.ok(
			output.includes(`\x1b]8;;${appUri}\x1b\\src/app.ts\x1b]8;;\x1b\\`),
			`expected positional OSC 8 hyperlink (uri target, relative display) for src/app.ts:\n${output}`,
		);
		// Regression sentinels: the relative path must never be a link target.
		assert.ok(
			!output.includes("\x1b]8;;api/auth.py"),
			`relative path must never be a hyperlink target:\n${output}`,
		);
		assert.ok(
			!output.includes("file://localhost"),
			`must not use the non-canonical file://localhost authority:\n${output}`,
		);

		// Should contain snippets
		assert.ok(output.includes("verify_token"), `expected snippet in output:\n${output}`);
		assert.ok(
			output.includes("console.log('App started')"),
			`expected snippet in output:\n${output}`,
		);

		// Should contain the actual OSC 8 hyperlink sequences
		assert.ok(output.includes("\x1b]8;;"), `expected OSC 8 escape in output:\n${output}`);
	});

	it("2 matches, collapsed=false → shows summary line (within RENDER_COLLAPSED_LIMIT=5)", () => {
		const results = [
			{ file: "api/auth.py", lines: "22-28", snippet: "verify_token" },
			{ file: "src/app.ts", lines: "10-10", snippet: "console.log" },
		];
		const details = makeDetails({ matches: 2, results });
		const result = makeResult(details);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(
			output.includes("Structural search") || output.includes("2 matches"),
			`expected summary in output: ${output}`,
		);
		assert.ok(output.includes("api/auth.py"), `expected file in output: ${output}`);
		assert.ok(output.includes("src/app.ts"), `expected file in output: ${output}`);
	});

	it("truncated=true → output includes truncation notice with totalMatches", () => {
		const results = Array.from({ length: 5 }, (_, i) => ({
			file: `f${i}.ts`,
			lines: `${i}-${i + 1}`,
			snippet: `match ${i}`,
		}));
		const details = makeDetails({
			matches: 200,
			results,
			truncated: true,
			totalMatches: 200,
		});
		const result = makeResult(details);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(output.includes("200"), `expected total 200 in output:\n${output}`);
		assert.ok(output.includes("Showing"), `expected 'Showing' in output:\n${output}`);
	});

	it("101+ matches, expanded=true → capped at 20, truncation notice present, f20.ts not rendered", () => {
		const results = Array.from({ length: 25 }, (_, i) => ({
			file: `f${i}.ts`,
			lines: `${i}-${i + 1}`,
			snippet: `match ${i}`,
		}));
		const details = makeDetails({
			matches: 150,
			results,
			truncated: true,
			totalMatches: 150,
		});
		const result = makeResult(details);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		// f19.ts is the 20th (0-indexed: 0..19 = 20 results)
		assert.ok(output.includes("f19.ts"), `expected f19.ts (20th) in output:\n${output}`);
		// f20.ts is the 21st — should NOT be shown
		assert.ok(!output.includes("f20.ts"), `f20.ts should NOT appear (capped at 20):\n${output}`);
		// Should mention total 150
		assert.ok(output.includes("150"), `expected total 150 in output:\n${output}`);
		// Should have truncation notice
		assert.ok(output.includes("Showing"), `expected 'Showing' in output:\n${output}`);
	});

	it("reads from result.details.results, NOT from content[0].text", () => {
		const details = makeDetails({
			matches: 2,
			results: [
				{ file: "a.ts", lines: "1-1", snippet: "match a" },
				{ file: "b.ts", lines: "2-2", snippet: "match b" },
			],
		});
		const result = makeResult(details, "DIFFERENT CONTENT TEXT THAT SHOULD NOT APPEAR");
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(output.includes("a.ts"), `expected a.ts in output: ${output}`);
		assert.ok(output.includes("b.ts"), `expected b.ts in output: ${output}`);
		assert.ok(
			!output.includes("DIFFERENT CONTENT"),
			`should NOT use content text in output: ${output}`,
		);
	});

	it("hyperlink URI format: canonical file:// URI with #L fragment (no localhost)", () => {
		const results = [{ file: "src/app.ts", lines: "10-10", snippet: "code" }];
		const details = makeDetails({ matches: 1, results });
		const result = makeResult(details);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: "/home/project" },
		);
		const output = renderToString(comp);
		const uri = expectedUri("/home/project", "src/app.ts", "10-10");
		assert.strictEqual(uri, "file:///home/project/src/app.ts#L10");
		assert.ok(
			output.includes(`\x1b]8;;${uri}\x1b\\src/app.ts\x1b]8;;\x1b\\`),
			`expected canonical positional hyperlink in output:\n${output}`,
		);
	});

	it("0 results with success=true → no file:// URIs, neutral message", () => {
		const details = makeDetails({ matches: 0, results: [] });
		const result = makeResult(details);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(!output.includes("file://"), `should not have file:// URIs: ${output}`);
		assert.ok(output.includes("No matches found"), `expected neutral message: ${output}`);
	});

	it("snippet truncation: match snippet >100 chars display-truncated with truncateLine suffix", () => {
		const results = [
			{
				file: "a.ts",
				lines: "1-1",
				snippet: "x".repeat(120),
			},
		];
		const details = makeDetails({ matches: 1, results });
		const result = makeResult(details);
		const comp = renderStructuralSearchResult(
			result,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		// The snippet in display is >100 chars, so truncateLine appends '... [truncated]' suffix.
		// Due to Text component padding (1,1), the 115-char content + 4-char indent + 1-char left padding
		// wraps at width 120, splitting ' [truncated]' to the next line.
		assert.ok(
			output.includes("x".repeat(100) + "..."),
			`expected 100 x's + ellipsis in output:\n${output}`,
		);
		assert.ok(output.includes("[truncated]"), `expected truncated suffix in output:\n${output}`);
	});

	it("missing/undefined details → guard returns error Text, does not throw", () => {
		const result = {
			content: [{ type: "text" as const, text: "custom error" }],
			details: undefined,
		};
		const comp = renderStructuralSearchResult(
			result as any,
			{ expanded: true, isPartial: false },
			mockTheme as any,
			{ cwd: defaultCwd },
		);
		const output = renderToString(comp);
		assert.ok(output.includes("custom error"), `expected custom error text in output: ${output}`);
	});
});

describe("renderStructuralSearchResult — OSC 8 argument order & URI canonicalization", () => {
	function renderSingle(file: string, lines: string, cwd = "/home/project", snippet = "code") {
		const details = makeDetails({ matches: 1, results: [{ file, lines, snippet }] });
		return renderToString(
			renderStructuralSearchResult(
				makeResult(details),
				{ expanded: true, isPartial: false },
				mockTheme as any,
				{ cwd },
			),
		);
	}

	it("Phase 1: opening OSC 8 is immediately followed by the URI target, then the relative path", () => {
		const uri = expectedUri("/home/project", "src/app.ts", "10-10");
		const output = renderSingle("src/app.ts", "10-10");
		assert.ok(
			output.includes(`\x1b]8;;${uri}\x1b\\src/app.ts\x1b]8;;\x1b\\`),
			`expected positional hyperlink \`ESC]8;;<uri>ESC\\src/app.tsESC]8;;ESC\\\`:\n${output}`,
		);
	});

	it("Phase 1 sentinel: relative path is never emitted as a hyperlink target", () => {
		const output = renderSingle("src/app.ts", "10-10");
		assert.ok(
			!output.includes("\x1b]8;;src/app.ts"),
			`relative path must not be the link target:\n${output}`,
		);
	});

	it("Phase 1 sentinel: the raw file:// URI appears only as link target, never as visible text", () => {
		const uri = expectedUri("/home/project", "src/app.ts", "10-10");
		const output = renderSingle("src/app.ts", "10-10");
		const occurrences = output.split(uri).length - 1;
		const linked = output.split(`\x1b]8;;${uri}\x1b\\`).length - 1;
		assert.strictEqual(occurrences, 1, `expected the URI exactly once:\n${output}`);
		assert.strictEqual(linked, occurrences, `URI must only appear inside an OSC 8 link:\n${output}`);
	});

	it("Phase 1: line info suffix is rendered after the closing hyperlink for a range", () => {
		const output = renderSingle("api/auth.py", "22-28", "/home/project", "verify_token");
		assert.ok(
			output.includes("api/auth.py\x1b]8;;\x1b\\:22-28"),
			`expected ':22-28' immediately after the hyperlink close:\n${output}`,
		);
	});

	it("Phase 2: lineStart is derived from the range start (#L22 for 22-28)", () => {
		const uri = expectedUri("/home/project", "api/auth.py", "22-28");
		assert.ok(uri.endsWith("#L22"));
		const output = renderSingle("api/auth.py", "22-28", "/home/project", "verify_token");
		assert.ok(
			output.includes(`\x1b]8;;${uri}\x1b\\api/auth.py\x1b]8;;\x1b\\`),
			`expected '#L22' ranged URI in output:\n${output}`,
		);
	});

	it("Phase 2: percent-encodes spaces, '#', and '?' in the URI (pathToFileURL)", () => {
		const file = "a b#c?.ts";
		const uri = expectedUri("/home/project", file, "5-5");
		assert.ok(uri.includes("%20"), `expected %20 in uri: ${uri}`);
		assert.ok(uri.includes("%23"), `expected %23 in uri: ${uri}`);
		assert.ok(uri.includes("%3F"), `expected %3F in uri: ${uri}`);
		const output = renderSingle(file, "5-5");
		assert.ok(
			output.includes(`\x1b]8;;${uri}\x1b\\${file}\x1b]8;;\x1b\\`),
			`expected percent-encoded positional hyperlink:\n${output}`,
		);
	});

	it("Phase 2: no 'file://localhost' authority remains", () => {
		const output = renderSingle("src/app.ts", "10-10");
		assert.ok(!output.includes("file://localhost"), `must not contain localhost authority:\n${output}`);
	});
});
