import assert from "node:assert";

import { readFileSync } from "node:fs";

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

const REWRITES_PY = resolve(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"cmd/cheasee-pi/embedded/docker/codeflow/server_rewrites.py",
);

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
	const py = readFileSync(REWRITES_PY, "utf-8");
	const m = /_BRIDGE_JS = br?"""([\s\S]*?)"""/.exec(py);
	assert.ok(m, "_BRIDGE_JS constant not found in server.py");
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
	it("surfaces a network failure (unreachable endpoint)", async () => {
		// Port 1 is unbound: fetch rejects with a connection error.
		const h = runBridge("http://127.0.0.1:1");
		h.exportAs("json");
		await h.settle();
		await waitFor(() => h.errorBanner() !== null, "error banner");
		assert.match(String(h.sandbox.window.__codeflowBridgeError ?? ""), /unreachable/);
	});
});
