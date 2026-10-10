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
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/bridge.test.mts
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import vm from "node:vm";

const requireCjs = createRequire(import.meta.url);

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
// The JSON export can embed the markdown marker inside its source snippets;
// this fixture reproduces that and is the root-cause regression payload.
const MARKED_JSON_FIXTURE = readFileSync(
	resolve(FIXTURE_DIR, "codeflow-report-marked.json"),
	"utf-8",
);
const UI_FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-ui-export.html"), "utf-8");

// The served-UI revision the fixture was captured from and the revision the
// Dockerfile actually builds. They must match: the bridge finds the export
// control by DOM contract only, so a floating upstream checkout would let the
// served UI drift from the fixture (and these tests) silently.
const DOCKERFILE = resolve(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"cmd/cheasee-pi/embedded/docker/codeflow/Dockerfile",
);
const FIXTURE_REVISION = /CodeFlow revision:\s*([0-9a-f]{40})/.exec(UI_FIXTURE)?.[1] ?? null;
const DOCKERFILE_REVISION =
	/CODEFLOW_REF=([0-9a-f]{40})/.exec(readFileSync(DOCKERFILE, "utf-8"))?.[1] ?? null;

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
	const re =
		/<div class="([\w-]+)" data-report-format="([^"]+)">[\s\S]*?<div class="export-option-label">([^<]*)<\/div>/g;
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
	id = "";
	style: { cssText: string } = { cssText: "" };
	children: FakeNode[] = [];

	constructor(
		tag: string,
		opts: {
			attrs?: Record<string, string>;
			text?: string;
			classes?: string[];
			onclick?: () => void;
		} = {},
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
	appendChild(child: FakeNode): void {
		this.children.push(child);
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
	/** The bridge's visible error banner, or null when no failure was shown. */
	errorBanner(): FakeNode | null;
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
	const byId = new Map<string, FakeNode>();
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
			body: {
				appendChild: (node: FakeNode) => {
					if (node.id) byId.set(node.id, node);
				},
			},
			createElement: (tag: string) => new FakeNode(tag),
			getElementById: (id: string) => byId.get(id) ?? null,
			querySelectorAll: (selector: string) => {
				const nodes: FakeNode[] = [];
				if (opts.withExportButton !== false && selector.includes("button"))
					nodes.push(exportButton);
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
		errorBanner: () => byId.get("codeflow-bridge-error") ?? null,
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

function startSink(opts: { postStatus?: number } = {}): Promise<Sink> {
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
				if (opts.postStatus) {
					res.statusCode = opts.postStatus;
					res.end();
					return;
				}
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

	it("Dockerfile pins CodeFlow to the revision the UI fixture was captured from", () => {
		// The served UI (Dockerfile ARG CODEFLOW_REF) and the fixture must never
		// drift apart. Moving the pin means regenerating the fixture from that
		// checkout (generate-ui-fixture.mjs), or the bridge tests below would
		// assert against markup the container no longer serves.
		assert.match(
			DOCKERFILE_REVISION ?? "",
			/^[0-9a-f]{40}$/,
			"Dockerfile must pin the served UI with `ARG CODEFLOW_REF=<40-hex sha>`",
		);
		assert.strictEqual(
			DOCKERFILE_REVISION,
			FIXTURE_REVISION,
			"the served revision (Dockerfile ARG CODEFLOW_REF) must equal the revision codeflow-ui-export.html was captured from; regenerate the fixture when moving the pin",
		);
	});

	it("serves the false-positive filter the headless runner applies", () => {
		const py = readFileSync(SERVER_PY, "utf-8");
		const tag = /_BRIDGE_SCRIPT = b(['"])([\s\S]*?)\1/.exec(py)?.[2];
		assert.ok(tag, "_BRIDGE_SCRIPT not found in server.py");
		assert.strictEqual((tag.match(/fp-filter\.js/g) ?? []).length, 1, "one fp-filter tag");
		assert.strictEqual((tag.match(/codeflow-bridge\.js/g) ?? []).length, 1, "one bridge tag");
		assert.match(py, /_FP_FILTER_ROUTE = "\/fp-filter\.js"/);
		assert.match(py, /_fp_rewrite\(\)/);
		// The wrapper reports a sanitizer failure through the bridge's visible banner.
		assert.match(py, /window\.__codeflowBridgeReportError = reportError/);
		assert.match(py, /__codeflowBridgeReportError\('false-positive filter failed/);

		const filterPath = resolve(SERVER_PY, "..", "fp-filter.js");
		assert.ok(existsSync(filterPath), "fp-filter.js must sit next to server.py");
		assert.match(
			readFileSync(DOCKERFILE, "utf-8"),
			/COPY fp-filter\.js \/opt\/codeflow\/fp-filter\.js/,
		);

		// Browser contract: loaded as a plain script it must publish piFpFilter.
		const sandbox: Record<string, any> = {};
		vm.createContext(sandbox);
		vm.runInContext(readFileSync(filterPath, "utf-8"), sandbox);
		assert.strictEqual(typeof sandbox.piFpFilter?.sanitizeAnalysisData, "function");
		assert.strictEqual(typeof sandbox.piFpFilter?.readFileFrom, "function");
	});

	it("served generateReport wrapper filters a const `data` in place and fails closed", () => {
		// The rewrite is produced by server.py itself (the regex lives there), so
		// this pins the served bytes, not a JS re-implementation of them.
		let rewritten: string;
		try {
			rewritten = execFileSync(
				"python3",
				[
					"-c",
					[
						"import runpy, sys",
						"m = runpy.run_path(sys.argv[1])",
						"pat, repl = m['_UI_REWRITES'][0]",
						"sys.stdout.write(pat.sub(lambda _: repl, b'function generateReport(format){ return data; }').decode())",
					].join("\n"),
					SERVER_PY,
				],
				{ encoding: "utf-8" },
			);
		} catch {
			// python3 unavailable here; the Go suite pins the same contract.
			return;
		}
		const filterPath = resolve(SERVER_PY, "..", "fp-filter.js");
		const piFpFilter = requireCjs(filterPath);

		// A page that declares `data` as a constant: the former `data = ...`
		// rebinding threw and exported unfiltered data.
		const sandbox: Record<string, any> = { piFpFilter, console: { info() {}, error() {} } };
		vm.createContext(sandbox);
		vm.runInContext(
			"const data = { securityIssues: [ { severity: 'high', title: 'Hardcoded Secret', code: '', path: 'x.ts' } ], layerViolations: [] };\n" +
				rewritten +
				"\n;globalThis.__out = generateReport('md');",
			sandbox,
		);
		assert.strictEqual(sandbox.__out.securityIssues.length, 0, "const `data` must be filtered in place");
		assert.strictEqual(sandbox.__out.layerViolations.length, 0);

		// A sanitizer error must fail closed, never fall through to unfiltered data,
		// and must reach the visible bridge error UI (not just the console).
		let reported: string | null = null;
		const throwing: Record<string, any> = {
			piFpFilter: {
				sanitizeAnalysisData() {
					throw new Error("boom");
				},
				readFileFrom() {
					return () => null;
				},
			},
			__codeflowBridgeReportError: (m: string) => {
				reported = m;
			},
			console: { info() {}, error() {} },
		};
		vm.createContext(throwing);
		assert.throws(
			() =>
				vm.runInContext(
					"const data = { securityIssues: [] };\n" + rewritten + "\n;generateReport('md');",
					throwing,
				),
			/boom/,
		);
		assert.strictEqual(throwing.__codeflowFpFilterError, "boom");
		assert.match(reported ?? "", /false-positive filter failed.*boom/);
	});

	it("served-UI fixture still matches the contract the bridge relies on", () => {
		// Mandatory guard: if upstream relabels the export control or menu items,
		// regenerate the fixture (generate-ui-fixture.mjs) and re-check the bridge.
		const buttonLabel = `${UI.button.attrs["aria-label"] ?? ""} ${UI.button.attrs.title ?? ""} ${UI.button.text}`;
		assert.match(buttonLabel, /export/i, "export button label must contain 'export'");
		const labels = UI.options.map((o) => o.label);
		for (const want of ["JSON Report", "Markdown"]) {
			assert.ok(
				labels.includes(want),
				`export menu must contain "${want}" (got ${JSON.stringify(labels)})`,
			);
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

	it("records a capture event and the POST result per format on the bridge-status route", async () => {
		const h = runBridge(sink.base);
		await runAutoTrigger(h);
		await waitForSink(sink.base);
		await waitFor(
			() =>
				postsTo(h, "/api/analysis/bridge-status").some(
					(p) => JSON.parse(p.body).event === "result",
				),
			"bridge-status result events",
		);
		const events = postsTo(h, "/api/analysis/bridge-status").map((p) => JSON.parse(p.body));
		assert.ok(events.some((e) => e.route === "/api/analysis/report" && e.event === "capture"));
		assert.ok(events.some((e) => e.route === "/api/analysis/report.json" && e.event === "capture"));
		assert.ok(
			events.some(
				(e) => e.route === "/api/analysis/report" && e.event === "result" && e.httpStatus === 204,
			),
		);
	});

	it("ignores unrelated Blobs (worker source, raw JSON, plain text)", async () => {
		const h = runBridge(sink.base);
		h.tick();
		await h.flushTimeouts();
		h.posts.length = 0;
		h.sandbox.URL.createObjectURL({
			type: "text/javascript",
			text: async () => "self.onmessage=function(){}",
		});
		h.sandbox.URL.createObjectURL({
			type: "application/json",
			text: async () => '{"files":[],"issues":[]}',
		});
		h.sandbox.URL.createObjectURL({ type: "text/plain", text: async () => "PLAIN TEXT REPORT" });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(h.posts, []);
	});

	it("posts a directly created markdown Blob (capture seam independent of DOM)", async () => {
		const h = runBridge(sink.base, { withExportButton: false });
		h.sandbox.URL.createObjectURL({ type: "text/markdown", text: async () => MD_FIXTURE });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(
			postsTo(h, "/api/analysis/report").map((p) => p.body),
			[MD_FIXTURE],
		);
	});

	it("classifies a marker-bearing JSON export as JSON, not markdown (root-cause regression)", async () => {
		// Guard against a vacuous regression: the payload must actually carry the
		// markdown marker inside a source snippet.
		assert.ok(
			MARKED_JSON_FIXTURE.includes("# CodeFlow Analysis Report"),
			"fixture must embed the markdown marker inside a source snippet",
		);
		const parsed = JSON.parse(MARKED_JSON_FIXTURE);
		assert.ok(
			Array.isArray(parsed.architectureIssues),
			"fixture must parse with an architectureIssues array",
		);

		const h = runBridge(sink.base, { withExportButton: false });
		h.sandbox.URL.createObjectURL({
			type: "application/json",
			text: async () => MARKED_JSON_FIXTURE,
		});
		for (let i = 0; i < 4; i++) await Promise.resolve();

		assert.deepStrictEqual(
			postsTo(h, "/api/analysis/report").map((p) => p.body),
			[],
			"the markdown route must stay empty for a marker-bearing JSON body",
		);
		assert.deepStrictEqual(
			postsTo(h, "/api/analysis/report.json").map((p) => p.body),
			[MARKED_JSON_FIXTURE],
			"the JSON body must POST to the JSON route",
		);
	});

	it("routes a JSON export without the markdown marker to the JSON route", async () => {
		const h = runBridge(sink.base, { withExportButton: false });
		h.sandbox.URL.createObjectURL({ type: "application/json", text: async () => JSON_FIXTURE });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(postsTo(h, "/api/analysis/report"), []);
		assert.deepStrictEqual(
			postsTo(h, "/api/analysis/report.json").map((p) => p.body),
			[JSON_FIXTURE],
		);
	});

	it("falls back to the markdown route for malformed JSON that contains the marker", async () => {
		const body = '{"architectureIssues":[} # CodeFlow Analysis Report';
		const h = runBridge(sink.base, { withExportButton: false });
		h.sandbox.URL.createObjectURL({ type: "text/plain", text: async () => body });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(
			postsTo(h, "/api/analysis/report").map((p) => p.body),
			[body],
		);
		assert.deepStrictEqual(postsTo(h, "/api/analysis/report.json"), []);
	});

	it("requires an architectureIssues array, not just the marker substring", async () => {
		// A JSON body whose architectureIssues is not an array falls back to the
		// marker rule; without the marker the shape rule rejects it entirely.
		const withMarker =
			'{"architectureIssues":"not-array","note":"# CodeFlow Analysis Report"}';
		const h = runBridge(sink.base, { withExportButton: false });
		h.sandbox.URL.createObjectURL({ type: "text/plain", text: async () => withMarker });
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(
			postsTo(h, "/api/analysis/report").map((p) => p.body),
			[withMarker],
		);
		assert.deepStrictEqual(postsTo(h, "/api/analysis/report.json"), []);

		const h2 = runBridge(sink.base, { withExportButton: false });
		h2.sandbox.URL.createObjectURL({
			type: "application/json",
			text: async () => '{"architectureIssues":"not-array"}',
		});
		for (let i = 0; i < 4; i++) await Promise.resolve();
		assert.deepStrictEqual(h2.posts, []);
	});

	it("reports the capture route that matches the actual POST destination", async () => {
		const h = runBridge(sink.base, { withExportButton: false });
		h.sandbox.URL.createObjectURL({
			type: "application/json",
			text: async () => MARKED_JSON_FIXTURE,
		});
		for (let i = 0; i < 4; i++) await Promise.resolve();
		const capture = postsTo(h, "/api/analysis/bridge-status")
			.map((p) => JSON.parse(p.body))
			.find((e) => e.event === "capture");
		assert.ok(capture, "a capture event must be recorded");
		assert.strictEqual(capture.route, "/api/analysis/report.json");
	});

	it("does nothing when no export control is present", async () => {
		const h = runBridge(sink.base, { withExportButton: false });
		await runAutoTrigger(h);
		assert.deepStrictEqual(h.posts, []);
	});

	it("surfaces a non-2xx POST (413 oversize) instead of swallowing it", async () => {
		// Without this the endpoint stays empty and pi only reports "no analysis
		// yet", so the operator re-runs an analysis that keeps failing.
		const failing = await startSink({ postStatus: 413 });
		try {
			const h = runBridge(failing.base);
			await runAutoTrigger(h);
			await waitFor(() => h.errorBanner() !== null, "error banner");
			const text = String(h.errorBanner()?.textContent ?? "");
			assert.match(text, /HTTP 413/);
			assert.match(text, /16 MiB/, "413 must name the size cap");
			assert.match(String(h.sandbox.window.__codeflowBridgeError ?? ""), /HTTP 413/);
		} finally {
			await failing.close();
		}
	});

	it("surfaces a network failure (unreachable endpoint)", async () => {
		// Port 1 is unbound: fetch rejects with a connection error.
		const h = runBridge("http://127.0.0.1:1");
		await runAutoTrigger(h);
		await waitFor(() => h.errorBanner() !== null, "error banner");
		assert.match(String(h.sandbox.window.__codeflowBridgeError ?? ""), /unreachable/);
	});
});

/** Poll until `pred()` is truthy, or throw after a timeout (host-realm timer). */
async function waitFor(pred: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

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
