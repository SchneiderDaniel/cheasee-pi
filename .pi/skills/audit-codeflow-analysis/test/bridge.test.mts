import assert from "node:assert";

import { execFileSync } from "node:child_process";

import { existsSync, readFileSync, readdirSync } from "node:fs";

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

/** server.py plus its sibling modules — the shim is the whole directory. */
function readShim(): string {
	const dir = resolve(SERVER_PY, "..");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".py"))
		.sort()
		.map((f) => readFileSync(resolve(dir, f), "utf-8"))
		.join("\n");
}

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const MD_FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.md"), "utf-8");

const JSON_FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-report.json"), "utf-8");

const MARKED_JSON_FIXTURE = readFileSync(
	resolve(FIXTURE_DIR, "codeflow-report-marked.json"),
	"utf-8",
);

const UI_FIXTURE = readFileSync(resolve(FIXTURE_DIR, "codeflow-ui-export.html"), "utf-8");

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

const REPORT_ROUTES: Record<string, string> = {
	"/api/analysis/report": "text/markdown; charset=utf-8",
	"/api/analysis/report.json": "application/json; charset=utf-8",
};

function extractBridgeJs(): string {
	const py = readShim();
	const m = /_?BRIDGE_JS = br?"""([\s\S]*?)"""/.exec(py);
	assert.ok(m, "_BRIDGE_JS constant not found in the shim modules");
	return m[1];
}

const BRIDGE_JS = extractBridgeJs();

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

const FORMAT_BLOBS: Record<string, { type: string; text: string }> = {
	json: { type: "application/json", text: JSON_FIXTURE },
	md: { type: "text/markdown", text: MD_FIXTURE },
	txt: { type: "text/plain", text: "PLAIN TEXT REPORT" },
};

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
	/** Simulate the user picking a format from the served Export menu. */
	exportAs(format: string): void;
	/** Settle the async capture microtasks. */
	settle(): Promise<void>;
}

function runBridge(base: string, opts: { withExportButton?: boolean } = {}): Harness {
	const posts: Post[] = [];
	const byId = new Map<string, FakeNode>();
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
		exportAs: (format) => {
			exportButton.click();
			const idx = UI.options.findIndex((o) => o.format === format);
			if (idx >= 0) menuItems[idx]?.click();
		},
		settle: async () => {
			for (let i = 0; i < 4; i++) await Promise.resolve();
		},
	};
}

const postsTo = (h: Harness, suffix: string) => h.posts.filter((p) => p.url.endsWith(suffix));

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

async function waitFor(pred: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

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
		const py = readShim();
		const tuple = /_FP_FILTER_MODULES = \(([\s\S]*?)\n\)/.exec(py)?.[1] ?? "";
		const modules = [...tuple.matchAll(/"([\w/-]+)"/g)].map((m) => m[1]);
		assert.equal(
			modules.length,
			9,
			"_FP_FILTER_MODULES must pin the eight policy modules plus the application step",
		);
		assert.equal(modules[modules.length - 1], "browser-glue", "the seam's application step loads last");
		assert.match(py, /_FP_FILTER_ROUTE = "\/fp-filter\.js"/);
		assert.match(py, /_fp_seam_rewrite\(\)/);
		// The wrapper reports a sanitizer failure through the bridge's visible banner.
		assert.match(py, /window\.__codeflowBridgeReportError = reportError/);

		// Issue #2147: the filter runs once at analysis completion, so the dashboard
		// score and the exports read the same data. The application step lives in the
		// glue; the seam only calls it.
		assert.match(py, /_FP_SEAM_HEAD = b"function runAnalysisData"/);
		assert.match(py, /piFpFilterBrowserGlue\.applyFalsePositiveFilter\(__piFpData\)/);
		const glue = readFileSync(resolve(SERVER_PY, "..", "fp-filter", "browser-glue.js"), "utf-8");
		assert.match(glue, /piFpFilterBrowserGlue/);
		assert.match(glue, /__codeflowBridgeReportError/);
		assert.match(glue, /"false-positive filter failed; report not exported: "/);
		// Every field the report summaries read moves with the arrays that name it.
		for (const field of [
			"securityIssues",
			"layerViolations",
			"deadFunctions",
			"unusedFunctions",
			"duplicates",
			"issues",
			"suggestions",
			"stats",
		]) {
			assert.ok(glue.includes(`"${field}"`), `the glue must copy ${field} back`);
		}
		assert.match(glue, /" unused function\(s\)/);
		assert.match(glue, /" duplicate group\(s\)"/);
		assert.match(glue, /derivation unavailable/);
		// Browser parity needs source: the analyzer frees `f.content`, so the served
		// index.html keeps the text on `piFpSource` for the in-page filter.
		assert.match(py, /f\.piFpSource=f\.content;f\.content=null;/);

		const filterPath = resolve(SERVER_PY, "..", "fp-filter.js");
		assert.ok(existsSync(filterPath), "fp-filter.js must sit next to server.py");
		assert.match(
			readFileSync(DOCKERFILE, "utf-8"),
			/COPY fp-filter\.js \/opt\/codeflow\/fp-filter\.js/,
		);

		// Browser contract: the page loads every module tag, then the index, which
		// publishes piFpFilter from the globals they publish.
		const sandbox: Record<string, any> = {};
		vm.createContext(sandbox);
		for (const m of modules) {
			if (m === "browser-glue") continue; // the application step, not a policy module
			const path = resolve(SERVER_PY, "..", "fp-filter", `${m}.js`);
			vm.runInContext(readFileSync(path, "utf-8"), sandbox);
		}
		vm.runInContext(readFileSync(filterPath, "utf-8"), sandbox);
		assert.strictEqual(typeof sandbox.piFpFilter?.sanitizeAnalysisData, "function");
		assert.strictEqual(typeof sandbox.piFpFilter?.readFileFrom, "function");
		vm.runInContext(
			readFileSync(resolve(SERVER_PY, "..", "fp-filter", "browser-glue.js"), "utf-8"),
			sandbox,
		);
		assert.strictEqual(typeof sandbox.piFpFilterBrowserGlue?.applyFalsePositiveFilter, "function");
	});
	it("served analysis seam filters in place and fails closed", async () => {
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
						"src = b'function runAnalysisData(options){ return buildAnalysisData(options); }'",
						"sys.stdout.write(pat.sub(lambda _: repl, src).decode())",
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
		const gluePath = resolve(SERVER_PY, "..", "fp-filter", "browser-glue.js");

		/** A page: the served policy and glue, a stubbed analyzer, log capture. */
		function page(data: unknown, extra: Record<string, any> = {}) {
			const logs: string[] = [];
			const sandbox: Record<string, any> = {
				console: { info: (m: string) => logs.push(String(m)), error() {} },
				buildAnalysisData: () => Promise.resolve(data),
				...extra,
			};
			vm.createContext(sandbox);
			for (const name of readdirSync(resolve(SERVER_PY, "..", "fp-filter"), {
				recursive: true,
			}) as string[]) {
				if (!name.endsWith(".js")) continue;
				vm.runInContext(
					readFileSync(resolve(SERVER_PY, "..", "fp-filter", name), "utf-8"),
					sandbox,
					{ filename: `${name}.js` },
				);
			}
			vm.runInContext(readFileSync(filterPath, "utf-8"), sandbox);
			vm.runInContext(readFileSync(gluePath, "utf-8"), sandbox);
			vm.runInContext(rewritten, sandbox, { filename: "served-seam.js" });
			return { sandbox, logs };
		}

		const { sandbox, logs } = page({
			securityIssues: [
				{ severity: "high", title: "Hardcoded Secret", code: "", path: "x.ts" },
				{ severity: "low", title: "Code Comments", code: "", path: "src/widget.test.ts" },
				{ severity: "low", title: "Debug Statements", code: "", path: "docs/guide.md" },
				{ severity: "low", title: "Code Comments", code: "", path: "src/keep.ts" },
			],
			layerViolations: [],
			stats: { dead: 1, security: 1, violations: 0 },
			files: [
				{ path: "def.ts", content: null, piFpSource: "export function deadCall() {}" },
				{ path: "use.ts", content: null, piFpSource: "function run() { deadCall(); }" },
			],
			deadFunctions: [{ name: "deadCall", file: "def.ts" }],
			issues: [
				{
					type: "warning",
					title: "1 Unused Functions",
					items: [{ name: "deadCall", file: "def.ts" }],
				},
			],
		});
		const out = await vm.runInContext("runAnalysisData({ analyzed: [], allFns: [] })", sandbox);
		assert.deepStrictEqual(
			Array.from(out.securityIssues as Array<{ path: string }>, (s) => s.path),
			["src/keep.ts"],
			"the analysis result must be filtered in place: only the shipping marker survives",
		);
		assert.strictEqual(out.layerViolations.length, 0);
		assert.strictEqual(Array.from(out.deadFunctions as unknown[]).length, 0, "the seam drops the dead list it can disprove");
		assert.strictEqual(out.stats.dead, 0, "the served stats must agree with the list");
		assert.strictEqual(Array.from(out.issues as unknown[]).length, 0, "the architecture entry must not outlive its items");
		// Upstream frees each file's source on purpose; the seam must release the
		// text it retained for the filter once the filter has read it.
		assert.ok(
			out.files.every((f: { piFpSource: unknown }) => f.piFpSource === null),
			"the served page must not retain the analyzed source",
		);
		// Byte-parity with the headless stderr line (see codeflow-run-analysis.test.mts).
		assert.deepStrictEqual(logs, [
			"fp-filter: suppressed 1 security issue(s), 0 layer violation(s), 2 hygiene finding(s), 1 unused function(s), 0 duplicate group(s)",
		]);

		// A sanitizer error must fail closed, never fall through to unfiltered data,
		// and must reach the visible bridge error UI (not just the console).
		let reported: string | null = null;
		const throwing = page(
			{ securityIssues: [] },
			{
				__codeflowBridgeReportError: (m: string) => {
					reported = m;
				},
			},
		);
		// The glue resolves `piFpFilter` at call time, so break the policy before the run.
		vm.runInContext(
			"piFpFilter = { sanitizeAnalysisData: function () { throw new Error('boom'); }, readFileFrom: function () { return function () { return null; }; } };",
			throwing.sandbox,
		);
		await assert.rejects(
			vm.runInContext("runAnalysisData({ analyzed: [], allFns: [] })", throwing.sandbox),
			/boom/,
		);
		assert.strictEqual(throwing.sandbox.__codeflowFpFilterError, "boom");
		assert.match(reported ?? "", /false-positive filter failed.*boom/);
	});
});
