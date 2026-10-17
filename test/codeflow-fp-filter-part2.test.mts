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

describe("fp-filter — non-mutating and idempotent (Phases 1-2)", () => {
	it("returns a new object, preserves every non-security field and mutates nothing", () => {
		const input = {
			marker: "FIXTURE",
			stats: { files: 3, functions: 9, loc: 40 },
			unusedFunctions: [{ name: "dead" }],
			securityIssues: [sec({ code: "" }), sec()],
			layerViolations: [violation(), violation({ to: "ui/src/retry.rs" })],
			files: LAYER_FILES,
			connections: CONNECTIONS,
		};
		const before = structuredClone(input);

		const { data, suppressed } = sanitizeAnalysisData(input, readFile);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.notStrictEqual(data, input, "output must be a new object");
		assert.strictEqual(data.marker, "FIXTURE");
		assert.deepStrictEqual(data.stats, { files: 3, functions: 9, loc: 40 });
		assert.deepStrictEqual(data.unusedFunctions, [{ name: "dead" }]);
		assert.strictEqual(suppressed.security.length, 1);
		assert.strictEqual(suppressed.layerViolations.length, 2);
		assert.strictEqual(suppressed.hygiene.length, 0);
		assert.strictEqual(data.securityIssues.length, 1);
		assert.strictEqual(data.layerViolations.length, 0);
	});

	it("is idempotent: a second pass changes nothing and suppresses nothing", () => {
		const input = {
			files: LAYER_FILES,
			connections: CONNECTIONS,
			securityIssues: [sec({ code: "" }), sec()],
			layerViolations: [violation(), violation({ to: "ui/src/retry.rs" })],
		};
		const first = sanitizeAnalysisData(input, readFile);
		const second = sanitizeAnalysisData(first.data, readFile);

		assert.deepStrictEqual(second.data, first.data);
		assert.deepStrictEqual(second.suppressed, {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
		});
	});

	it("passes data without securityIssues/layerViolations through unchanged", () => {
		const input = { marker: "FIXTURE", stats: { files: 1 } };
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.deepStrictEqual(data, input);
		assert.deepStrictEqual(Object.keys(data), Object.keys(input));
		assert.deepStrictEqual(suppressed, {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
		});
	});

	it("moves stats.security/violations with the filtered arrays, without mutating the input stats", () => {
		// The report summary and the UI tab badge read these counts; a stale pair
		// would leave an A report advertising the findings the filter just dropped.
		const input = {
			stats: { files: 3, security: 2, violations: 2 },
			securityIssues: [sec({ code: "" }), sec()],
			layerViolations: [violation(), violation({ to: "ui/src/retry.rs" })],
			files: LAYER_FILES,
			connections: CONNECTIONS,
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, readFile);

		assert.deepStrictEqual(input.stats, before.stats, "input stats must not be touched");
		assert.notStrictEqual(data.stats, input.stats, "output stats must be a new object");
		// No layer is declared, so both layer violations are suppressed and the
		// summary count moves to zero with the list.
		assert.deepStrictEqual(data.stats, { files: 3, security: 1, violations: 0 });

		const second = sanitizeAnalysisData(data, readFile);
		assert.deepStrictEqual(second.data.stats, data.stats, "the corrected counts are stable");
	});
});
describe("fp-filter — layer violations (Phase 2)", () => {
	// The order-aware rule is the policy engine. Production supplies the repo's
	// declared taxonomy — empty, because docs/architecture.md declares no ordered
	// layer boundary — so the rule is exercised here with an injected taxonomy.
	// This is the positive control: a genuine lower-ranked -> higher-ranked import
	// is kept, not blanket-suppressed.
	const SYNTHETIC_LAYERS = [
		{ prefix: "app/deep/", layer: "deep", rank: 0 },
		{ prefix: "app/", layer: "app", rank: 1 },
		{ prefix: "app/top/", layer: "top", rank: 2 },
	];
	const SYNTH_CONNECTIONS = [
		{ source: "app/from.ts", target: "app/top/to.ts" },
		{ source: "app/deep/from.ts", target: "app/from.ts" },
		{ source: "app/deep/from.ts", target: "app/deep/to.ts" },
	];

	/** The order rule with an injected taxonomy; production declares none. */
	function keepsWithTaxonomy(
		v: unknown,
		connections: Array<{ source: string; target: string }> = SYNTH_CONNECTIONS,
	): boolean {
		const idx: Record<string, boolean> = Object.create(null);
		for (const c of connections) idx[`${c.source}\u0000${c.target}`] = true;
		return !isFalsePositiveLayerViolation(v, { connections: idx, layers: SYNTHETIC_LAYERS });
	}

	const synth = (over: Record<string, unknown> = {}) => ({
		from: "app/from.ts",
		to: "app/top/to.ts",
		fromLayer: "app",
		toLayer: "top",
		...over,
	});

	it("declares no ordered layer taxonomy: this repo has none", () => {
		// docs/architecture.md declares no lower/higher boundary, so a source root
		// (`scripts/`, `cmd/`, `.pi/extensions/`, `test/`) is not a layer.
		assert.deepStrictEqual(REPO_LAYERS, [], "a source root is not a declared layer");
	});

	it("resolves nothing — no path maps to a layer", () => {
		for (const path of [
			`${EXT}from.ts`,
			`${TEST}to.ts`,
			"cmd/cheasee-pi/build.go",
			"scripts/install.sh",
			`${UI}src/retry.rs`,
			"README.md",
			".pi/skills/audit/SKILL.md",
		]) {
			assert.strictEqual(resolveLayer(path), null, path);
		}
	});

	it("resolves nothing for empty, non-string and extensionless paths", () => {
		for (const path of ["", "Makefile", 42, null, undefined]) {
			assert.strictEqual(resolveLayer(path), null, JSON.stringify(path));
		}
	});

	it("suppresses every analyzer layer edge while the taxonomy is empty", () => {
		for (const v of [
			violation(),
			violation({ from: `${TEST}from.ts`, to: `${EXT}to.ts` }),
			violation({ to: `${UI}src/retry.rs` }),
			violation({ from: "cmd/cheasee-pi/build.go", to: `${UI}src/retry.rs` }),
		]) {
			assert.strictEqual(keepsViolation(v), false, JSON.stringify(v));
		}
	});

	it("keeps a genuine inverting same-language edge (positive control)", () => {
		assert.strictEqual(keepsWithTaxonomy(synth()), true);
	});

	it("resolves the most specific declared prefix (nested root beats its parent)", () => {
		// app/deep/from.ts is `deep` (rank 0), app/from.ts is `app` (rank 1): the
		// inversion holds. If the nested prefix were ignored both would resolve to
		// `app` (same rank) and the edge would be suppressed.
		assert.strictEqual(
			keepsWithTaxonomy(synth({ from: "app/deep/from.ts", to: "app/from.ts" })),
			true,
		);
	});

	it("drops a same-rank edge", () => {
		assert.strictEqual(
			keepsWithTaxonomy(synth({ from: "app/deep/from.ts", to: "app/deep/to.ts" })),
			false,
			"two files in the same layer cannot invert it",
		);
	});

	it("drops a reverse-direction edge", () => {
		assert.strictEqual(
			keepsWithTaxonomy(synth({ from: "app/top/from.ts", to: "app/from.ts" })),
			false,
			"higher rank -> lower rank is the intended direction",
		);
	});

	it("drops an endpoint under an undeclared root", () => {
		assert.strictEqual(keepsWithTaxonomy(synth({ from: "other/from.ts" })), false);
	});

	it("drops cross-language pairs", () => {
		assert.strictEqual(keepsWithTaxonomy(synth({ to: "app/top/to.rs" })), false);
	});

	it("drops a pair with no recorded connection (or only the reverse one)", () => {
		assert.strictEqual(keepsWithTaxonomy(synth(), []), false);
		assert.strictEqual(
			keepsWithTaxonomy(synth(), [{ source: "app/top/to.ts", target: "app/from.ts" }]),
			false,
		);
	});

	it("decides by the declared taxonomy, never the analyzer's files[].layer", () => {
		// The report's own labels are inverted and wrong; the taxonomy still keeps
		// the genuine edge.
		assert.strictEqual(keepsWithTaxonomy(synth({ fromLayer: "utils", toLayer: "services" })), true);
		// An inversion-looking label pair cannot rescue a genuinely reversed edge.
		assert.strictEqual(
			keepsWithTaxonomy(
				synth({
					from: "app/top/from.ts",
					to: "app/from.ts",
					fromLayer: "utils",
					toLayer: "services",
				}),
			),
			false,
		);
	});

	it("drops malformed and extensionless endpoints (positive control intact)", () => {
		for (const bad of [null, "x", {}, synth({ from: "" }), synth({ to: undefined })]) {
			assert.strictEqual(keepsWithTaxonomy(bad), false, JSON.stringify(bad));
		}
		assert.strictEqual(keepsWithTaxonomy(synth({ from: "Makefile", to: "Makefile" })), false);
	});

	it("accounts for every input entry as kept or suppressed", () => {
		const layerViolations = [
			violation(),
			violation({ from: "cmd/cheasee-pi/build.go", to: `${UI}src/retry.rs` }),
			violation({ from: `${TEST}from.ts`, to: `${EXT}to.ts` }),
		];
		const input = { files: LAYER_FILES, connections: CONNECTIONS, layerViolations };
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(
			data.layerViolations.length + suppressed.layerViolations.length,
			layerViolations.length,
		);
		assert.deepStrictEqual(suppressed.layerViolations, layerViolations);
	});
});
