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

describe("fp-filter — acceptance score (Phase 5)", () => {
	// The score is computed by the real upstream `calcHealth` (the fixture copies
	// it verbatim from the pinned checkout). The data below reproduces the report
	// the issue was filed against; the authoritative check is the headless re-run
	// in test/codeflow-fp-acceptance.test.mts against the pinned analyzer.
	const nineHighs = [
		sec({
			path: ".pi/extensions/context-info/types.ts",
			code: 'export type UsageColorToken = "success" | "warning" | "error";',
		}),
		sec({
			path: ".pi/extensions/supervisor/github/gh-client.ts",
			code: "const ghToken = resolveGitHubToken();",
		}),
		sec({
			path: ".pi/extensions/supervisor/github/gh-client.ts",
			code: '? ["-c", `GH_TOKEN=\'${ghToken.replace(/\'/g, "")}\' gh "$@"`, "_", ...args]',
		}),
		sec({
			title: "SQL Injection Risk",
			path: ".pi/extensions/web-search/test/index.test.ts",
			code: "// First execute: verify 1 (quick check) + verify 2 (double-check) fail",
		}),
		...["ui/src/lib.rs", "ui/src/main.rs", "ui/src/retry.rs", "ui/src/tool_card.rs"].map((path) =>
			sec({
				title: "Shell Command Execution",
				description: "Shell() call detected.",
				path,
				code: "",
			}),
		),
		sec({
			title: "Shell Command Execution",
			description: "Shell() call detected.",
			path: "cmd/cheasee-pi/embedded/docker/entrypoint.sh",
			code: "",
		}),
	];

	const oneHundredFiftySeven = Array.from({ length: 157 }, (_, i) =>
		violation({ from: "cmd/build.go", to: "ui/src/retry.rs", fromLayer: "dir", toLayer: "dir" }),
	);

	const files = Array.from({ length: 1026 }, (_, i) => ({ path: `src/f${i}.ts`, layer: "ui" }));

	// The analyzer's `data` shape (not the exported report): `calcHealth` reads
	// `stats` and `issues`, and the layer rule reads `files`/`connections`.
	const data = {
		stats: {
			files: 1026,
			functions: 4890,
			connections: 5006,
			dead: 24,
			duplicates: 0,
			violations: 157,
			security: 9,
			loc: 1,
			languages: [],
		},
		issues: [{ type: "warning", title: "Large Function: render", desc: "", items: [] }],
		securityIssues: nineHighs,
		layerViolations: oneHundredFiftySeven,
		files,
		connections: CONNECTIONS,
	};

	it("reproduces the reported 73 (C) before the filter", () => {
		assert.strictEqual(data.securityIssues.length, 9);
		assert.strictEqual(data.layerViolations.length, 157);
		assert.deepStrictEqual(calcHealth(data), { score: 73, grade: "C" });
	});

	it("scores 93 (A) after the filter, with the security term at zero", () => {
		const { data: clean, suppressed } = sanitizeAnalysisData(data, readFile);
		assert.strictEqual(suppressed.security.length, 9, "all nine HIGH hits must be suppressed");
		assert.strictEqual(suppressed.layerViolations.length, 157, "the whole layer category is noise");
		assert.strictEqual(clean.securityIssues.length, 0);
		assert.strictEqual(clean.layerViolations.length, 0);
		assert.ok(calcHealth(clean).score >= 90, `expected an A, got ${calcHealth(clean).score}`);
		assert.deepStrictEqual(calcHealth(clean), { score: 93, grade: "A" });
	});
});
