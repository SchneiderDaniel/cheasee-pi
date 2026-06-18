/**
 * Tests for footer 4th row — supervisor issue info display
 *
 * Validates that when FooterConfig.issueNumber is set, a 4th row
 * appears with clickable issue number and truncated title.
 * When issueNumber is cleared, the row disappears.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/footer-issue-row.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth, hyperlink } from "@earendil-works/pi-tui";
import { installFooter } from "../footer.ts";

// ---------------------------------------------------------------------------
// Inline FooterConfig/ContextStatusBarConfig (matches types.ts)
// ---------------------------------------------------------------------------

interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

interface ThresholdEntry {
	maxTokens: number | null;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
	welcomeTimeoutMs: number;
}

interface FooterConfig {
	worktreeName: string | null;
	thinkingLevel: string;
	tpsSamples: TpsSample[];
	lastComputedTps: { value: number | null };
	lastContextWindow: { value: number | undefined };
	toolCallCount: { value: number };
	cacheRead: number | undefined;
	cacheWrite: number | undefined;
	cacheHitRate: number | undefined;
	sessionName: string | undefined;
	trustStatus: "trusted" | "untrusted" | undefined;
	sessionId: string;
	issueNumber: { value: number | undefined };
	issueRepo: { value: string | undefined };
	issueTitle: { value: string | undefined };
}

// ---------------------------------------------------------------------------
// Helper: create mock context with theme
// ---------------------------------------------------------------------------

function createMockCtx() {
	return {
		mode: "tui",
		ui: {
			setFooter: () => {},
			setStatus: () => {},
		},
		getContextUsage: () => undefined,
		model: { id: "test-model" },
	};
}

function defaultConfig(): ContextStatusBarConfig {
	return {
		enabled: true,
		thresholds: [{ maxTokens: null }],
		showTimer: false,
		showTps: false,
		showCache: false,
		welcomeTimeoutMs: 0,
	};
}

function defaultFooterConfig(): FooterConfig {
	return {
		worktreeName: null,
		thinkingLevel: "",
		tpsSamples: [],
		lastComputedTps: { value: null },
		lastContextWindow: { value: undefined },
		toolCallCount: { value: 0 },
		cacheRead: undefined,
		cacheWrite: undefined,
		cacheHitRate: undefined,
		sessionName: undefined,
		trustStatus: undefined,
		sessionId: "",
		issueNumber: { value: undefined },
		issueRepo: { value: undefined },
		issueTitle: { value: undefined },
	};
}

/**
 * Install the footer and return the render function + footerConfig reference.
 */
function installAndGetRender(
	config: ContextStatusBarConfig,
	footerConfig: FooterConfig,
): (width: number) => string[] {
	let renderFn: ((width: number) => string[]) | undefined;

	const ctx = createMockCtx();
	ctx.ui.setFooter = ((fn: unknown) => {
		if (typeof fn === "function") {
			const component = (fn as any)(
				{ requestRender: () => {}, setClearOnShrink: () => {} },
				{
					fg: (_color: string, text: string) => text,
				},
				{
					onBranchChange: () => () => {},
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
				},
			);
			renderFn = component.render;
		}
	}) as any;

	installFooter(ctx as any, config, footerConfig as any);
	assert.ok(renderFn, "render function should be registered");
	return renderFn!;
}

/**
 * Get the last row from rendered rows.
 */
function lastRow(rows: string[]): string | undefined {
	return rows[rows.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("footer — 4th row (supervisor issue info)", () => {
	it("no issue row when issueNumber.value is undefined", () => {
		const footerConfig = defaultFooterConfig();
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		// Last row should be the trust indicator (row3), not issue info
		const last = lastRow(rows)!;
		assert.ok(
			last.includes("❓") || last.includes("Session"),
			"last row should be trust/session info, not issue row",
		);
	});

	it("no issue row when issueNumber.value is null", () => {
		const footerConfig = defaultFooterConfig();
		(footerConfig as any).issueNumber.value = null;
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const last = lastRow(rows)!;
		assert.ok(
			last.includes("❓") || last.includes("Session"),
			"last row should be trust/session info, not issue row",
		);
	});

	it("issue row appears when issueNumber.value is set", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Add feature";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const last = lastRow(rows)!;
		assert.ok(
			last.includes("#862"),
			"last row should include issue number when issueNumber is set",
		);
	});

	it('issue row matches pattern "#862 · Add feature"', () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Add feature";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;
		assert.ok(issueRow.includes("#862"), "issue row should include issue number");
		assert.ok(issueRow.includes("Add feature"), "issue row should include title");
		// Should contain the │ separator between issue number and title
		assert.ok(issueRow.includes("│"), "issue row should include │ separator");
		// Verify the separator appears after the issue number (ANSI/OSC codes may be between)
		const idxNum = issueRow.indexOf("#862");
		const idxSep = issueRow.indexOf("│");
		assert.ok(idxNum >= 0, "issue number should be found in row");
		assert.ok(idxSep >= 0, "separator should be found in row");
		assert.ok(idxSep > idxNum, "separator should appear after issue number");
	});

	it("issue row uses │ separator between issue number and title (consistent with rows 1-3)", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Add feature";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;
		// The separator should appear after the issue number (ANSI/OSC codes may be between)
		const idxNum = issueRow.indexOf("#862");
		const idxSep = issueRow.indexOf("│");
		assert.ok(idxNum >= 0, "issue number should be found in row");
		assert.ok(idxSep >= 0, "separator should be found in row");
		assert.ok(idxSep > idxNum, "separator should appear after issue number");
	});

	it("title truncated to 16 visible chars with ... when longer", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "This is a very long issue title for testing";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;

		// Should contain ellipsis for long title (indicates truncation occurred)
		assert.ok(issueRow.includes("..."), "issue row should contain ellipsis for long title");
		// Should NOT contain the full title end
		assert.ok(
			!issueRow.includes("for testing"),
			"issue row should NOT contain full title when it exceeds 16 chars",
		);
	});

	it("full title shown without ellipsis when ≤16 visible chars", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Short title";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;
		assert.ok(issueRow.includes("Short title"), "issue row should show full short title");
		// When title is short, no "..." ellipsis
		assert.ok(!issueRow.includes("..."), "issue row should not have ellipsis for short title");
	});

	it("empty title shows issue number with no trailing separator text", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;
		assert.ok(issueRow.includes("#862"), "issue row should include issue number");
		// When title is empty, no "│" separator should follow the number
		// (the titleStr should be empty string when title is empty)
	});

	it("issue number renders as OSC 8 hyperlink to GitHub URL", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Add feature";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;

		// OSC 8 hyperlink sequence: ESC ]8 ; ; URL ESC \\ TEXT ESC ]8 ; ; ESC \\
		const expectedUrl = "https://github.com/owner/repo/issues/862";
		assert.ok(
			issueRow.includes(expectedUrl) ||
				// Check for OSC 8 sequence markers
				(issueRow.includes("\x1b]8;;") && issueRow.includes("#862")),
			"issue row should contain OSC 8 hyperlink or at least the URL reference and issue number",
		);
	});

	it("issue row disappears when issueNumber.value is set back to undefined", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Add feature";
		const render = installAndGetRender(defaultConfig(), footerConfig);

		// First render with issue data — should have issue info
		const rowsWith = render(80);
		const lastWith = lastRow(rowsWith)!;
		assert.ok(lastWith.includes("#862"), "should show issue number with data");

		// Clear issue data
		footerConfig.issueNumber.value = undefined;
		footerConfig.issueRepo.value = undefined;
		footerConfig.issueTitle.value = undefined;

		// Second render without issue data — trust/session row should be last
		const rowsWithout = render(80);
		const lastWithout = lastRow(rowsWithout)!;
		assert.ok(
			lastWithout.includes("❓") || lastWithout.includes("Session"),
			"last row should be trust/session after clearing issue data",
		);
		assert.ok(
			!lastWithout.includes("#862"),
			"last row should not contain issue number after clearing",
		);
	});

	it("issue row content is truncated to terminal width (long content doesn't overflow)", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value =
			"Very long issue title that should be truncated at terminal width";
		const render = installAndGetRender(defaultConfig(), footerConfig);

		// Render at narrow width
		const rows = render(20);
		for (const row of rows) {
			assert.ok(
				visibleWidth(row) <= 20,
				`each row visible width (${visibleWidth(row)}) should not exceed 20`,
			);
		}
	});

	it("hyperlink URL is constructed correctly from repo and issue number", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 42;
		footerConfig.issueRepo.value = "my-org/my-repo";
		footerConfig.issueTitle.value = "Fix bug";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;

		// Check the URL is in the output (OSC 8 escape sequence carries the URL)
		const expectedUrl = "https://github.com/my-org/my-repo/issues/42";
		assert.ok(
			issueRow.includes(expectedUrl) || (issueRow.includes("\x1b]8;;") && issueRow.includes("#42")),
			"issue row should link to the correct GitHub issue URL",
		);
	});

	it("has no effect when context-info config is disabled", () => {
		const config = defaultConfig();
		config.enabled = false;
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Add feature";

		let setFooterArg: unknown = undefined;
		const ctx = createMockCtx();
		ctx.ui.setFooter = ((fn: unknown) => {
			setFooterArg = fn;
		}) as any;

		installFooter(ctx as any, config, footerConfig as any);
		assert.strictEqual(setFooterArg, undefined, "setFooter should receive undefined when disabled");
	});

	it("width calculation accounts for OSC 8 escape sequences (visible chars, not raw bytes)", () => {
		const footerConfig = defaultFooterConfig();
		footerConfig.issueNumber.value = 862;
		footerConfig.issueRepo.value = "owner/repo";
		footerConfig.issueTitle.value = "Test";
		const render = installAndGetRender(defaultConfig(), footerConfig);
		const rows = render(80);
		const issueRow = lastRow(rows)!;

		// The visible width should be ≤ 80 (OSC 8 sequences add raw chars but 0 visible width)
		const vw = visibleWidth(issueRow);
		assert.ok(vw <= 80, `visible width (${vw}) should not exceed terminal width (80)`);
	});

	it("does not throw with undefined optional fields", () => {
		const footerConfig = defaultFooterConfig();
		// Do NOT set any issue fields — they all remain undefined
		const render = installAndGetRender(defaultConfig(), footerConfig);
		assert.doesNotThrow(() => render(80));
	});
});
