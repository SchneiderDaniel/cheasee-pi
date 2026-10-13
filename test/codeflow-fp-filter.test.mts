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

type Suppressed = {
	security: any[];
	layerViolations: any[];
	hygiene: any[];
	deadCode: any[];
	duplicates: any[];
};

const { sanitizeAnalysisData, isFalsePositiveHygiene, readFileFrom } = requireCjs(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
	) => { data: any; suppressed: Suppressed };
	isFalsePositiveHygiene: (issue: unknown, readFile?: (path: unknown) => string | null) => boolean;
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

/** A LOW hygiene finding as the analyzer emits it: no snippet of its own. */
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
	assert.strictEqual(
		suppressed.security.length + suppressed.hygiene.length + data.securityIssues.length,
		1,
		"no finding may vanish",
	);
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
		assert.strictEqual(keepsSecurity(sec({ code: '//note\nconst q = "SELECT " + id;' })), true);
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
		assert.strictEqual(
			keepsSecurity(sec({ ...gh, code: "const KEY = process.env.GH_TOKEN;" })),
			false,
			"process.env",
		);
		assert.strictEqual(
			keepsSecurity(sec({ ...gh, code: 'let k = env::var("GH_TOKEN");' })),
			false,
			"env::var",
		);
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
				sec({
					title: "Command Execution",
					description: "run() invokes spawn().",
					path: "src/spawn.ts",
					code: "spawn();",
				}),
			),
			true,
		);
	});

	it("keeps a finding when the cited file cannot be read (absence is not proof)", () => {
		assert.strictEqual(
			keepsSecurity(sec({ path: "does/not/exist.ts", code: 'const KEY = "sk-live-abc";' })),
			true,
		);
	});

	it("keeps MEDIUM and keeps LOW hygiene on shipping source (real work, not an artifact)", () => {
		for (const severity of ["medium", "MEDIUM"]) {
			assert.strictEqual(
				keepsSecurity(
					sec({ severity, title: "Code Comments", description: "TODO", code: "// TODO: fix" }),
				),
				true,
				`${severity} must not be filtered here`,
			);
		}
		assert.strictEqual(
			keepsSecurity(
				sec({
					severity: "low",
					title: "Code Comments",
					code: "// TODO: fix",
					path: "src/config.ts",
				}),
			),
			true,
			"a LOW TODO marker in shipping source is real work",
		);
	});
});

describe("fp-filter — LOW hygiene false positives (Phase 1)", () => {
	it("suppresses LOW Code Comments on a test-directory path", () => {
		assert.strictEqual(
			isFalsePositiveHygiene(
				hyg({ path: ".pi/extensions/agent-harness/test/index.test.ts" }),
				nullReadFile,
			),
			true,
		);
	});

	it("suppresses test/spec files outside any test directory", () => {
		for (const path of [
			"src/widget.test.ts",
			"src/widget.test.mts",
			"src/widget.spec.ts",
			"src/widget.spec.tsx",
		]) {
			assert.strictEqual(isFalsePositiveHygiene(hyg({ path }), nullReadFile), true, path);
		}
		assert.strictEqual(
			isFalsePositiveHygiene(hyg({ path: "src/latest.ts" }), nullReadFile),
			false,
			"not a .test.* file",
		);
	});

	it("suppresses LOW Debug Statements on a test path (the console fixtures)", () => {
		assert.strictEqual(
			isFalsePositiveHygiene(
				hyg({
					title: "Debug Statements",
					path: ".pi/extensions/structural-analyzer/test/index.test.mts",
				}),
				nullReadFile,
			),
			true,
		);
	});

	it("suppresses LOW hygiene on documentation artifacts", () => {
		for (const path of [
			".pi/extensions/ripgrep-search/README.md",
			"APPEND_SYSTEM.md",
			".pi/skills/audit-clean-code/SKILL.md",
			".pi/skills/audit-codeflow-analysis/references/known-false-positives.md",
			"docs/_config.yml",
			"docs/guide.mdx",
		]) {
			assert.strictEqual(isFalsePositiveHygiene(hyg({ path }), nullReadFile), true, path);
		}
	});

	it("keeps LOW hygiene on shipping source", () => {
		for (const path of [
			".pi/extensions/ask-user/jsonl-logger.ts",
			".pi/extensions/ripgrep-search/index.ts",
			".pi/extensions/structural-analyzer/index.ts",
			".pi/extensions/structural-analyzer/validate.ts",
			"cmd/cheasee-pi/main.go",
		]) {
			assert.strictEqual(isFalsePositiveHygiene(hyg({ path }), nullReadFile), false, path);
		}
	});

	it("is severity- and title-gated", () => {
		for (const severity of ["medium", "high", "MEDIUM"]) {
			assert.strictEqual(
				isFalsePositiveHygiene(hyg({ severity, path: "src/widget.test.ts" }), nullReadFile),
				false,
				severity,
			);
		}
		for (const title of [
			"Shell Command Execution",
			"Code Comment",
			"code comments",
			"code comments ",
		]) {
			assert.strictEqual(
				isFalsePositiveHygiene(hyg({ title, path: "src/widget.test.ts" }), nullReadFile),
				false,
				title,
			);
		}
	});

	it("keeps malformed findings (never suppress on ambiguity)", () => {
		for (const issue of [
			null,
			"low",
			hyg({ severity: undefined }),
			hyg({ title: undefined }),
			hyg({ path: undefined }),
			hyg({ path: "" }),
			hyg({ path: 42 }),
		]) {
			assert.strictEqual(isFalsePositiveHygiene(issue, nullReadFile), false, JSON.stringify(issue));
		}
	});

	it("classifies by path alone: no cited file is read", () => {
		const boom = () => {
			throw new Error("the hygiene rule must not read the cited file");
		};
		assert.strictEqual(isFalsePositiveHygiene(hyg({ path: "src/widget.test.ts" }), boom), true);
	});
});

describe("fp-filter — hygiene integration and invariants (Phase 2)", () => {
	it("always carries the full suppressed key set, even for empty input", () => {
		for (const input of [null, undefined, 42, "x", {}, { securityIssues: [] }]) {
			const { suppressed } = sanitizeAnalysisData(input, readFile);
			assert.deepStrictEqual(
				Object.keys(suppressed).sort(),
				["deadCode", "duplicates", "hygiene", "layerViolations", "security"],
				JSON.stringify(input),
			);
		}
	});

	it("routes a LOW hygiene finding to suppressed.hygiene, never suppressed.security", () => {
		const finding = hyg({ path: "src/widget.test.ts" });
		const { data, suppressed } = sanitizeAnalysisData({ securityIssues: [finding] }, readFile);
		assert.deepStrictEqual(suppressed.hygiene, [finding]);
		assert.deepStrictEqual(suppressed.security, []);
		assert.deepStrictEqual(data.securityIssues, []);
	});

	it("accounts for every input entry across the three buckets", () => {
		const issues = [
			sec(),
			sec({ code: "" }),
			hyg({ path: "src/widget.test.ts" }),
			sec({ severity: "low", title: "Code Comments", code: "// TODO", path: "src/config.ts" }),
		];
		const violations = [violation(), violation({ from: "cmd/build.go", to: "ui/src/retry.rs" })];
		const input = {
			files: LAYER_FILES,
			connections: CONNECTIONS,
			securityIssues: issues,
			layerViolations: violations,
		};
		const before = structuredClone(input);

		const { data, suppressed } = sanitizeAnalysisData(input, readFile);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.strictEqual(
			data.securityIssues.length + suppressed.security.length + suppressed.hygiene.length,
			issues.length,
		);
		assert.strictEqual(
			data.layerViolations.length + suppressed.layerViolations.length,
			violations.length,
		);
	});

	it("leaves stats.security alone when only hygiene findings are dropped", () => {
		const input = {
			stats: { files: 2, security: 1 },
			securityIssues: [sec(), hyg({ path: "src/widget.test.ts" })],
		};
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(suppressed.hygiene.length, 1);
		assert.strictEqual(data.stats.security, 1, "the score term counts HIGH findings only");
	});

	it("is idempotent when hygiene findings are dropped on the first pass", () => {
		const input = { securityIssues: [sec({ code: "" }), hyg({ path: "src/widget.test.ts" })] };
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
		assert.strictEqual(suppressed.hygiene.length, 0);
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
		assert.deepStrictEqual(data.stats, { files: 3, security: 1, violations: 1 });

		const second = sanitizeAnalysisData(data, readFile);
		assert.deepStrictEqual(second.data.stats, data.stats, "the corrected counts are stable");
	});
});

describe("fp-filter — layer violations (Phase 2)", () => {
	it("drops cross-language pairs (the 142)", () => {
		for (const to of ["ui/src/retry.rs", "ui/src/main.rs"]) {
			assert.strictEqual(
				keepsViolation(
					violation({ from: "src/layer/from.ts", to, fromLayer: "ui", toLayer: "ui" }),
				),
				false,
				`.ts -> ${to.slice(to.lastIndexOf("."))} cannot be an import edge`,
			);
		}
		assert.strictEqual(
			keepsViolation(
				violation({ from: "cmd/build.go", to: "ui/src/retry.rs", fromLayer: "cmd", toLayer: "ui" }),
			),
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
		const edge = {
			from,
			fromLayer: "utils",
			to,
			toLayer: "services",
			fn: "result",
			suggestion: "invert",
		};
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
			connections: [
				{ source: "src/layer/from.ts", target: "src/layer/to.ts", fn: "render", count: 1 },
			],
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
		assert.strictEqual(
			data.layerViolations.length + suppressed.layerViolations.length,
			layerViolations.length,
		);
		assert.deepStrictEqual(suppressed.layerViolations, [layerViolations[1], layerViolations[2]]);
	});
});

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
