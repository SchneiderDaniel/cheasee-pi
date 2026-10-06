/**
 * Tests for the CodeFlow browser bridge (`_BRIDGE_JS` in server.py).
 *
 * The bridge is the one piece that runs inside the CodeFlow page, so it cannot
 * be exercised by the Go/python adapter tests — and a DOM string mismatch would
 * leave the report endpoint empty after analysis. This harness extracts the
 * exact JS served at `/codeflow-bridge.js`, runs it in a `node:vm` sandbox, and
 * drives the export flow against the *served* UI contract: the export button and
 * menu markup are read from `fixtures/codeflow-ui-export.html`, which
 * `generate-ui-fixture.mjs` captures from the real CodeFlow `index.html`. A UI
 * relabel/restructure therefore fails these tests (mandatory, no skip) rather
 * than silently breaking the capture.
 *
 * Captured exports are POSTed to a real in-process HTTP server and read back
 * with GET, exercising the full export → POST → GET round trip.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/codeflow-analysis/test/bridge.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
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
const UI_FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-ui-export.html"), "utf-8");

/** The report routes the bridge POSTs to (mirrors server.py). */
const REPORT_ROUTES: Record<string, string> = {
	"/api/analysis/report": "text/markdown; charset=utf-8",
	"/api/analysis/report.json": "application/json; charset=utf-8",
};

/** Extract the served bridge JS from the python byte constant. */
function extractBridgeJs(): string {
	const py = readFileSync(SERVER_PY, "utf-8");
	const m = /_BRIDGE_JS = br?"""([\s\S]*?)"""/.exec(py);
	assert.ok(m, "_BRIDGE_JS constant not found in server.py");
	return m[1];
}

const BRIDGE_JS = extractBridgeJs();

// ── The served-UI contract, read from the captured fixture ──

interface UiContract {
	button: { tag: string; attrs: Record<string, string>; text: string };
	options: Array<{ cls: string; format: string; label: string }>;
}

function parseUiContract(html: string): UiContract {
	const btn = /<button\b([^>]*)>([^<]*)<\/button>/.exec(html);
	assert.ok(btn, "export button missing from codeflow-ui-export.html");
	const attrs: Record<string, string> = {};
	for (const a of btn[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
	const options: UiContract["options"] = [];
	const re = /<div class="([\w-]+)" data-report-format="([^"]+)">[\s\S]*?<div class="export-option-label">([^<]*)<\/div>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) options.push({ cls: m[1], format: m[2], label: m[3] });
	return { button: { tag: "button", attrs, text: btn[2] }, options };
}

const UI = parseUiContract(UI_FIXTURE);

/**
 * The export Blob each menu item produces, keyed by the fixture's format. The
 * bridge classifies by content marker (not MIME), so the `txt` entry is plain
 * text and must be ignored.
 */
const FORMAT_BLOBS: Record<string, { type: string; text: string }> = {
	json: { type: "application/json", text: JSON_FIXTURE },
	md: { type: "text/markdown", text: MD_FIXTURE },
	txt: { type: "text/plain", text: "PLAIN TEXT REPORT" },
};

// ── Minimal DOM modelled on the captured served-UI contract ──

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

function runBridge(base: string, opts: { withExportButton?: boolean } = {}): Harness {
	const posts: Post[] = [];
	const timeouts: Array<() => void> = [];
	let intervalCb: (() => void) | null = null;
	let menuOpen = false;

	const exportButton = new FakeNode(UI.button.tag, {
		attrs: UI.button.attrs,
		text: UI.button.text,
		onclick: () => {
			menuOpen = true;
		},
	});

	const menuItems: FakeNode[] = UI.options.map(
		(o) =>
			new FakeNode("div", {
				classes: [o.cls],
				text: o.label,
				onclick: () => {
					menuOpen = false;
					const blob = FORMAT_BLOBS[o.format];
					if (blob) sandbox.URL.createObjectURL({ type: blob.type, text: async () => blob.text });
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
			return fetch(new URL(url, base).href, init);
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
			for (let i = 0; i < 4; i++) await Promise.resolve();
		},
	};
}

const postsTo = (h: Harness, suffix: string) => h.posts.filter((p) => p.url.endsWith(suffix));

// ── Real in-process report sink (export -> POST -> GET) ──

interface Sink {
	base: string;
	server: Server;
	close(): Promise<void>;
}

function startSink(): Promise<Sink> {
	const store = new Map<string, { body: string; at: number }>();
	const server = createServer((req, res) => {
		const route = (req.url ?? "").split("?")[0];
		const type = REPORT_ROUTES[route];
		if (!type) {
			res.statusCode = 404;
			res.end();
			return;
		}
		if (req.method === "POST") {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				store.set(route, { body: Buffer.concat(chunks).toString("utf-8"), at: Date.now() });
				res.statusCode = 204;
				res.end();
			});
			return;
		}
		const hit = store.get(route);
		if (!hit) {
			res.statusCode = 404;
			res.end();
			return;
		}
		res.setHeader("Content-Type", type);
		res.setHeader("X-Codeflow-Analysis-At", String(hit.at));
		res.end(hit.body);
	});
	return new Promise((resolveSink) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolveSink({
				base: `http://127.0.0.1:${port}`,
				server,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

describe("codeflow bridge capture", () => {
	let sink: Sink;

	before(async () => {
		sink = await startSink();
	});
	after(async () => {
		await sink.close();
	});

	it("is valid JavaScript", () => {
		assert.doesNotThrow(() => new vm.Script(BRIDGE_JS));
	});

	it("served-UI fixture still matches the contract the bridge relies on", () => {
		// Mandatory guard: if upstream relabels the export control or menu items,
		// regenerate the fixture (generate-ui-fixture.mjs) and re-check the bridge.
		const buttonLabel = `${UI.button.attrs["aria-label"] ?? ""} ${UI.button.attrs.title ?? ""} ${UI.button.text}`;
		assert.match(buttonLabel, /export/i, "export button label must contain 'export'");
		const labels = UI.options.map((o) => o.label);
		for (const want of ["JSON Report", "Markdown"]) {
			assert.ok(labels.includes(want), `export menu must contain "${want}" (got ${JSON.stringify(labels)})`);
		}
	});

	it("drives the served export flow and round-trips both formats byte-for-byte", async () => {
		const h = runBridge(sink.base);
		await runAutoTrigger(h);
		await waitForSink(sink.base);
		const md = postsTo(h, "/api/analysis/report");
		const json = postsTo(h, "/api/analysis/report.json");
		assert.strictEqual(md.length, 1, "expected exactly one markdown POST");
		assert.strictEqual(json.length, 1, "expected exactly one JSON POST");

		// Export -> POST -> GET: the served UI's exports are retrievable verbatim.
		const gotMd = await fetch(sink.base + "/api/analysis/report");
		assert.strictEqual(gotMd.status, 200);
		assert.strictEqual(await gotMd.text(), MD_FIXTURE);
		const gotJson = await fetch(sink.base + "/api/analysis/report.json");
		assert.strictEqual(gotJson.status, 200);
		assert.strictEqual(await gotJson.text(), JSON_FIXTURE);
		assert.ok(Number(gotMd.headers.get("X-Codeflow-Analysis-At")) > 1.6e12);
	});

	it("ignores unrelated Blobs (worker source, raw JSON, plain text)", async () => {
		const h = runBridge(sink.base);
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
		const h = runBridge(sink.base, { withExportButton: false });
		h.sandbox.URL.createObjectURL({ type: "text/markdown", text: async () => MD_FIXTURE });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(postsTo(h, "/api/analysis/report").map((p) => p.body), [MD_FIXTURE]);
	});

	it("does nothing when no export control is present", async () => {
		const h = runBridge(sink.base, { withExportButton: false });
		await runAutoTrigger(h);
		assert.deepStrictEqual(h.posts, []);
	});
});

/** Poll the sink until both report routes have received a POST (the network
 * delivery lags the synchronous in-sandbox fetch call). */
async function waitForSink(base: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const [md, json] = await Promise.all([
			fetch(base + "/api/analysis/report"),
			fetch(base + "/api/analysis/report.json"),
		]);
		if (md.status === 200 && json.status === 200) return;
		if (Date.now() > deadline) throw new Error("report sink never received both formats");
		await new Promise((r) => setTimeout(r, 20));
	}
}
