/**
 * Tests: renderer.ts — TUI rendering
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { renderStructuralSearchResult } from "../renderer.ts";

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

		// Should contain hyperlink URIs with absolute paths
		assert.ok(
			output.includes("file://localhost/home/project/api/auth.py:22"),
			`expected file:// URI in output:\n${output}`,
		);
		assert.ok(
			output.includes("file://localhost/home/project/src/app.ts:10"),
			`expected file:// URI in output:\n${output}`,
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

	it("hyperlink URI format: file://localhost/abs/path/to/file.ts:lineStart", () => {
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
		assert.ok(
			output.includes("file://localhost/home/project/src/app.ts:10"),
			`expected absolute URI in output:\n${output}`,
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

	it("snippet truncation: match snippet >100 chars display-truncated to 99+'…'", () => {
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
		// The snippet in display is >100 chars, so it gets truncated to 99 + '…'
		assert.ok(
			output.includes("x".repeat(99) + "…"),
			`expected truncated snippet in output:\n${output}`,
		);
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
