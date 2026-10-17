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
