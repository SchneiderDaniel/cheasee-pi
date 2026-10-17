import assert from "node:assert";

import { createRequire } from "node:module";

import { dirname, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

const requireCjs = createRequire(import.meta.url);

const FILTER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");

type Suppressed = {
	security: any[];
	layerViolations: any[];
	hygiene: any[];
	deadCode: any[];
	duplicates: any[];
};

const {
	sanitizeAnalysisData,
	isFalsePositiveHygiene,
	isFalsePositiveLayerViolation,
	readFileFrom,
	REPO_LAYERS,
	resolveLayer,
} = requireCjs(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
	) => { data: any; suppressed: Suppressed };
	isFalsePositiveHygiene: (issue: unknown, readFile?: (path: unknown) => string | null) => boolean;
	isFalsePositiveLayerViolation: (
		violation: unknown,
		index: {
			connections: Record<string, boolean>;
			layers?: Array<{ prefix: string; layer: string; rank: number }>;
		},
	) => boolean;
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
	REPO_LAYERS: Array<{ prefix: string; layer: string; rank: number }>;
	resolveLayer: (path: unknown) => { layer: string; rank: number } | null;
};

const { calcHealth } = (await import("./fixtures/codeflow-calc-health.mjs")) as {
	calcHealth: (data: any) => { score: number; grade: string };
};

const SOURCES: Record<string, string> = {
	".pi/extensions/context-info/types.ts":
		'export type UsageColorToken = "success" | "warning" | "error";\n',
	".pi/extensions/supervisor/github/gh-client.ts":
		"function resolveGitHubToken() {\n" +
		"  const env = process.env.GH_TOKEN;\n" +
		"  const hosts = readFileSync(homedir() + '/.config/gh/hosts.yml');\n" +
		"  return env || hosts;\n" +
		"}\n" +
		"const ghToken = resolveGitHubToken();\n",
	".pi/extensions/web-search/test/index.test.ts":
		"// First execute: verify 1 (quick check) + verify 2 (double-check) fail\n" +
		"it('passes', () => {});\n",
	"cmd/cheasee-pi/embedded/docker/entrypoint.sh": "#!/bin/sh\nexit 0\n",
	"ui/src/lib.rs": "pub fn shell() -> impl IntoView { view! { <html></html> } }\n",
	"ui/src/main.rs": "fn main() { mount_to_body(App); }\n",
	"ui/src/retry.rs": "pub fn retry() {}\n",
	"ui/src/tool_card.rs": "pub fn card() {}\n",
	"src/spawn.ts": "export function run() { spawn(); }\n",
	"src/config.ts": "export const config = load();\n",
};

const readFile = (path: unknown): string | null =>
	typeof path === "string" && path in SOURCES ? SOURCES[path] : null;

function sec(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		severity: "high",
		title: "Hardcoded Secret",
		description: "Possible hardcoded API key.",
		path: "src/config.ts",
		line: 1,
		code: 'const KEY = "sk-live-abc";',
		...over,
	};
}

function hyg(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		severity: "low",
		title: "Code Comments",
		description: "Unresolved work marker found.",
		path: ".pi/extensions/agent-harness/test/index.test.ts",
		line: 1,
		code: "",
		...over,
	};
}

const nullReadFile = () => null;

const EXT = ".pi/extensions/";

const TEST = "test/";

const UI = "cmd/cheasee-pi/embedded/docker/ui/";

const LAYER_FILES = [
	{ path: `${EXT}from.ts`, layer: "extensions" },
	{ path: `${TEST}to.ts`, layer: "test" },
	{ path: `${UI}src/retry.rs`, layer: "ui" },
	{ path: `${UI}src/main.rs`, layer: "ui" },
	{ path: "cmd/cheasee-pi/build.go", layer: "cli" },
];

const CONNECTIONS = [{ source: `${EXT}from.ts`, target: `${TEST}to.ts`, fn: "render", count: 2 }];

function violation(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		from: `${EXT}from.ts`,
		to: `${TEST}to.ts`,
		fromLayer: "extensions",
		toLayer: "test",
		fn: "render",
		suggestion: "invert",
		...over,
	};
}

function keepsSecurity(issue: Record<string, unknown>): boolean {
	const { data, suppressed } = sanitizeAnalysisData({ securityIssues: [issue] }, readFile);
	assert.strictEqual(
		suppressed.security.length + suppressed.hygiene.length + data.securityIssues.length,
		1,
		"no finding may vanish",
	);
	return data.securityIssues.length === 1;
}

function keepsViolation(v: unknown): boolean {
	const input = { files: LAYER_FILES, connections: CONNECTIONS, layerViolations: [v] };
	const { data, suppressed } = sanitizeAnalysisData(input, readFile);
	assert.strictEqual(
		suppressed.layerViolations.length + data.layerViolations.length,
		1,
		"no violation may vanish",
	);
	return data.layerViolations.length === 1;
}

describe("fp-filter — unused-function reference rule (Phase 1)", () => {
	/** Sanitize one dead-code entry against `sources`; every entry must survive or be suppressed. */
	function keepsDead(name: unknown, file: unknown, sources: Record<string, string> = {}): boolean {
		const input = {
			files: Object.keys(sources).map((path) => ({ path })),
			deadFunctions: [{ name, file, line: 1, ext: "ts" }],
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.strictEqual(
			suppressed.deadCode.length + data.deadFunctions.length,
			1,
			"no entry may vanish",
		);
		return data.deadFunctions.length === 1;
	}

	it("drops an entry a different file calls (the trait-impl methods)", () => {
		assert.strictEqual(
			keepsDead("on_message", "ui/src/ws.rs", {
				"ui/src/ws.rs":
					"pub trait Socket {\n    fn on_message<F: FnMut(String)>(&self, handler: F);\n}\n",
				"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
			}),
			false,
		);
	});

	it("attributes a cross-file mention to the listed definition only when it can be", () => {
		// Two modules define `helper`; a.ts calls its own, so the bare call there
		// cannot excuse b.ts's unreferenced copy.
		const shared = {
			"src/a.ts": "export function helper() { return 1; }\nexport function run() { helper(); }\n",
			"src/b.ts": "export function helper() { return 2; }\n",
		};
		assert.strictEqual(
			keepsDead("helper", "src/a.ts", shared),
			false,
			"a same-file use refutes it",
		);
		assert.strictEqual(
			keepsDead("helper", "src/b.ts", shared),
			true,
			"the bare call in a.ts resolves to a.ts's own `helper`, so it cannot refute b.ts's",
		);
		// A receiver call dispatches through the receiver's type, so a file that
		// defines the same name does not make it ambiguous. This is the shape the
		// real report carries: `socket.on_close(...)` in retry.rs, whose own policy
		// type also has an `on_close`, against `on_close` implemented in ws.rs.
		assert.strictEqual(
			keepsDead("on_close", "ui/src/ws.rs", {
				"ui/src/ws.rs": "impl Socket for Ws {\n    fn on_close(&self) {}\n}\n",
				"ui/src/retry.rs":
					"impl Policy {\n    pub fn on_close(&mut self) -> u64 { 1 }\n}\n" +
					"fn wire(socket: &Ws) {\n    socket.on_close();\n}\n",
			}),
			false,
			"a dot-call is not resolved by the caller's own same-named definition",
		);
		// A name no file defines keeps resolving cross-file, whatever the shape.
		assert.strictEqual(
			keepsDead("solo", "src/d.ts", {
				"src/d.ts": "pub fn solo() -> u64 { 1 }\n",
				"src/e.rs": "fn wire() {\n    let handler = solo;\n}\n",
			}),
			false,
		);
		// Two modules define `helper`, and a third only calls one of them: the
		// target is ambiguous from text, so neither copy may be called live by it.
		const thirdCaller = {
			"src/a.ts": "export function helper() { return 1; }\n",
			"src/b.ts": "export function helper() { return 2; }\n",
			"src/c.ts": "import { helper } from './a';\nexport function run() { helper(); }\n",
		};
		assert.strictEqual(
			keepsDead("helper", "src/a.ts", thirdCaller),
			true,
			"a bare call from a third module cannot be attributed to one of two same-named owners",
		);
		assert.strictEqual(keepsDead("helper", "src/b.ts", thirdCaller), true);
	});

	it("drops an entry its own file references outside the definition", () => {
		assert.strictEqual(
			keepsDead("reconnect_delay", "ui/src/retry.rs", {
				"ui/src/retry.rs":
					"pub fn reconnect_delay(effect: u64) -> u64 { effect }\n" +
					"fn dial() {\n    let d = reconnect_delay(500);\n}\n",
			}),
			false,
		);
	});

	it("drops an entry referenced as a value (?? name, = name, , name)", () => {
		assert.strictEqual(
			keepsDead("defaultIsWritable", ".pi/extensions/scrapling/browser-setup.ts", {
				".pi/extensions/scrapling/browser-setup.ts":
					"function defaultIsWritable(path: string): boolean { return true; }\n" +
					"const isWritable = opts.isWritable ?? defaultIsWritable;\n",
			}),
			false,
		);
		assert.strictEqual(
			keepsDead("defaultFetch", ".pi/lib/fetch-report.ts", {
				".pi/lib/fetch-report.ts":
					"const defaultFetch: FetchFn = (url, init) => fetch(url, init);\n" +
					"let fetchFn: FetchFn = defaultFetch;\n" +
					"pick(url, defaultFetch);\n",
			}),
			false,
		);
	});

	it("drops an entry only referenced through a dot-call", () => {
		assert.strictEqual(
			keepsDead("is_open", "ui/src/retry.rs", {
				"ui/src/retry.rs":
					"pub fn is_open(&self) -> bool { true }\n" +
					"fn send(transport: &Transport) {\n    if !transport.is_open() { return; }\n}\n",
			}),
			false,
		);
	});

	it("keeps an entry whose only occurrence is its own definition head", () => {
		for (const [path, src] of [
			["src/a.ts", "function foo(x: number) { return x; }\n"],
			["src/b.rs", "fn foo(x: u64) -> u64 { x }\n"],
			["src/c.ts", "const foo = (x: number) => x;\n"],
		] as Array<[string, string]>) {
			assert.strictEqual(keepsDead("foo", path, { [path]: src }), true, path);
		}
	});

	it("keeps a recursion-only entry (a self-reference is not a use)", () => {
		assert.strictEqual(
			keepsDead("foo", "src/d.ts", { "src/d.ts": "function foo() { return foo(); }\n" }),
			true,
		);
	});

	it("keeps a recursion-only entry whose signature carries a type brace", () => {
		assert.strictEqual(
			keepsDead("foo", "src/d2.ts", {
				"src/d2.ts": "function foo(opts: { x: number }) { return foo(opts); }\n",
			}),
			true,
			"a parameter type brace is part of the signature, not the body",
		);
		assert.strictEqual(
			keepsDead("foo", "src/d3.ts", {
				"src/d3.ts": "function foo(opts: { x: number }): { y: number } { return foo(opts); }\n",
			}),
			true,
			"a return type brace is part of the signature, not the body",
		);
	});

	it("keeps a declaration-only Go function or method (func name)", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/go1.go", { "src/go1.go": "package main\nfunc ghost() {}\n" }),
			true,
		);
		assert.strictEqual(
			keepsDead("ghost", "src/go2.go", {
				"src/go2.go": "package main\ntype R struct{}\nfunc (r *R) ghost() {}\n",
			}),
			true,
			"a Go method with a receiver is still a declaration",
		);
	});

	it("keeps a declaration-only TypeScript class method (name() {})", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/cls1.ts", { "src/cls1.ts": "class A {\n\tghost() {}\n}\n" }),
			true,
		);
		assert.strictEqual(
			keepsDead("ghost", "src/cls2.ts", {
				"src/cls2.ts": "class A {\n\tstatic async ghost(x: number): void {}\n}\n",
			}),
			true,
			"a return-type annotation and modifiers are still a declaration head",
		);
	});

	it("still suppresses a declared function that a real call reaches", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/go3.go", {
				"src/go3.go": "package main\nfunc ghost() {}\nfunc use() { ghost() }\n",
			}),
			false,
		);
		assert.strictEqual(
			keepsDead("ghost", "src/cls3.ts", {
				"src/cls3.ts": "class A {\n\tghost() {}\n}\nnew A().ghost();\n",
			}),
			false,
		);
	});

	it("still detects an external use after a typed signature", () => {
		assert.strictEqual(
			keepsDead("foo", "src/d4.ts", {
				"src/d4.ts": "function foo(opts: { x: number }) { return 1; }\nconst v = foo({ x: 1 });\n",
			}),
			false,
		);
	});

	it("keeps an entry no file mentions", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/e.ts", { "src/e.ts": "export const a = 1;\n" }),
			true,
		);
	});

	it("keeps an entry that only a comment mentions", () => {
		assert.strictEqual(
			keepsDead("foo", "src/f.ts", {
				"src/f.ts": "// foo() runs on the retry path\n/* foo(bar) */\n",
			}),
			true,
		);
	});

	it("keeps an entry that only a string or template literal mentions", () => {
		assert.strictEqual(
			keepsDead("foo", "src/g.ts", {
				"src/g.ts": 'const label = "foo()";\nconst t = `foo(bar)`;\n',
			}),
			true,
		);
	});

	it("does not match a name inside a longer identifier", () => {
		assert.strictEqual(
			keepsDead("read", "src/h.ts", {
				"src/h.ts": "function alreadyRead(p) { return p; }\nfunction read() { return 1; }\n",
			}),
			true,
			"alreadyRead( must not read as a use of read",
		);
		assert.strictEqual(
			keepsDead("on_message", "src/i.rs", {
				"src/i.rs": "fn main() { socket.on_message_handler(1); }\n",
			}),
			true,
		);
	});

	it("keeps entries with a missing or non-string name/file (unreprovable)", () => {
		const input = {
			files: [{ path: "src/a.ts" }],
			deadFunctions: [{ name: "foo" }, { file: "src/a.ts" }, { name: 42, file: "src/a.ts" }, null],
		};
		const { data, suppressed } = sanitizeAnalysisData(input, () => "function foo(){}\n");
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, input.deadFunctions);
	});

	it("keeps every entry when no content can be read (fail open)", () => {
		assert.strictEqual(keepsDead("foo", "src/a.ts", {}), true);
	});

	it("keeps a finding when its own definition file cannot be read (mixed readable/unreadable)", () => {
		// The listed definition is unreadable, so the same-named call in the other
		// readable file cannot be attributed to it: the finding must stand.
		const sources: Record<string, string | null> = {
			"ui/src/ws.rs": null,
			"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const entry = { name: "on_message", file: "ui/src/ws.rs" };
		const input = {
			files: [{ path: "ui/src/ws.rs" }, { path: "ui/src/retry.rs" }],
			deadFunctions: [entry],
		};
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, [entry]);
	});

	it("keeps every finding when only an unrelated scanned file cannot be read", () => {
		// One unavailable file leaves the index incomplete, so nothing is
		// suppressed rather than risk a wrong attribution.
		const sources: Record<string, string | null> = {
			"ui/src/ws.rs":
				"pub trait Socket {\n    fn on_message<F: FnMut(String)>(&self, handler: F);\n}\n",
			"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
			"ui/src/missing.ts": null,
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const entry = { name: "on_message", file: "ui/src/ws.rs" };
		const input = {
			files: [{ path: "ui/src/ws.rs" }, { path: "ui/src/retry.rs" }, { path: "ui/src/missing.ts" }],
			deadFunctions: [entry],
			stats: { dead: 1 },
		};
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, [entry]);
		assert.strictEqual(data.stats.dead, 1, "the summary count must not move without a drop");
	});

	it("keeps a finding whose definition file is not among the analyzed files", () => {
		const sources: Record<string, string> = {
			"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const entry = { name: "on_message", file: "ui/src/ws.rs" };
		const input = { files: [{ path: "ui/src/retry.rs" }], deadFunctions: [entry] };
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, [entry]);
	});

	it("survives malformed input without throwing", () => {
		for (const input of [
			{},
			{ files: null },
			{ files: "nope" },
			{ files: [null, 1], deadFunctions: [] },
		]) {
			assert.doesNotThrow(() =>
				sanitizeAnalysisData(
					{ ...input, deadFunctions: [{ name: "foo", file: "a.ts" }] },
					readFile,
				),
			);
		}
	});
});
