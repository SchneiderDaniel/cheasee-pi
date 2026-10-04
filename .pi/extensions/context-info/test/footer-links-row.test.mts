/**
 * Tests for footer row 3 — right-aligned UI · CodeFlow service links.
 *
 * Validates the unconditional OSC 8, two-part layout: links kept and
 * right-aligned, left session/trust content truncated first on narrow
 * terminals.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/footer-links-row.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { installFooter } from "../footer.ts";
import { createDefaultFooterConfig } from "../footer-state.ts";
import type { ContextStatusBarConfig, FooterConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCtx() {
	return {
		mode: "tui",
		ui: { setFooter: () => {}, setStatus: () => {} },
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

/** Install the footer and return its render function. */
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
				{ fg: (_color: string, text: string) => text },
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

function withHyperlinks<T>(enabled: boolean, fn: () => T): T {
	try {
		setCapabilities({ hyperlinks: enabled, images: null, trueColor: true });
		return fn();
	} finally {
		resetCapabilitiesCache();
	}
}

/** Last row (row 3 when no issue data is set). */
function row3(rows: string[]): string {
	return rows[rows.length - 1]!;
}

const UI_URL = "http://127.0.0.1:9600";
const CF_URL = "http://localhost:9100/?repo=local/workspace&run=1";

function configWith(uiUrl: string | null, codeflowUrl: string | null): FooterConfig {
	const c = createDefaultFooterConfig();
	c.uiUrl = uiUrl;
	c.codeflowUrl = codeflowUrl;
	return c;
}

function countOpeners(s: string): number {
	return (s.match(/\x1b\]8;;http/g) ?? []).length;
}
function countClosers(s: string): number {
	return (s.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
}

afterEach(() => {
	resetCapabilitiesCache();
});

// ---------------------------------------------------------------------------
// Render: presence + OSC 8 wrapping
// ---------------------------------------------------------------------------

describe("footer row 3 — service links", () => {
	it("both URLs set + hyperlinks → left content then UI · CodeFlow, UI before CodeFlow", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.ok(line.includes("UI"), "row 3 must contain UI");
		assert.ok(line.includes(" · "), "row 3 must contain the · separator");
		assert.ok(line.includes("CodeFlow"), "row 3 must contain CodeFlow");
		assert.ok(line.indexOf("UI") < line.indexOf("CodeFlow"), "UI must precede CodeFlow");
	});

	it("exact OSC 8 targets for both links", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.ok(
			line.includes(`\x1b]8;;${UI_URL}\x1b\\UI`),
			"UI must be wrapped with its OSC 8 target",
		);
		assert.ok(
			line.includes(`\x1b]8;;${CF_URL}\x1b\\CodeFlow`),
			"CodeFlow must be wrapped with its OSC 8 target",
		);
	});

	it("hyperlinks:false → labels still carry OSC 8 (unconditional, matches issue row)", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const line = withHyperlinks(false, () => row3(render(80)));
		assert.ok(line.includes("UI") && line.includes("CodeFlow"), "labels must render");
		assert.ok(
			line.includes(`\x1b]8;;${UI_URL}\x1b\\UI`),
			"UI must be OSC 8-wrapped even when the capability probe reports false",
		);
	});

	it("only uiUrl set → UI present, CodeFlow absent", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, null));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.ok(line.includes("UI"), "UI must be shown");
		assert.ok(!line.includes("CodeFlow"), "CodeFlow must be absent");
	});

	it("only codeflowUrl set → CodeFlow present, UI absent", () => {
		const render = installAndGetRender(defaultConfig(), configWith(null, CF_URL));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.ok(line.includes("CodeFlow"), "CodeFlow must be shown");
		assert.ok(!line.includes("UI"), "UI label must be absent");
	});

	it("neither set → no labels, no OSC 8, row 3 unchanged shape", () => {
		const render = installAndGetRender(defaultConfig(), configWith(null, null));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.ok(!line.includes("CodeFlow"), "no CodeFlow label");
		assert.ok(!line.includes("\x1b]8;;"), "no OSC 8 sequence");
		assert.ok(line.includes("❓"), "trust indicator still renders");
	});

	it("undefined legacy URLs treated as absent, no throw", () => {
		const c = createDefaultFooterConfig();
		(c as any).uiUrl = undefined;
		(c as any).codeflowUrl = undefined;
		const render = installAndGetRender(defaultConfig(), c);
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.ok(!line.includes("CodeFlow") && !line.includes("\x1b]8;;"), "undefined URLs are falsy");
	});
});

// ---------------------------------------------------------------------------
// Layout: right-alignment + AC5 narrow widths
// ---------------------------------------------------------------------------

describe("footer row 3 — layout", () => {
	it("right-aligned: width 80, short left content → group flush right", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.strictEqual(visibleWidth(line), 80, "row 3 must fill the terminal width");
		assert.ok(line.endsWith("CodeFlow\x1b]8;;\x1b\\"), "group must be flush right");
	});

	it("padding math uses visibleWidth, not raw .length (OSC bytes exceed width)", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.ok(line.length > 80, "raw row length exceeds width due to OSC 8 bytes");
		assert.strictEqual(visibleWidth(line), 80, "visible width must equal the terminal width");
	});

	it("AC5: width 30 with a long session name → both labels present, left truncated", () => {
		const c = configWith(UI_URL, CF_URL);
		c.sessionName = "a-very-long-session-name-that-will-not-fit";
		const render = installAndGetRender(defaultConfig(), c);
		const line = withHyperlinks(true, () => row3(render(30)));
		assert.ok(line.includes("UI") && line.includes("CodeFlow"), "links must survive narrow widths");
		assert.ok(line.includes("..."), "left content must be truncated");
		assert.strictEqual(visibleWidth(line), 30, "row must fit the width");
	});

	it("AC5: width exactly the group width (13) → group intact, left dropped", () => {
		const c = configWith(UI_URL, CF_URL);
		c.sessionName = "long-session-name";
		const render = installAndGetRender(defaultConfig(), c);
		const line = withHyperlinks(true, () => row3(render(13)));
		assert.ok(
			line.includes("UI") && line.includes("CodeFlow"),
			"group must stay intact at width 13",
		);
		assert.ok(!line.includes("Session:"), "left session content must be dropped");
		assert.strictEqual(visibleWidth(line), 13);
	});

	it("AC5: width below group width → every OSC 8 opener is closed, no throw", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const line = withHyperlinks(true, () => row3(render(10)));
		assert.strictEqual(
			countOpeners(line),
			countClosers(line),
			"OSC 8 must be balanced after truncation",
		);
	});

	it("OSC 8 balance: closer count equals link count when both set", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const line = withHyperlinks(true, () => row3(render(80)));
		assert.strictEqual(countOpeners(line), 2, "two link openers");
		assert.strictEqual(countClosers(line), 2, "two link closers");
	});

	it("byte-stable: two consecutive renders produce identical row 3 strings", () => {
		const render = installAndGetRender(defaultConfig(), configWith(UI_URL, CF_URL));
		const [first, second] = withHyperlinks(
			true,
			() => [row3(render(80)), row3(render(80))] as const,
		);
		assert.strictEqual(first, second, "row 3 must be byte-stable for TuiAltScreen line diffing");
	});
});

// ---------------------------------------------------------------------------
// Click path: the host terminal opens the link (pi does not intercept it)
// ---------------------------------------------------------------------------

describe("footer row 3 — host-terminal click path", () => {
	it("installed pi-tui does not enable SGR mouse tracking", () => {
		// The footer emits OSC 8 links to the session PTY (the host terminal),
		// which is the click handler and opens the loopback URL in the host
		// browser. That contract holds only while pi-tui leaves SGR mouse
		// reporting OFF: if a future pi-tui enables it and routes an OSC 8 hit
		// to its own openUrl → openBrowser (`xdg-open`), the click would be
		// intercepted inside the container, where the image has no xdg-open and
		// the host-loopback URL is unroutable. This guard fails loudly (the
		// product is unchanged) so the click contract gets re-validated at that
		// upgrade.
		const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")));
		const sources = ["index.js", "tui.js", "terminal.js"]
			.map((f) => join(dist, f))
			.map((f) => {
				try {
					return readFileSync(f, "utf-8");
				} catch {
					return "";
				}
			})
			.join("\n");
		for (const seq of ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h", "\x1b[?1006h"]) {
			assert.ok(
				!sources.includes(seq),
				`pi-tui now enables SGR mouse tracking (${seq}) — re-validate the footer link click path`,
			);
		}
	});
});
