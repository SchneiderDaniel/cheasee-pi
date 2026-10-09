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
	{ path: "src/layer/from.ts", layer: "ui" },
	{ path: "src/layer/to.ts", layer: "ui" },
	{ path: "cmd/build.go", layer: "cmd" },
	{ path: "ui/src/retry.rs", layer: "ui" },
];
const CONNECTIONS = [{ source: "src/layer/from.ts", target: "src/layer/to.ts", fn: "render", count: 2 }];

function violation(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		from: "src/layer/from.ts",
		to: "src/layer/to.ts",
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

	it("keeps a same-language edge the report itself recorded between matching layers", () => {
		assert.strictEqual(keepsViolation(violation()), true);
	});

	it("drops a same-language pair with no recorded connection", () => {
		assert.strictEqual(
			keepsViolation(violation({ from: "src/layer/to.ts", to: "src/layer/from.ts" })),
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
	// A mirror of the upstream CODEFLOW_METRICS `calcHealth`, whose five terms
	// the issue documents. The authoritative check is the headless re-run in the
	// container; this pins the arithmetic the fix is claimed to move.
	const TOTAL_FUNCTIONS = 4890;

	function calcHealth(data: any): number {
		const score =
			100 -
			Math.min(20, (data.unusedFunctions.length / TOTAL_FUNCTIONS) * 100) -
			Math.min(20, (data.circularDependencyIssues?.length ?? 0) * 5) -
			Math.min(
				15,
				data.architectureIssues.filter((i: any) => String(i.title).includes("Large")).length * 3,
			) -
			Math.min(15, Math.max(0, data.dependencies.length / data.files.length - 3) * 2) -
			Math.min(
				20,
				data.securityIssues.filter((i: any) => String(i.severity).toLowerCase() === "high").length * 5,
			);
		return Math.round(score);
	}

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

	const data = {
		files,
		connections: CONNECTIONS,
		dependencies: Array.from({ length: 5006 }, (_, i) => i),
		unusedFunctions: Array.from({ length: 24 }, (_, i) => ({ name: `dead${i}` })),
		architectureIssues: [{ title: "Large Function: render" }],
		circularDependencyIssues: [],
		securityIssues: nineHighs,
		layerViolations: oneHundredFiftySeven,
	};

	it("reproduces the reported 73 (C) before the filter", () => {
		assert.strictEqual(data.securityIssues.length, 9);
		assert.strictEqual(data.layerViolations.length, 157);
		assert.strictEqual(calcHealth(data), 73);
	});

	it("scores 93 (A) after the filter, with the security term at zero", () => {
		const { data: clean, suppressed } = sanitizeAnalysisData(data, readFile);
		assert.strictEqual(suppressed.security.length, 9, "all nine HIGH hits must be suppressed");
		assert.strictEqual(suppressed.layerViolations.length, 157, "the whole layer category is noise");
		assert.strictEqual(clean.securityIssues.length, 0);
		assert.strictEqual(clean.layerViolations.length, 0);
		assert.ok(calcHealth(clean) >= 90, `expected an A, got ${calcHealth(clean)}`);
		assert.strictEqual(calcHealth(clean), 93);
	});
});
