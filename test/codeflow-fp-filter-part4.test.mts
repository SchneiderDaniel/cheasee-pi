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

describe("fp-filter — unused-function wiring and stats (Phase 2)", () => {
	const DEAD_SOURCES: Record<string, string> = {
		"src/use.ts": "function keep() { return 1; }\nfunction hit() { return 2; }\nconst run = hit;\n",
		"src/other.ts": "function ghost() { return 3; }\nghost();\n",
	};
	const deadRead = (p: unknown): string | null =>
		typeof p === "string" && p in DEAD_SOURCES ? DEAD_SOURCES[p] : null;
	const deadFiles = [{ path: "src/use.ts" }, { path: "src/other.ts" }];

	it("keeps the survivors in input order and reports every drop", () => {
		const deadFunctions = [
			{ name: "hit", file: "src/use.ts" },
			{ name: "keep", file: "src/use.ts" },
			{ name: "ghost", file: "src/other.ts" },
		];
		const { data, suppressed } = sanitizeAnalysisData(
			{ files: deadFiles, deadFunctions },
			deadRead,
		);

		assert.deepStrictEqual(suppressed.deadCode, [deadFunctions[0], deadFunctions[2]]);
		assert.deepStrictEqual(data.deadFunctions, [deadFunctions[1]]);
		assert.strictEqual(
			data.deadFunctions.length + suppressed.deadCode.length,
			deadFunctions.length,
			"every input entry is kept or suppressed",
		);
	});

	it("filters the reported unusedFunctions alias too", () => {
		const unusedFunctions = [
			{ name: "hit", file: "src/use.ts" },
			{ name: "keep", file: "src/use.ts" },
		];
		const { data, suppressed } = sanitizeAnalysisData(
			{ files: deadFiles, unusedFunctions },
			deadRead,
		);
		assert.deepStrictEqual(data.unusedFunctions, [unusedFunctions[1]]);
		assert.deepStrictEqual(suppressed.deadCode, [unusedFunctions[0]]);
	});

	it("keeps the architecture entry that lists the dead functions consistent", () => {
		const entry = {
			type: "warning",
			title: "3 Unused Functions",
			desc: "Functions not called from other files",
			items: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
				{ name: "ghost", file: "src/other.ts" },
			],
		};
		const input = {
			files: deadFiles,
			issues: [entry, { type: "warning", title: "1 Large Files", items: [] }],
			deadFunctions: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
				{ name: "ghost", file: "src/other.ts" },
			],
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, deadRead);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.strictEqual(
			data.issues[0].title,
			"1 Unused Functions",
			"the header must match the list",
		);
		assert.deepStrictEqual(
			data.issues[0].items.map((i: { name: string }) => i.name),
			["keep"],
		);
		assert.deepStrictEqual(data.issues[1], input.issues[1], "unrelated issues must pass through");
	});

	it("drops the architecture entry when no dead function survives", () => {
		const input = {
			files: deadFiles,
			issues: [
				{
					type: "warning",
					title: "1 Unused Functions",
					items: [{ name: "hit", file: "src/use.ts" }],
				},
			],
		};
		const { data } = sanitizeAnalysisData(input, deadRead);
		assert.deepStrictEqual(data.issues, []);
	});

	// The exported report cites the analyzer's count-only architecture summary
	// (`{title: "44 Unused Functions"}`, no `items`), so it must restate the
	// filtered count or the report contradicts its own list and `stats.dead`.
	it("restates the title-only Unused Functions summary to the surviving count", () => {
		const input = {
			files: deadFiles,
			issues: [{ title: "3 Unused Functions" }, { title: "1 Large Files" }],
			deadFunctions: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
				{ name: "ghost", file: "src/other.ts" },
			],
			stats: { dead: 3 },
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, deadRead);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.strictEqual(data.issues[0].title, "1 Unused Functions");
		assert.strictEqual(
			data.issues[0].title,
			`${data.stats.dead} Unused Functions`,
			"summary must agree with stats.dead",
		);
		assert.deepStrictEqual(data.issues[1], input.issues[1], "unrelated issues must pass through");
	});

	it("drops the title-only Unused Functions summary when nothing survives", () => {
		const input = {
			files: deadFiles,
			issues: [{ title: "1 Unused Functions" }],
			deadFunctions: [{ name: "hit", file: "src/use.ts" }],
		};
		const { data } = sanitizeAnalysisData(input, deadRead);
		assert.deepStrictEqual(data.issues, []);
	});

	it("keeps a title-only Unused Functions summary when no dead list is reportable", () => {
		const entry = { title: "3 Unused Functions" };
		const { data } = sanitizeAnalysisData({ files: deadFiles, issues: [entry] }, deadRead);
		assert.deepStrictEqual(data.issues, [entry]);
	});

	it("recounts stats.dead to the surviving list", () => {
		const input = {
			files: deadFiles,
			stats: { files: 1, functions: 10, dead: 3 },
			deadFunctions: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
			],
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, deadRead);
		assert.deepStrictEqual(input.stats, before.stats, "input stats must not be touched");
		assert.strictEqual(data.stats.dead, data.deadFunctions.length);
		assert.strictEqual(data.stats.dead, 1);
		assert.strictEqual(data.stats.functions, 10, "unrelated stats must survive");

		const second = sanitizeAnalysisData(data, deadRead);
		assert.deepStrictEqual(second.data, data, "idempotent");
		assert.deepStrictEqual(second.suppressed.deadCode, []);
	});

	it("leaves stats.dead alone when there is no dead-function list", () => {
		const { data } = sanitizeAnalysisData({ stats: { files: 1, dead: 3 } }, deadRead);
		assert.strictEqual(data.stats.dead, 3);
	});

	it("always reports a deadCode key, alongside the untouched ones", () => {
		const { suppressed } = sanitizeAnalysisData({ marker: "FIXTURE" }, deadRead);
		assert.deepStrictEqual(suppressed, {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
		});
	});
});
describe("fp-filter — duplicate group suppression (Phase 5)", () => {
	const dup = (over: Record<string, unknown> = {}) => ({
		type: "code",
		name: "makePi",
		files: [{ file: "a.ts" }],
		...over,
	});

	/** Sanitize one duplicate group and report whether it survived. */
	function keepsDuplicate(entry: Record<string, unknown>): boolean {
		const { data, suppressed } = sanitizeAnalysisData({ duplicates: [entry] }, readFile);
		assert.strictEqual(
			suppressed.duplicates.length + data.duplicates.length,
			1,
			"no duplicate group may vanish",
		);
		return data.duplicates.length === 1;
	}

	it("suppresses a code aggregate naming 3+ distinct members", () => {
		const aggregate = dup({ name: "withEnv, exec, cacheGet" });
		const pair = dup({ name: "readSettingsCodeflowPort, readSettingsUIPort" });
		const { data, suppressed } = sanitizeAnalysisData({ duplicates: [aggregate, pair] }, readFile);
		assert.deepStrictEqual(suppressed.duplicates, [aggregate]);
		assert.deepStrictEqual(data.duplicates, [pair]);
	});

	it("keeps pairwise, singleton and empty-name groups", () => {
		assert.strictEqual(
			keepsDuplicate(dup({ name: "readSettingsCodeflowPort, readSettingsUIPort" })),
			true,
		);
		assert.strictEqual(keepsDuplicate(dup({ name: "solo" })), true);
		assert.strictEqual(keepsDuplicate(dup({ name: "" })), true, "an empty name is no evidence");
	});

	it("counts a repeated member once ('makePi, makePi' survives)", () => {
		assert.strictEqual(keepsDuplicate(dup({ name: "makePi, makePi" })), true);
	});

	it("suppresses only when the distinct member count exceeds 2 (boundary)", () => {
		assert.strictEqual(keepsDuplicate(dup({ name: "a, b" })), true);
		assert.strictEqual(keepsDuplicate(dup({ name: "a, a, b" })), true, "2 distinct");
		assert.strictEqual(keepsDuplicate(dup({ name: "a, b, c" })), false);
		assert.strictEqual(
			keepsDuplicate(dup({ name: "a, a, b, b, c, c" })),
			false,
			"3 distinct after dedup",
		);
	});

	it("leaves non-code duplicate types alone", () => {
		assert.strictEqual(keepsDuplicate(dup({ type: "name", name: "a, b, c, d" })), true);
	});

	it("keeps a missing or non-string name (unknown is not suppression evidence)", () => {
		assert.strictEqual(keepsDuplicate({ type: "code", files: [] }), true);
		assert.strictEqual(keepsDuplicate(dup({ name: 42 })), true);
		assert.strictEqual(keepsDuplicate(dup({ name: null })), true);
	});

	it("defines suppressed.duplicates as [] and adds no key when data.duplicates is absent", () => {
		const { data, suppressed } = sanitizeAnalysisData({ marker: "x" }, readFile);
		assert.deepStrictEqual(suppressed.duplicates, []);
		assert.strictEqual("duplicates" in data, false, "no key is added when none existed");
	});

	it("moves stats.duplicates with the surviving array", () => {
		const input = {
			stats: { files: 1, duplicates: 2 },
			duplicates: [dup({ name: "a, b, c" }), dup({ name: "a, b" })],
		};
		const { data } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(data.stats.duplicates, 1);
	});

	it("retitles the N Similar Code Blocks item to the surviving count", () => {
		const input = {
			duplicates: [dup({ name: "a, b, c" }), dup({ name: "x" })],
			issues: [
				{ type: "warning", title: "9 Similar Code Blocks", desc: "", items: [] },
				{ title: "Other" },
			],
		};
		const { data } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(data.issues[0].title, "1 Similar Code Blocks");
		assert.strictEqual(data.issues[1].title, "Other");
	});

	it("removes the Similar Code Blocks item when every group is suppressed", () => {
		const input = {
			duplicates: [dup({ name: "a, b, c" })],
			issues: [{ title: "9 Similar Code Blocks" }, { title: "Keep" }],
		};
		const { data } = sanitizeAnalysisData(input, readFile);
		assert.deepStrictEqual(data.issues, [{ title: "Keep" }]);
	});

	it("is idempotent when a duplicate group is suppressed", () => {
		const input = { duplicates: [dup({ name: "a, b, c" }), dup({ name: "a, b" })] };
		const first = sanitizeAnalysisData(input, readFile);
		const second = sanitizeAnalysisData(first.data, readFile);
		assert.deepStrictEqual(second.data, first.data);
		assert.deepStrictEqual(second.suppressed.duplicates, []);
	});
});
describe("fp-filter — browser readFile source", () => {
	it("reads files[].content, falls back to the served files[].piFpSource, else null", () => {
		const fromData = readFileFrom({
			files: [
				{ path: "a.ts", content: "export const a = 1;\n" },
				{ path: "b.ts" },
				{ path: "c.ts", content: null, piFpSource: "export function c() {}\n" },
				{ path: "d.ts", content: 7, piFpSource: "export function d() {}\n" },
			],
		});
		assert.strictEqual(fromData("a.ts"), "export const a = 1;\n");
		assert.strictEqual(
			fromData("c.ts"),
			"export function c() {}\n",
			"freed content must fall back to the served piFpSource",
		);
		assert.strictEqual(
			fromData("d.ts"),
			"export function d() {}\n",
			"a non-string content must not block the fallback",
		);
		assert.strictEqual(
			fromData("b.ts"),
			null,
			"no retained source => null, so the filter fails open",
		);
		assert.strictEqual(fromData("missing.ts"), null);
		assert.strictEqual(fromData(undefined), null);
		assert.strictEqual(fromData("toString"), null, "prototype keys must not leak");
	});

	it("suppresses a dead function the served browser shape still references", () => {
		// Exactly what the served page hands the filter: the analyzer has nulled
		// every `content`, the index.html rewrite kept the text on `piFpSource`.
		const data = {
			files: [
				{ path: "def.ts", content: null, piFpSource: "export function deadCall() {}\n" },
				{ path: "use.ts", content: null, piFpSource: "function run() { deadCall(); }\n" },
			],
			stats: { functions: 2, dead: 1 },
			deadFunctions: [{ name: "deadCall", file: "def.ts" }],
		};

		const { data: clean, suppressed } = sanitizeAnalysisData(data, readFileFrom(data));
		assert.deepStrictEqual(suppressed.deadCode, [{ name: "deadCall", file: "def.ts" }]);
		assert.deepStrictEqual(clean.deadFunctions, []);
		assert.strictEqual(clean.stats.dead, 0);
	});
});
