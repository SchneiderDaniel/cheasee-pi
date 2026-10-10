/**
 * Unit tests for cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js — the
 * deterministic false-positive policy applied to CodeFlow's structured `data`
 * before any report artifact is built.
 *
 * The module is CJS (the headless runner requires it) and is loaded here the
 * same way, so the tests pin the exact file the container ships. `readFile` is
 * injected, so no test touches the filesystem.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-fp-filter.test.mts
 */

import assert from "node:assert";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const FILTER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");

const { sanitizeAnalysisData, readFileFrom } = requireCjs(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
	) => { data: any; suppressed: { security: any[]; layerViolations: any[] } };
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
};

// The real upstream health score (see the fixture header), so the acceptance
// arithmetic below is upstream's, not a re-implementation.
const { calcHealth } = (await import("./fixtures/codeflow-calc-health.mjs")) as {
	calcHealth: (data: any) => { score: number; grade: string };
};

// The cited files of the report the issue was filed against (issue #1994).
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

const LAYER_FILES = [
	{ path: "src/ui/from.ts", layer: "ui" },
	{ path: "src/ui/to.ts", layer: "ui" },
	{ path: "cmd/build.go", layer: "cmd" },
	{ path: "ui/src/retry.rs", layer: "ui" },
];
const CONNECTIONS = [{ source: "src/ui/from.ts", target: "src/ui/to.ts", fn: "render", count: 2 }];

function violation(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		from: "src/ui/from.ts",
		to: "src/ui/to.ts",
		fromLayer: "ui",
		toLayer: "ui",
		fn: "render",
		suggestion: "invert",
		...over,
	};
}

/** Sanitize one security finding and report whether it survived. */
function keepsSecurity(issue: Record<string, unknown>): boolean {
	const { data, suppressed } = sanitizeAnalysisData({ securityIssues: [issue] }, readFile);
	assert.strictEqual(suppressed.security.length + data.securityIssues.length, 1, "no finding may vanish");
	return data.securityIssues.length === 1;
}

/** Sanitize one layer violation and report whether it survived. */
function keepsViolation(v: Record<string, unknown>): boolean {
	const input = { files: LAYER_FILES, connections: CONNECTIONS, layerViolations: [v] };
	const { data, suppressed } = sanitizeAnalysisData(input, readFile);
	assert.strictEqual(
		suppressed.layerViolations.length + data.layerViolations.length,
		1,
		"no violation may vanish",
	);
	return data.layerViolations.length === 1;
}

describe("fp-filter — security false positives (Phase 1)", () => {
	it("drops a finding that cites no code line (the 5 Shell Command Execution hits)", () => {
		for (const path of ["ui/src/main.rs", "ui/src/retry.rs", "ui/src/tool_card.rs"]) {
			assert.strictEqual(
				keepsSecurity(sec({ title: "Shell Command Execution", code: "", path })),
				false,
				`empty code at ${path} must be suppressed`,
			);
		}
	});

	it("drops whitespace-only, null and missing code (boundary)", () => {
		for (const code of ["   \n\t ", null, undefined]) {
			assert.strictEqual(keepsSecurity(sec({ code })), false, `code=${JSON.stringify(code)}`);
		}
	});

	it("drops a comment-only match (the SQL Injection Risk hit)", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({
					title: "SQL Injection Risk",
					description: "Query built by concatenation.",
					path: ".pi/extensions/web-search/test/index.test.ts",
					code: "// First execute: verify 1 (quick check) + verify 2 (double-check) fail",
				}),
			),
			false,
		);
		assert.strictEqual(
			keepsSecurity(sec({ code: "/* execute(query) */" })),
			false,
			"block-comment-only code is still comment-only",
		);
	});

	it("keeps a leading comment that precedes a real statement", () => {
		assert.strictEqual(
			keepsSecurity(sec({ code: '//note\nconst q = "SELECT " + id;' })),
			true,
		);
	});

	it("drops a string-literal type union (the UsageColorToken hit)", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({
					path: ".pi/extensions/context-info/types.ts",
					code: 'export type UsageColorToken = "success" | "warning" | "error";',
				}),
			),
			false,
		);
		// A union that carries a real embedded secret is not a type-only match.
		assert.strictEqual(
			keepsSecurity(sec({ code: 'export type Token = "sk-live-abc123";' })),
			true,
			"a single-literal type alias is a literal, not a union",
		);
	});

	it("keeps a literal credential (true positive)", () => {
		assert.strictEqual(keepsSecurity(sec({ code: 'const KEY = "sk-live-abc";' })), true);
	});

	it("drops a value the environment resolves at runtime (the 2 gh-client hits)", () => {
		const gh = {
			title: "Hardcoded Secret",
			description: "Possible hardcoded token.",
			path: ".pi/extensions/supervisor/github/gh-client.ts",
		};
		assert.strictEqual(keepsSecurity(sec({ ...gh, code: "const KEY = process.env.GH_TOKEN;" })), false, "process.env");
		assert.strictEqual(keepsSecurity(sec({ ...gh, code: 'let k = env::var("GH_TOKEN");' })), false, "env::var");
		assert.strictEqual(
			keepsSecurity(sec({ ...gh, code: "const ghToken = resolveGitHubToken();" })),
			false,
			"helper whose body reads process.env/hosts.yml",
		);
		assert.strictEqual(
			keepsSecurity(
				sec({
					...gh,
					code: '? ["-c", `GH_TOKEN=\'${ghToken.replace(/\'/g, "")}\' gh "$@"`, "_", ...args]',
				}),
			),
			false,
			"the flagged value is the env-resolved ghToken",
		);
	});

	it("keeps a block that reads the environment elsewhere while the flagged value is a literal", () => {
		assert.strictEqual(
			keepsSecurity(sec({ code: 'const other = process.env.FOO;\nconst KEY = "sk-live-abc";' })),
			true,
			"never suppress on ambiguity",
		);
	});

	it("drops a finding whose message names a symbol absent from the cited file", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({
					title: "Shell Command Execution",
					description: "Untrusted input reaches Shell().",
					path: "ui/src/lib.rs",
					code: "let doc = shell();",
				}),
			),
			false,
			"lib.rs has shell(), never Shell()",
		);
	});

	it("keeps a finding whose named symbol is present in the cited file", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({ title: "Command Execution", description: "run() invokes spawn().", path: "src/spawn.ts", code: "spawn();" }),
			),
			true,
		);
	});

	it("keeps a finding when the cited file cannot be read (absence is not proof)", () => {
		assert.strictEqual(keepsSecurity(sec({ path: "does/not/exist.ts", code: 'const KEY = "sk-live-abc";' })), true);
	});

	it("leaves LOW and MEDIUM findings alone (owned by the audit triage)", () => {
		for (const severity of ["low", "medium", "LOW"]) {
			assert.strictEqual(
				keepsSecurity(sec({ severity, title: "Code Comments", description: "TODO", code: "// TODO: fix" })),
				true,
				`${severity} must not be filtered here`,
			);
		}
	});
});

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
		assert.strictEqual(suppressed.layerViolations.length, 1);
		assert.strictEqual(data.securityIssues.length, 1);
		assert.strictEqual(data.layerViolations.length, 1);
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
		assert.deepStrictEqual(second.suppressed, { security: [], layerViolations: [] });
	});

	it("passes data without securityIssues/layerViolations through unchanged", () => {
		const input = { marker: "FIXTURE", stats: { files: 1 } };
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.deepStrictEqual(data, input);
		assert.deepStrictEqual(Object.keys(data), Object.keys(input));
		assert.deepStrictEqual(suppressed, { security: [], layerViolations: [] });
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
		assert.deepStrictEqual(data.stats, { files: 3, security: 1, violations: 1 });

		const second = sanitizeAnalysisData(data, readFile);
		assert.deepStrictEqual(second.data.stats, data.stats, "the corrected counts are stable");
	});
});

describe("fp-filter — layer violations (Phase 2)", () => {
	it("drops cross-language pairs (the 142)", () => {
		for (const to of ["ui/src/retry.rs", "ui/src/main.rs"]) {
			assert.strictEqual(
				keepsViolation(violation({ from: "src/layer/from.ts", to, fromLayer: "ui", toLayer: "ui" })),
				false,
				`.ts -> ${to.slice(to.lastIndexOf("."))} cannot be an import edge`,
			);
		}
		assert.strictEqual(
			keepsViolation(violation({ from: "cmd/build.go", to: "ui/src/retry.rs", fromLayer: "cmd", toLayer: "ui" })),
			false,
		);
	});

	it("drops an invented layer taxonomy even for same-language endpoints (the 15)", () => {
		assert.strictEqual(
			keepsViolation(violation({ fromLayer: "utils", toLayer: "services" })),
			false,
			"the repo defines no utils/services layer",
		);
		assert.strictEqual(keepsViolation(violation({ toLayer: "shop" })), false, "one-sided mismatch");
	});

	it("drops an invented taxonomy the file table itself repeats (the 3 survivors)", () => {
		// The pinned analyzer falls back to `utils` and matches `/handler` ->
		// `services`, then repeats those labels in `files[].layer`, so the file-table
		// check alone keeps the edge; neither path carries the label as a directory.
		const from = ".pi/extensions/supervisor/pipeline/execute-agent.ts";
		const to = ".pi/extensions/supervisor/pipeline/handler/agent-loop.ts";
		const edge = { from, fromLayer: "utils", to, toLayer: "services", fn: "result", suggestion: "invert" };
		const input = {
			files: [
				{ path: from, layer: "utils" },
				{ path: to, layer: "services" },
			],
			connections: [{ source: to, target: from, fn: "result", count: 1 }],
			layerViolations: [edge],
		};
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.deepStrictEqual(suppressed.layerViolations, [edge]);
		assert.deepStrictEqual(data.layerViolations, []);
	});

	it("drops a same-language edge whose layer label the path does not name", () => {
		// Matching file-table labels are not enough: the paths name no layer folder.
		const input = {
			files: [
				{ path: "src/layer/from.ts", layer: "utils" },
				{ path: "src/layer/to.ts", layer: "services" },
			],
			connections: [{ source: "src/layer/from.ts", target: "src/layer/to.ts", fn: "render", count: 1 }],
			layerViolations: [
				violation({
					from: "src/layer/from.ts",
					to: "src/layer/to.ts",
					fromLayer: "utils",
					toLayer: "services",
				}),
			],
		};
		const { data } = sanitizeAnalysisData(input, readFile);
		assert.deepStrictEqual(data.layerViolations, []);
	});

	it("keeps a same-language edge the report itself recorded between matching layers", () => {
		assert.strictEqual(keepsViolation(violation()), true);
	});

	it("drops a same-language pair with no recorded connection", () => {
		assert.strictEqual(
			keepsViolation(violation({ from: "src/ui/to.ts", to: "src/ui/from.ts" })),
			false,
			"to -> from is not an import edge",
		);
	});

	it("drops endpoints that resolve to no file entry (bare identifiers)", () => {
		assert.strictEqual(
			keepsViolation(
				violation({
					from: "cmd/cheasee-pi/build.go",
					to: "cmd/cheasee-pi/embedded/docker/ui/src/retry.rs",
					fromLayer: "dir",
					toLayer: "dir",
				}),
			),
			false,
		);
	});

	it("drops empty, missing and extensionless endpoints", () => {
		assert.strictEqual(keepsViolation(violation({ from: "" })), false);
		assert.strictEqual(keepsViolation(violation({ to: undefined })), false);
		assert.strictEqual(keepsViolation(violation({ from: "Makefile", to: "Makefile" })), false);
	});

	it("accounts for every input entry as kept or suppressed", () => {
		const layerViolations = [
			violation(),
			violation({ from: "cmd/build.go", to: "ui/src/retry.rs" }),
			violation({ fromLayer: "utils" }),
		];
		const input = { files: LAYER_FILES, connections: CONNECTIONS, layerViolations };
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(data.layerViolations.length + suppressed.layerViolations.length, layerViolations.length);
		assert.deepStrictEqual(suppressed.layerViolations, [layerViolations[1], layerViolations[2]]);
	});
});

describe("fp-filter — browser readFile source", () => {
	it("resolves content from files[].content and returns null otherwise", () => {
		const fromData = readFileFrom({
			files: [{ path: "a.ts", content: "export const a = 1;\n" }, { path: "b.ts" }],
		});
		assert.strictEqual(fromData("a.ts"), "export const a = 1;\n");
		assert.strictEqual(fromData("b.ts"), null);
		assert.strictEqual(fromData("missing.ts"), null);
		assert.strictEqual(fromData(undefined), null);
		assert.strictEqual(fromData("toString"), null, "prototype keys must not leak");
	});
});

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
		sec({ path: ".pi/extensions/supervisor/github/gh-client.ts", code: "const ghToken = resolveGitHubToken();" }),
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
			sec({ title: "Shell Command Execution", description: "Shell() call detected.", path, code: "" }),
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
