/**
 * Tests for the CodeFlow browser bridge (`_BRIDGE_JS` in server.py).
 *
 * The bridge is the one piece that runs inside the CodeFlow page, so it cannot
 * be exercised by the Go/python adapter tests — and a DOM string mismatch would
 * leave the report endpoint empty after analysis. This harness extracts the
 * exact JS served at `/codeflow-bridge.js`, runs it in a `node:vm` sandbox, and
 * drives the real flow: an export button whose label lives in `aria-label`
 * (empty text node, as after analysis) opens a menu of `export-option` items
 * labelled "JSON Report" / "Markdown", and each download Blob flows through the
 * hooked `URL.createObjectURL` to a recorded `fetch`.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/codeflow-analysis/test/bridge.test.mts
 */

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

const SERVER_PY = resolve(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"cmd/cheasee-pi/embedded/docker/codeflow/server.py",
);
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
const MD_FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.md"), "utf-8");
const JSON_FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.json"), "utf-8");

/** Extract the served bridge JS from the python byte constant. */
function extractBridgeJs(): string {
	const py = readFileSync(SERVER_PY, "utf-8");
	const m = /_BRIDGE_JS = br?"""([\s\S]*?)"""/.exec(py);
	assert.ok(m, "_BRIDGE_JS constant not found in server.py");
	return m[1];
}

const BRIDGE_JS = extractBridgeJs();

// ── Minimal DOM modelled on the served CodeFlow UI (b0e82d1) ──

class FakeNode {
	tagName: string;
	textContent: string;
	attrs: Record<string, string>;
	classes: Set<string>;
	onclick: (() => void) | null;

	constructor(
		tag: string,
		opts: { attrs?: Record<string, string>; text?: string; classes?: string[]; onclick?: () => void } = {},
	) {
		this.tagName = tag.toUpperCase();
		this.attrs = opts.attrs ?? {};
		this.textContent = opts.text ?? "";
		this.classes = new Set(opts.classes ?? []);
		this.onclick = opts.onclick ?? null;
	}
	getAttribute(name: string): string | null {
		return this.attrs[name] ?? null;
	}
	click(): void {
		this.onclick?.();
	}
}

function matches(node: FakeNode, selector: string): boolean {
	const sel = selector.trim();
	const attr = /^\[([\w-]+)=([\w-]+)\]$/.exec(sel);
	if (attr) return node.getAttribute(attr[1]) === attr[2];
	if (sel.startsWith(".")) return node.classes.has(sel.slice(1));
	return node.tagName === sel.toUpperCase();
}

interface Post {
	url: string;
	body: string;
}

interface Harness {
	posts: Post[];
	sandbox: any;
	/** Run one poll tick of the bridge's auto-trigger interval. */
	tick(): void;
	/** Flush queued setTimeouts and settle the async capture microtasks. */
	flushTimeouts(): Promise<void>;
}

/** Flush repeated auto-trigger ticks until the pending queue drains. */
async function runAutoTrigger(h: Harness, ticks = 4): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		h.tick();
		await h.flushTimeouts();
	}
}

async function runBridge(opts: { withExportButton?: boolean } = {}): Promise<Harness> {
	const posts: Post[] = [];
	const timeouts: Array<() => void> = [];
	let intervalCb: (() => void) | null = null;
	let menuOpen = false;

	const exportButton = new FakeNode("button", {
		attrs: { "aria-label": "Export analysis", title: "Export analysis" },
		text: "", // the real button drops its text node once analysis data exists
		onclick: () => {
			menuOpen = true;
		},
	});

	const blobs: Record<string, { type: string; text: string }> = {
		"JSON Report": { type: "application/json", text: JSON_FIXTURE },
		Markdown: { type: "text/markdown", text: MD_FIXTURE },
	};
	const menuItems: FakeNode[] = Object.keys(blobs).map(
		(label) =>
			new FakeNode("div", {
				classes: ["export-option"],
				text: label,
				onclick: () => {
					menuOpen = false;
					sandbox.URL.createObjectURL({ type: blobs[label].type, text: async () => blobs[label].text });
				},
			}),
	);

	const sandbox: any = {
		window: {},
		document: {
			body: {},
			querySelectorAll: (selector: string) => {
				const nodes: FakeNode[] = [];
				if (opts.withExportButton !== false && selector.includes("button")) nodes.push(exportButton);
				if (selector.includes(".export-option") && menuOpen) nodes.push(...menuItems);
				return nodes.filter((n) => selector.split(",").some((s) => matches(n, s)));
			},
		},
		fetch: (url: string, init: any) => {
			posts.push({ url, body: String(init?.body ?? "") });
			return Promise.resolve({ ok: true });
		},
		setInterval: (cb: () => void) => {
			intervalCb = cb;
		},
		setTimeout: (cb: () => void) => {
			timeouts.push(cb);
		},
		URL: {
			createObjectURL: (_obj: unknown) => "blob:original",
			revokeObjectURL: () => {},
		},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(BRIDGE_JS, sandbox);

	return {
		posts,
		sandbox,
		tick: () => intervalCb?.(),
		flushTimeouts: async () => {
			for (const cb of timeouts.splice(0)) cb();
			// Let the hooked Blob.text() -> capture -> fetch microtasks settle.
			for (let i = 0; i < 4; i++) await Promise.resolve();
		},
	};
}

const postsTo = (h: Harness, suffix: string) => h.posts.filter((p) => p.url.endsWith(suffix));

describe("codeflow bridge capture", () => {
	it("is valid JavaScript", () => {
		assert.doesNotThrow(() => new vm.Script(BRIDGE_JS));
	});

	it("drives the real aria-labelled flow and captures both formats byte-for-byte", async () => {
		const h = await runBridge();
		await runAutoTrigger(h);
		const md = postsTo(h, "/api/analysis/report");
		const json = postsTo(h, "/api/analysis/report.json");
		assert.strictEqual(md.length, 1, "expected exactly one markdown POST");
		assert.strictEqual(json.length, 1, "expected exactly one JSON POST");
		assert.strictEqual(md[0].body, MD_FIXTURE);
		assert.strictEqual(json[0].body, JSON_FIXTURE);
	});

	it("ignores unrelated Blobs (worker source, raw JSON, plain text)", async () => {
		const h = await runBridge();
		h.tick();
		await h.flushTimeouts();
		h.posts.length = 0;
		h.sandbox.URL.createObjectURL({ type: "text/javascript", text: async () => "self.onmessage=function(){}" });
		h.sandbox.URL.createObjectURL({ type: "application/json", text: async () => '{"files":[],"issues":[]}' });
		h.sandbox.URL.createObjectURL({ type: "text/plain", text: async () => "PLAIN TEXT REPORT" });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(h.posts, []);
	});

	it("posts a directly created markdown Blob (capture seam independent of DOM)", async () => {
		const h = await runBridge({ withExportButton: false });
		h.sandbox.URL.createObjectURL({ type: "text/markdown", text: async () => MD_FIXTURE });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(postsTo(h, "/api/analysis/report").map((p) => p.body), [MD_FIXTURE]);
	});

	it("does nothing when no export control is present", async () => {
		const h = await runBridge({ withExportButton: false });
		await runAutoTrigger(h);
		assert.deepStrictEqual(h.posts, []);
	});

	it("matched labels still exist in the served CodeFlow UI (skipped without a checkout)", (t) => {
		// Optional provenance check: point CODEFLOW_UI at a CodeFlow index.html to
		// prove the bridge's DOM strings are still the ones the UI renders.
		const ui = process.env.CODEFLOW_UI;
		if (!ui || !existsSync(ui)) return t.skip("CODEFLOW_UI not set to a CodeFlow index.html");
		const html = readFileSync(ui, "utf-8");
		for (const needle of ["aria-label':'Export analysis'", "'JSON Report'", "'Markdown'", "export-option"]) {
			assert.ok(html.includes(needle), `served CodeFlow UI is missing ${needle}`);
		}
	});
});
