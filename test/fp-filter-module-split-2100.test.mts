// ─── False-positive filter module split (issue #2100) ─────────────
// CodeFlow's `VBA God Module` / `God Object` signals flagged
// `codeflow/fp-filter.js`: one UMD closure holding six independent policies and
// 91 declarations between them. This branch keeps the served name (so the route,
// the `piFpFilter` global and the Node `require` path are unchanged) and turns it
// into an index over eight policy modules under `codeflow/fp-filter/`.
//
// The oracles here are the ones the split itself has to satisfy:
//
//   * the metric exit — every file of the family under both ceilings, and the
//     pre-refactor declaration set conserved exactly (nothing dropped, inlined
//     away or duplicated by the move);
//   * the Node load path — the public surface, the purity of the policy core and
//     the injected `readFile` seam;
//   * the policy invariants that cross the new module boundaries — the six
//     suppression buckets, an exhaustive partition, idempotence, the two text
//     scanners staying separate, and the fail-closed path for an unreadable file;
//   * the browser load path — one global per module, the same surface as the
//     Node require, load-order coupling, a doubled tag and no CJS back-reference;
//   * the served page against the headless runner on the recorded pinned-analyzer
//     output (the rollback guard: both paths must classify identically);
//   * the register ledgers re-anchored, so the metric is cleared rather than
//     hidden.
//
// The served adapters are pinned here (module-path containment, `_BRIDGE_SCRIPT`
// tag order, Dockerfile COPY set) and in
// `cmd/cheasee-pi/codeflow_shim_fp_filter_test.go` (HTTP route, verbatim bytes,
// Go harness copy set); the behaviour of the whole policy is pinned by
// `test/codeflow-fp-filter.test.mts`, which stays byte-identical.
//
// Run: node --experimental-strip-types --test test/fp-filter-module-split-2100.test.mts

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import * as acorn from "acorn";

import { countAcornBabelFunctions } from "./fixtures/acorn-babel-mirror.mts";
import { calcComplexity } from "./fixtures/complexity-mirror.mts";
import { countFunctions } from "./fixtures/function-count-mirror.mts";
import { CODE_EXTS, isFlagged, lineCount } from "./fixtures/long-file-mirror.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CODEFLOW = "cmd/cheasee-pi/embedded/docker/codeflow";
const INDEX_REL = `${CODEFLOW}/fp-filter.js`;
const INDEX = resolve(ROOT, INDEX_REL);
const MODULE_DIR = resolve(ROOT, CODEFLOW, "fp-filter");
const SERVER_PY = resolve(ROOT, CODEFLOW, "server.py");
const FIXTURE = resolve(HERE, "fixtures", "codeflow-real-analysis-fp.json");

/**
 * The pinned module set, in load order: each module reads only the globals of
 * the tags before it and the index loads last. The served route allowlist
 * (`_FP_FILTER_MODULES`), the `<script>` tags and the Dockerfile COPY set all
 * name exactly these files.
 */
const MODULES = [
	"lexical",
	"hygiene",
	"layer",
	"security/high",
	"security/command-exec-policy",
	"security/command-exec",
	"dead-code",
	"duplicates",
];

/** The browser global each module tag publishes (the index reads these). */
const GLOBALS: Record<string, string> = {
	lexical: "piFpFilterLexical",
	hygiene: "piFpFilterHygiene",
	layer: "piFpFilterLayer",
	"security/high": "piFpFilterSecurityHigh",
	"security/command-exec-policy": "piFpFilterSecurityCommandExecPolicy",
	"security/command-exec": "piFpFilterCommandExec",
	"dead-code": "piFpFilterDeadCode",
	duplicates: "piFpFilterDuplicates",
};

/** The index's public surface — unchanged by the split. */
const PUBLIC_API = [
	"REPO_LAYERS",
	"isFalsePositiveDuplicate",
	"isFalsePositiveHygiene",
	"isFalsePositiveLayerViolation",
	"isFalsePositiveSecurity",
	"moduleChildPaths",
	"readFileFrom",
	"reconcileAggregateIssues",
	"resolveLayer",
	"sanitizeAnalysisData",
];

const FAMILY = [INDEX_REL, ...MODULES.map((name) => `${CODEFLOW}/fp-filter/${name}.js`)];

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const moduleSource = (name: string): string =>
	readFileSync(resolve(MODULE_DIR, `${name}.js`), "utf-8");

const requireCjs = createRequire(import.meta.url);
const api = requireCjs(INDEX) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
		opts?: { deriveSuggestions?: (filtered: any) => unknown },
	) => { data: any; suppressed: Record<string, any[]> };
	reconcileAggregateIssues: (issues: unknown[], counts: Record<string, number | null>) => unknown[];
	moduleChildPaths: (logicalPath: unknown, candidates: unknown) => string[];
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
	REPO_LAYERS: unknown[];
	resolveLayer: (path: unknown) => unknown;
};

/**
 * Every module reference in a source file, found on the AST so a `require(` or a
 * `node:` string inside a *comment*, a *regex literal* or a string pattern (the
 * argv-policy rules spell `require("child_process")` as a regex) is not one.
 */
function moduleReferences(src: string): string[] {
	const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: "module", allowHashBang: true });
	const found: string[] = [];
	const walk = (node: any): void => {
		if (!node || typeof node !== "object") return;
		if (node.type === "ImportDeclaration") found.push(`import ${node.source?.value}`);
		if (node.type === "ImportExpression") found.push("import()");
		if (node.type === "CallExpression" && node.callee?.type === "Identifier")
			if (node.callee.name === "require") found.push("require()");
		if (node.type === "Literal" && typeof node.value === "string" && node.value.startsWith("node:"))
			found.push(node.value);
		for (const key of Object.keys(node)) {
			if (["loc", "range", "start", "end", "raw"].includes(key)) continue;
			const child = node[key];
			if (Array.isArray(child)) child.forEach(walk);
			else if (child && typeof child === "object" && child.type) walk(child);
		}
	};
	walk(ast);
	return found;
}

/** The pinned analyzer's declaration count for one file of the family. */
const declarations = (rel: string): number => countAcornBabelFunctions(read(rel), "js");

/**
 * The declarations the pinned acorn-babel parser counts, by name (the metric the
 * split has to conserve). Mirrors `countAcornBabelFunctions`'s walk without the
 * `name@line` dedupe key, because the move rewrites every line number.
 */
function declarationNames(src: string): string[] {
	const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: "module", allowHashBang: true });
	const out: string[] = [];
	const add = (name: unknown): void => {
		if (typeof name === "string") out.push(name);
	};
	const key = (node: any): unknown => node?.key?.name ?? node?.key?.value;
	const walk = (node: any): void => {
		if (!node || typeof node !== "object") return;
		if (node.type === "FunctionDeclaration" && node.id?.name) add(node.id.name);
		if (node.type === "VariableDeclaration") {
			for (const d of node.declarations ?? []) {
				const init = d.init;
				if (
					d.id?.type === "Identifier" &&
					(init?.type === "FunctionExpression" || init?.type === "ArrowFunctionExpression")
				)
					add(d.id.name);
			}
		}
		if (node.type === "MethodDefinition" && node.key && key(node) !== "constructor") add(key(node));
		if (node.type === "Property" && node.method) add(key(node));
		if (
			node.type === "Property" &&
			!node.method &&
			(node.value?.type === "FunctionExpression" || node.value?.type === "ArrowFunctionExpression")
		)
			add(key(node));
		for (const k of Object.keys(node)) {
			if (["loc", "range", "start", "end", "raw"].includes(k)) continue;
			const child = node[k];
			if (Array.isArray(child)) child.forEach(walk);
			else if (child && typeof child === "object" && child.type) walk(child);
		}
	};
	walk(ast);
	return out.sort();
}

const JSON_COPY = <T,>(value: T): any => JSON.parse(JSON.stringify(value));

/** `git show <commit>:<index>`, or null when the path is absent at that commit. */
function indexAt(commit: string): string | null {
	try {
		return execFileSync("git", ["show", `${commit}:${INDEX_REL}`], {
			cwd: ROOT,
			encoding: "utf-8",
			maxBuffer: 1 << 26,
		});
	} catch {
		return null;
	}
}

/** True for the split index: it owns the module table and the `wire(load)` loader. */
function isSplitIndex(src: string): boolean {
	return /\bMODULES\s*=\s*{/.test(src) && /\bwire\(load\)/.test(src);
}

/**
 * The pre-split index, resolved backwards from `base`.
 *
 * `merge-base origin/main HEAD` carries the pre-split file only while #2100 is
 * unmerged; once it lands, that merge base *is* the split index, so the recorded
 * 91-declaration baseline would measure the wrong file. Walk back over the
 * commits that touched the index until one still holds the pre-split surface, so
 * this oracle measures the same file on the branch and after the merge.
 */
function preSplitIndex(base: string): string | null {
	let commit = base;
	for (let hop = 0; hop < 64; hop += 1) {
		const source = indexAt(commit);
		if (source === null) return null;
		if (!isSplitIndex(source)) return source;
		let toucher: string;
		try {
			toucher = execFileSync("git", ["log", "--format=%H", "-n", "1", commit, "--", INDEX_REL], {
				cwd: ROOT,
				encoding: "utf-8",
			}).trim();
		} catch {
			return null;
		}
		if (!toucher) return null;
		commit = `${toucher}^`;
	}
	return null;
}

/** Every `.rs` file under the UI crate, relative to the repo root. */
function rustFiles(): string[] {
	const out: string[] = [];
	const walk = (abs: string, rel: string): void => {
		for (const entry of readdirSync(abs, { withFileTypes: true })) {
			const next = `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(resolve(abs, entry.name), next);
			else if (entry.name.endsWith(".rs")) out.push(next);
		}
	};
	const ui = resolve(ROOT, CODEFLOW, "ui");
	if (existsSync(ui)) walk(ui, `${CODEFLOW}/ui`);
	return out;
}

/** The fixture as the served page holds it: text on `piFpSource`, `content` freed. */
function servedShape(): any {
	const recorded = JSON.parse(read("test/fixtures/codeflow-real-analysis-fp.json"));
	const raw = (rel: string): string | null => {
		try {
			return readFileSync(resolve(ROOT, rel), "utf-8");
		} catch {
			return null;
		}
	};
	const files = (recorded.files ?? []).map((f: { path: string }) => ({
		path: f.path,
		content: null,
		piFpSource: raw(f.path),
	}));
	// The Rust module children the earlier splits minted are analyzed files even
	// when the recording predates them; `readFileFrom` resolves a facade to them.
	const seen = new Set(files.map((f: { path: string }) => f.path));
	for (const rel of rustFiles()) {
		if (!seen.has(rel)) files.push({ path: rel, content: null, piFpSource: raw(rel) });
	}
	return { ...recorded, files };
}

/** Load the modules then the index, exactly as the served script tags do. */
function browserContext(order: string[] = MODULES): {
	sandbox: Record<string, any>;
	published: string[][];
} {
	const sandbox: Record<string, any> = {};
	vm.createContext(sandbox);
	const published: string[][] = [];
	for (const name of order) {
		const before = new Set(Object.keys(sandbox));
		vm.runInContext(moduleSource(name), sandbox, { filename: `${name}.js` });
		published.push(Object.keys(sandbox).filter((key) => !before.has(key)));
	}
	return { sandbox, published };
}

/** Load modules + index into one sandbox (the served page's order). */
function loadFilter(order: string[] = MODULES): Record<string, any> {
	const { sandbox } = browserContext(order);
	vm.runInContext(read(INDEX_REL), sandbox, { filename: "fp-filter.js" });
	return sandbox;
}

/** The served `generateReport` wrapper, emitted by server.py's own rewrite. */
function servedWrapper(): string | null {
	try {
		return execFileSync(
			"python3",
			[
				"-c",
				[
					"import runpy, sys",
					"m = runpy.run_path(sys.argv[1])",
					"pat, repl = m['_UI_REWRITES'][0]",
					"src = b'function generateReport(format){ return data; }'",
					"sys.stdout.write(pat.sub(lambda _: repl, src).decode())",
				].join("\n"),
				SERVER_PY,
			],
			{ encoding: "utf-8" },
		);
	} catch {
		return null;
	}
}

// ─── Phase 1: the metric exit and the Node load path ───────────────

describe("fp-filter module split #2100 — metric exit", () => {
	it("pins the module set, the index name and the browser globals", () => {
		assert.equal(MODULES.length, 8, "eight policy modules");
		assert.equal(new Set(MODULES).size, MODULES.length, "a module is listed twice");
		for (const rel of FAMILY) assert.ok(existsSync(resolve(ROOT, rel)), `missing ${rel}`);
		assert.ok(INDEX_REL.endsWith("fp-filter.js"), "the index keeps its served name");
		assert.equal(CODE_EXTS.includes(".js"), true, "the analyzer scores .js");
		// The index's own module table is the source of the browser globals: a tag
		// renaming a global here would break only the served page, so pin both.
		for (const name of MODULES) {
			assert.match(moduleSource(name), new RegExp(`root\\.${GLOBALS[name]} = api`));
			assert.ok(read(INDEX_REL).includes(`"${GLOBALS[name]}"`), `the index reads ${GLOBALS[name]}`);
		}
	});

	it("lands every file of the family under both declaration ceilings", () => {
		for (const rel of FAMILY) {
			const n = declarations(rel);
			assert.ok(n <= 15, `${rel} counts ${n} declarations (God Object ceiling 15)`);
			assert.ok(n <= 20, `${rel} counts ${n} declarations (VBA God Module ceiling 20)`);
			assert.ok(lineCount(read(rel)) <= 500, `${rel} is still a long file`);
			assert.equal(isFlagged(read(rel), rel), false, `${rel} is flagged`);
		}
	});

	it("is the only scored file whose name contains fp-filter.js", () => {
		const named = FAMILY.filter((rel) => rel.includes("fp-filter.js"));
		assert.deepStrictEqual(named, [INDEX_REL], 'the earlier count("fp-filter.js") == 1 guard');
	});

	it("conserves the pre-refactor declaration set exactly", (t) => {
		// The fork point is stable: `preSplitIndex` resolves the pre-split file
		// whether this runs on the branch or after the merge.
		let base: string;
		try {
			base = execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
				cwd: ROOT,
				encoding: "utf-8",
			}).trim();
		} catch {
			return t.skip("origin/main is not present in this checkout");
		}
		const original = preSplitIndex(base);
		if (!original) return t.skip(`the pre-split index is absent at or before ${base}`);
		const before = declarationNames(original);
		assert.equal(before.length, 91, "the recorded pre-refactor declaration count");
		const after = FAMILY.flatMap((rel) => declarationNames(read(rel)));
		// `wire` is the one declaration the split adds: the loader that builds the
		// same dependency graph for both paths. Nothing else may appear or vanish.
		assert.equal(after.length, before.length + 1, `family counts ${after.length}`);
		const added = [...after];
		for (const name of before) {
			const at = added.indexOf(name);
			assert.notEqual(at, -1, `${name} was dropped by the move`);
			added.splice(at, 1);
		}
		assert.deepStrictEqual(added, ["wire"], "only the loader wiring is new");
	});

	it("never reaches the loader from a policy module (dependencies injected)", () => {
		for (const name of MODULES) {
			const src = moduleSource(name);
			assert.equal(/^\s*import\s/m.test(src), false, `${name} uses an import statement`);
			assert.deepStrictEqual(
				moduleReferences(src),
				[],
				`${name} loads a module: dependencies are injected, the core stays pure`,
			);
		}
	});

	it("fails closed when a module is built without its dependencies", () => {
		for (const name of MODULES) {
			const sandbox: Record<string, any> = {};
			vm.createContext(sandbox);
			vm.runInContext(moduleSource(name), sandbox, { filename: `${name}.js` });
			const factory = sandbox[GLOBALS[name]];
			assert.equal(typeof factory, "function", `${name} publishes its factory`);
			assert.throws(() => factory(), `${name} must reject a missing dependency set`);
			assert.throws(() => factory(null), `${name} must reject a null dependency set`);
		}
	});
});

describe("fp-filter module split #2100 — Node load path", () => {
	it("exposes exactly the pre-refactor public surface", () => {
		assert.deepStrictEqual(Object.keys(api).sort(), PUBLIC_API);
		for (const key of PUBLIC_API) assert.notEqual(api[key as keyof typeof api], undefined, key);
	});

	it("leaves the browser global unpublished in Node", () => {
		assert.equal((globalThis as Record<string, any>).piFpFilter, undefined);
	});

	it("does not mutate the caller's data", () => {
		const data = servedShape();
		const deepFreeze = (value: any): any => {
			if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
			Object.freeze(value);
			for (const key of Object.keys(value)) deepFreeze(value[key]);
			return value;
		};
		const before = JSON.stringify(data);
		deepFreeze(data);
		const result = api.sanitizeAnalysisData(data, api.readFileFrom(data));
		assert.equal(typeof result, "object");
		// Frozen objects throw on write under "use strict", and the byte comparison
		// catches a suppressed array written back where the caller could see it.
		assert.equal(JSON.stringify(data), before, "the filter mutated its input");
	});

	it("keeps the injected readFile seam, and fails closed without it", () => {
		// A HIGH finding whose message names a symbol the cited file does not
		// contain: provable only against the file text.
		const issue = {
			severity: "high",
			title: "Hardcoded Secret",
			description: "possible credential returned by loadToken()",
			code: "const token = loadToken();",
			path: "src/absent.ts",
		};
		const withReader = api.sanitizeAnalysisData(
			{ securityIssues: [issue], stats: { security: 1 } },
			() => "export const other = 1;",
		);
		assert.deepStrictEqual(withReader.data.securityIssues, [], "the cited symbol is absent");
		const withoutReader = api.sanitizeAnalysisData({
			securityIssues: [issue],
			stats: { security: 1 },
		});
		assert.deepStrictEqual(
			withoutReader.data.securityIssues,
			[issue],
			"no reader is never evidence: the finding stays (fail closed)",
		);
		// Content-free rules still classify: an empty snippet is a false positive
		// whatever the reader can supply.
		const empty = api.sanitizeAnalysisData({
			securityIssues: [{ severity: "high", title: "Hardcoded Secret", code: "", path: "x.ts" }],
		});
		assert.deepStrictEqual(empty.data.securityIssues, []);
		assert.equal(empty.suppressed.security.length, 1);
	});
});

// ─── Phase 2: invariants across the new module boundaries ──────────

describe("fp-filter module split #2100 — policy invariants", () => {
	const KEYS = ["security", "layerViolations", "hygiene", "deadCode", "duplicates", "suggestions"];

	it("always reports the six suppression buckets", () => {
		for (const input of [{}, null, [], undefined, 0, "text"]) {
			const { suppressed } = api.sanitizeAnalysisData(input);
			assert.deepStrictEqual(Object.keys(suppressed), KEYS, `buckets for ${JSON.stringify(input)}`);
			for (const key of KEYS) assert.ok(Array.isArray(suppressed[key]), `${key} is a list`);
		}
	});

	it("partitions a mixed fixture exhaustively", () => {
		const data = {
			securityIssues: [
				{ severity: "high", title: "Hardcoded Secret", code: "", path: "src/a.ts" },
				{ severity: "medium", title: "Command Execution", path: "src/b.ts" },
				{ severity: "low", title: "Code Comments", path: "src/c.test.ts" },
				{ severity: "low", title: "Code Comments", path: "src/keep.ts" },
			],
			layerViolations: [{ from: "src/from.ts", to: "src/to.ts" }],
			deadFunctions: [{ name: "ghost", file: "src/keep.ts" }],
			duplicates: [
				{ type: "code", name: "a, b, c", files: [{ file: "src/a.ts" }] },
				{ type: "code", name: "a, b", files: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
			],
			issues: [],
			stats: { security: 1, violations: 1, dead: 1, duplicates: 2 },
			files: [{ path: "src/keep.ts", content: "export function keep() { ghost(); }" }],
		};
		const { data: out, suppressed } = api.sanitizeAnalysisData(data, api.readFileFrom(data));
		const kept =
			out.securityIssues.length +
			out.layerViolations.length +
			out.deadFunctions.length +
			out.duplicates.length;
		const dropped =
			suppressed.security.length +
			suppressed.hygiene.length +
			suppressed.layerViolations.length +
			suppressed.deadCode.length +
			suppressed.duplicates.length;
		const filed =
			data.securityIssues.length +
			data.layerViolations.length +
			data.deadFunctions.length +
			data.duplicates.length;
		assert.equal(kept + dropped, filed, "every entry lands in exactly one bucket");
		assert.deepStrictEqual(
			out.securityIssues.map((s: any) => s.path),
			// The MEDIUM Command Execution keeps its finding: no reader means no file
			// text to prove the argv shape against (fail closed).
			["src/b.ts", "src/keep.ts"],
		);
		assert.equal(out.stats.security, 0, "the stat follows the array");
	});

	it("is idempotent across the module boundary", () => {
		const data = servedShape();
		const once = api.sanitizeAnalysisData(data, api.readFileFrom(data));
		const twice = api.sanitizeAnalysisData(JSON_COPY(data), api.readFileFrom(JSON_COPY(data)));
		assert.deepStrictEqual(JSON_COPY(once.data), JSON_COPY(twice.data));
		assert.deepStrictEqual(JSON_COPY(once.suppressed), JSON_COPY(twice.suppressed));
		// Re-filtering an already filtered report changes nothing.
		const again = api.sanitizeAnalysisData(
			JSON_COPY(once.data),
			api.readFileFrom(JSON_COPY(once.data)),
		);
		assert.deepStrictEqual(JSON_COPY(again.data), JSON_COPY(once.data));
	});

	it("keeps the two text scanners in their own modules", () => {
		const lexicalSrc = moduleSource("lexical");
		const deadCodeSrc = moduleSource("dead-code");
		assert.match(lexicalSrc, /function stripComments\(/);
		assert.equal(lexicalSrc.includes("function stripNoise("), false, "stripNoise is dead-code's");
		assert.match(deadCodeSrc, /function stripNoise\(/);
		assert.equal(
			deadCodeSrc.includes("function stripComments("),
			false,
			"stripComments is lexical's",
		);
		// They are deliberately not merged: the security rules need the code a file
		// still executes (strings kept, comments gone), the dead-code rules need the
		// shape (string bodies blanked). One text, two outputs.
		const lexical = requireCjs(resolve(MODULE_DIR, "lexical.js"))({});
		const deadCode = requireCjs(resolve(MODULE_DIR, "dead-code.js"))({
			skipString: lexical.skipString,
			escapeRe: lexical.escapeRe,
			extensionOf: lexical.extensionOf,
			mapIssues: lexical.mapIssues,
		});
		const source = [
			'const a = "// fp-filter inside a string"; // drop me',
			"const re = /\\/\\/ not a comment/;",
		].join("\n");
		const comments = lexical.stripComments(source);
		assert.ok(comments.includes('"// fp-filter inside a string"'), "a string body is code");
		assert.equal(comments.includes("drop me"), false, "a real comment is removed");
		assert.ok(comments.includes("not a comment"), "a regex literal is not a comment");
		const noise = deadCode.stripNoise(source, "src/a.ts");
		assert.equal(noise.includes("fp-filter inside a string"), false, "a string body is noise");
		assert.equal(noise.includes("drop me"), false, "a comment is noise");
		assert.ok(noise.includes("const a ="), "the shape survives");
	});

	it("fails closed when the cited file is unreadable", () => {
		const data = {
			securityIssues: [
				{
					severity: "high",
					title: "Hardcoded Secret",
					// A literal assignment is a real value, not a false positive: it
					// survives with or without the file text.
					code: 'const secret = "s3cr3t-value";',
					path: "gone.ts",
				},
				{ severity: "medium", title: "Command Execution", path: "gone.ts" },
			],
			duplicates: [{ type: "name", name: "apply", files: [{ file: "gone.ts", line: 3 }] }],
			stats: { security: 1 },
		};
		const { data: out } = api.sanitizeAnalysisData(data, () => null);
		assert.equal(out.securityIssues.length, 2, "no file text is never evidence");
		assert.equal(out.duplicates.length, 1, "an unreadable duplicate instance keeps the group");
	});

	it("keeps the moved helpers' pre-refactor outputs", () => {
		assert.deepStrictEqual(api.REPO_LAYERS, [], "the repo declares no layer taxonomy");
		assert.equal(api.resolveLayer("src/a.ts"), null);
		assert.deepStrictEqual(
			api.moduleChildPaths("src/retry.rs", ["src/retry.rs", "src/retry/wiring.rs"]),
			["src/retry/wiring.rs"],
		);
		const readFile = api.readFileFrom({
			files: [
				{ path: "src/retry.rs", content: "mod wiring;" },
				{ path: "src/retry/wiring.rs", content: "fn retry() {}" },
			],
		});
		assert.equal(readFile("src/retry.rs"), "mod wiring;\nfn retry() {}");
		assert.equal(readFile("src/missing.rs"), null);
		assert.deepStrictEqual(
			api.reconcileAggregateIssues(
				[
					{ title: "12 Unused Functions" },
					{ title: "4 Similar Code Blocks" },
					{ title: "Unrelated" },
				],
				{ "Unused Functions": 3, "Similar Code Blocks": 0 },
			),
			[{ title: "3 Unused Functions" }, { title: "Unrelated" }],
		);
	});
});

// ─── Phase 3: the browser load path ────────────────────────────────

describe("fp-filter module split #2100 — browser load path", () => {
	it("publishes exactly one new global per module, none overwriting another", () => {
		const { published } = browserContext();
		assert.equal(published.length, MODULES.length);
		const flat = published.flat();
		assert.deepStrictEqual(
			flat,
			MODULES.map((name) => GLOBALS[name]),
			"one disjoint global each",
		);
		assert.equal(new Set(flat).size, flat.length, "a module overwrote another's global");
		for (const name of MODULES) {
			const sandbox: Record<string, any> = {};
			vm.createContext(sandbox);
			vm.runInContext(moduleSource(name), sandbox, { filename: `${name}.js` });
			assert.equal(typeof sandbox[GLOBALS[name]], "function", `${name} publishes its factory`);
		}
	});

	it("publishes piFpFilter with the same surface as the Node require", () => {
		const sandbox = loadFilter();
		assert.deepStrictEqual(Object.keys(sandbox.piFpFilter).sort(), PUBLIC_API);
		for (const key of PUBLIC_API) {
			assert.equal(typeof sandbox.piFpFilter[key], typeof api[key as keyof typeof api], key);
		}
		// Same policy: one fixture through both loaders.
		const data = servedShape();
		const node = api.sanitizeAnalysisData(data, api.readFileFrom(data));
		const browser = sandbox.piFpFilter.sanitizeAnalysisData(
			data,
			sandbox.piFpFilter.readFileFrom(data),
		);
		assert.deepStrictEqual(JSON_COPY(browser.suppressed), JSON_COPY(node.suppressed));
	});

	it("fails closed when the index loads before its modules", () => {
		const sandbox: Record<string, any> = {};
		vm.createContext(sandbox);
		assert.throws(
			() => vm.runInContext(read(INDEX_REL), sandbox, { filename: "fp-filter.js" }),
			/fp-filter: missing module/,
			"the load-order coupling is enforced, not silent",
		);
		assert.equal(sandbox.piFpFilter, undefined, "no half-built filter is published");
	});

	it("is a no-op under a doubled tag", () => {
		const sandbox = loadFilter();
		const data = servedShape();
		const first = JSON_COPY(
			sandbox.piFpFilter.sanitizeAnalysisData(data, sandbox.piFpFilter.readFileFrom(data)),
		);
		for (const name of [...MODULES, null]) {
			const src = name === null ? read(INDEX_REL) : moduleSource(name);
			assert.doesNotThrow(() => vm.runInContext(src, sandbox), `re-loading ${name ?? "index"}`);
		}
		const second = JSON_COPY(
			sandbox.piFpFilter.sanitizeAnalysisData(data, sandbox.piFpFilter.readFileFrom(data)),
		);
		assert.deepStrictEqual(second, first, "a re-injected tag changed the policy");
	});

	it("needs neither module, exports nor require in the browser", () => {
		const sandbox = loadFilter();
		for (const key of ["module", "exports", "require"]) {
			assert.equal(key in sandbox, false, `the sandbox defines ${key}`);
		}
		assert.equal(typeof sandbox.piFpFilter.sanitizeAnalysisData, "function");
	});
});

// ─── Phase 4: the served adapters ──────────────────────────────────

describe("fp-filter module split #2100 — served adapters", () => {
	const DOCKERFILE = resolve(ROOT, CODEFLOW, "Dockerfile");
	const UI_REWRITES_PY = resolve(ROOT, CODEFLOW, "ui_rewrites.py");

	/** Run a python snippet against a shim module; null when python3 is absent. */
	function python(snippet: string[], module = serverPy()): string | null {
		try {
			return execFileSync("python3", ["-c", snippet.join("\n"), module], {
				encoding: "utf-8",
			});
		} catch {
			return null;
		}
	}

	function serverPy(): string {
		return resolve(ROOT, CODEFLOW, "server.py");
	}

	it("ships the module tree with the index and tags it in load order", () => {
		// The index cannot run without its modules: the image must COPY the tree
		// beside it (one COPY, not a hand list a new module could miss), and the
		// emitted tags must follow the load dependency, index last.
		const dockerfile = readFileSync(DOCKERFILE, "utf-8");
		assert.match(dockerfile, /COPY fp-filter\.js \/opt\/codeflow\/fp-filter\.js/);
		assert.match(dockerfile, /COPY fp-filter\/ \/opt\/codeflow\/fp-filter\//);

		const script = python([
			"import runpy, sys",
			"m = runpy.run_path(sys.argv[1])",
			"sys.stdout.write(m['_BRIDGE_SCRIPT'].decode())",
		]);
		if (script === null) return; // python3 absent: the Go suite pins the same order.
		const tagged = [
			...script.matchAll(/<script src="fp-filter\/([\w/-]+)\.js" defer><\/script>/g),
		].map((m) => m[1]);
		assert.deepStrictEqual(tagged, MODULES, "one tag per module, in load order");
		const indexTag = '<script src="fp-filter.js" defer></script>';
		assert.equal(script.split(indexTag).length - 1, 1, "exactly one index tag");
		const indexAt = script.indexOf(indexTag);
		for (const name of tagged) {
			assert.ok(
				script.indexOf(`src="fp-filter/${name}.js"`) < indexAt,
				`${name} must load before the index tag`,
			);
		}
		assert.ok(
			script.lastIndexOf('src="codeflow-bridge.js"') > indexAt,
			"the bridge tag must follow the index",
		);
		// The served index name stays unique: `fp-filter/<name>.js` cannot match it.
		assert.equal(
			script.split('src="fp-filter.js"').length - 1,
			1,
			"the index is referenced exactly once",
		);
	});

	it("serves a module only from the allowlist table, never from request text", () => {
		// The path handed to `open` is a value of `_FP_FILTER_MODULE_PATHS`, built
		// once from the allowlist — so the table, not the request, decides what can
		// be read. Driven through python so the served code itself runs. `runpy`
		// returns a copy of the globals, so the tampering goes through the function's
		// own `__globals__`.
		const out = python(
			[
				"import runpy, sys",
				"m = runpy.run_path(sys.argv[1])",
				"module = m['_fp_filter_module_bytes']",
				"globals_ = module.__globals__",
				"out = []",
				// 1. an allowlisted name reads its own file;
				"out.append('read' if module('lexical') else 'empty')",
				// 2. a name the table does not carry cannot resolve, even when the
				//    allowlist tuple is widened to include it;
				"globals_['_FP_FILTER_MODULES'] += ('../server',)",
				"try:",
				"    module('../server')",
				"except KeyError:",
				"    out.append('unlisted')",
				"else:",
				"    out.append('read')",
				// 3. and an entry that resolved outside `fp-filter/` still fails closed.
				"globals_['_FP_FILTER_MODULE_PATHS']['hygiene'] = '../server'",
				"try:",
				"    module('hygiene')",
				"except OSError as exc:",
				"    out.append('confined' if 'escapes' in str(exc) else 'OSError')",
				"else:",
				"    out.append('read')",
				"print(','.join(out))",
			],
			UI_REWRITES_PY,
		);
		if (out === null) return; // python3 absent: the Go suite pins the route behaviour.
		assert.equal(
			out.trim(),
			"read,unlisted,confined",
			"only an allowlisted name reads, and even a table entry that escapes fails closed",
		);
	});

	it("reads a served module only under the allowlisted route prefix", () => {
		// `_fp_filter_module_name` turns the request tail into a name or a miss; the
		// route handler only serves a name that survived it, so `..`, an encoded
		// separator and an absolute path are 404s before any filesystem call.
		const out = python([
			"import runpy, sys",
			"m = runpy.run_path(sys.argv[1])",
			"cases = ('lexical.js', 'security/high.js', '../server.py', '..%2Fserver.py',",
			"         '%2e%2e%2e/server.py', 'security/../../server.py', '', 'lexical',",
			"         'hygiene.js/../server.py')",
			"print(','.join(repr(m['_fp_filter_module_name'](c)) for c in cases))",
		]);
		if (out === null) return; // python3 absent: the Go suite pins the route behaviour.
		assert.equal(
			out.trim(),
			["'lexical'", "'security/high'", ...Array(7).fill("None")].join(","),
			"only `<allowlisted name>.js` may resolve; nothing is stripped or normalised",
		);
	});
});

// ─── Phase 5: the served page and the headless runner agree ────────

describe("fp-filter module split #2100 — served page parity", () => {
	it("filters the recorded pinned-analyzer output identically on both paths", () => {
		const data = servedShape();
		const highBefore = data.securityIssues.filter(
			(s: any) => String(s.severity).toLowerCase() === "high",
		).length;
		assert.ok(highBefore > 0, "the recording must carry HIGH findings, or this passes vacuously");
		const node = JSON_COPY(api.sanitizeAnalysisData(data, api.readFileFrom(data)));
		const sandbox = loadFilter();
		const browser = JSON_COPY(
			sandbox.piFpFilter.sanitizeAnalysisData(data, sandbox.piFpFilter.readFileFrom(data)),
		);
		for (const key of ["security", "layerViolations", "hygiene", "deadCode", "duplicates"]) {
			assert.equal(browser.suppressed[key].length, node.suppressed[key].length, `${key} drifted`);
		}
		assert.deepStrictEqual(browser.data.securityIssues, node.data.securityIssues);
		assert.deepStrictEqual(browser.data.layerViolations, node.data.layerViolations);
		assert.deepStrictEqual(browser.data.deadFunctions, node.data.deadFunctions);
		assert.deepStrictEqual(browser.data.stats, node.data.stats);
		const highAfter = (browser.data.securityIssues as any[]).filter(
			(s) => String(s.severity).toLowerCase() === "high",
		).length;
		assert.equal(highAfter, 0, "no HIGH finding may survive the filter");
		assert.ok(node.suppressed.layerViolations.length > 0, "the real layer category is noise");
	});

	it("served wrapper leaves the page's data equal to the headless result", (t) => {
		const wrapper = servedWrapper();
		if (!wrapper) return t.skip("python3 is not available to emit the served rewrite");
		const sandbox = loadFilter();
		sandbox.__fixture = read("test/fixtures/codeflow-real-analysis-fp.json");
		sandbox.console = { info: () => {}, error: () => {} };
		const files = servedShape().files;
		sandbox.__files = JSON.stringify(files);
		vm.runInContext(
			"const data = JSON.parse(__fixture); data.files = JSON.parse(__files);",
			sandbox,
		);
		vm.runInContext(`${wrapper}\n;globalThis.__out = generateReport('json');`, sandbox, {
			filename: "served-wrapper.js",
		});
		const page = JSON_COPY(sandbox.__out);
		const headless = JSON_COPY(
			api.sanitizeAnalysisData(
				{ ...JSON.parse(sandbox.__fixture), files },
				api.readFileFrom({ files }),
			).data,
		);
		for (const key of [
			"securityIssues",
			"layerViolations",
			"deadFunctions",
			"duplicates",
			"stats",
		]) {
			assert.deepStrictEqual(page[key], headless[key], `${key} drifted between the load paths`);
		}
		assert.deepStrictEqual(
			sandbox.__codeflowFpFilterError,
			undefined,
			"the wrapper must not fail closed on a healthy page",
		);
	});
});

// ─── Phase 6: the register ledgers ─────────────────────────────────

describe("fp-filter module split #2100 — register ledgers", () => {
	const LONG_FILE = JSON.parse(read("test/fixtures/long-file-baseline.json"));
	const GOD_OBJECT = JSON.parse(read("test/fixtures/god-object-2034-baseline.json"));
	const VBA = JSON.parse(read("test/fixtures/vba-god-module-baseline-2036.json"));

	it("clears the flag in the live registers and records it in the historical one", () => {
		// The registers this change owns are cleared outright: no fp-filter file is
		// deferred anywhere in the VBA God Module or Long File ledgers.
		for (const rel of FAMILY) {
			for (const [name, fixture] of [
				["long-file-baseline.json", LONG_FILE],
				["vba-god-module-baseline-2036.json", VBA],
			] as const) {
				const deferred = (fixture.deferred ?? []).flatMap((entry: any) => entry.files ?? []);
				assert.equal(deferred.includes(rel), false, `${name} still defers ${rel}`);
			}
		}
		// The #2034 envelope is an immutable record of that issue's measurement: a
		// later split is written under `laterReduced` (exactly how #2035 recorded
		// `session_controls.rs`) instead of rewriting the arithmetic. Recorded is not
		// hidden — the file stops flagging live and the register names the issue.
		const godDeferred = (GOD_OBJECT.deferred ?? []).flatMap((entry: any) => entry.files ?? []);
		assert.ok(godDeferred.includes(INDEX_REL), "the historical deferral is kept as filed");
		assert.ok((GOD_OBJECT.laterReduced.files as string[]).includes(INDEX_REL));
		assert.match(GOD_OBJECT.laterReduced.reason, /#2100/);
		assert.deepStrictEqual(VBA.deferred, [], "no VBA flag is left to defer");
		assert.equal(VBA.after.vbaGodModuleCount, 0, "the family carries no VBA God Module flag");
	});

	it("records all eight modules as split siblings of the index", () => {
		const expected = MODULES.map((name) => `${CODEFLOW}/fp-filter/${name}.js`).sort();
		assert.deepStrictEqual([...VBA.splitFamilies[INDEX_REL]].sort(), expected);
		assert.ok(VBA.reducedBy.includes(INDEX_REL) === false, "the index is not a cited file");
		assert.deepStrictEqual(
			VBA.uncitedReduced.map((entry: { path: string }) => entry.path),
			[INDEX_REL],
			"the uncited leftover is recorded, not dropped",
		);
		assert.equal(VBA.uncitedReduced[0].issue, 2100);
		// The long-file register records the same split and every sibling fits.
		for (const rel of FAMILY) {
			assert.ok(LONG_FILE.reducedBy.includes(rel), `long-file-baseline.json must cite ${rel}`);
			assert.ok(lineCount(read(rel)) <= 500, `${rel} is still a long file`);
		}
		const longDeferred = (LONG_FILE.deferred ?? []).flatMap((entry: any) => entry.files ?? []);
		assert.equal(longDeferred.includes(INDEX_REL), false, "the served-asset deferral is retired");
	});

	it("re-anchors the recorded counts to the delivered tree", () => {
		const siblings = Object.values(VBA.splitFamilies as Record<string, string[]>).flat();
		assert.equal(siblings.length, 64, "sixty-four siblings across the twenty-three families");
		assert.equal(
			VBA.after.codeFiles,
			VBA.before.codeFiles +
				siblings.length +
				VBA.baseAdvance.scoredFilesAdded -
				VBA.removed.length,
			"the drop is a split, not a deletion",
		);
		assert.equal(
			VBA.before.vbaGodModuleCount,
			VBA.reducedBy.length +
				VBA.uncitedReduced.length +
				VBA.removed.length +
				VBA.baseAdvance.resolvedFiles.length,
			"every base flag is accounted for",
		);
		const laterReduced = GOD_OBJECT.laterReduced.files as string[];
		assert.ok(
			laterReduced.includes(INDEX_REL),
			"the older God Object envelope records the reduction",
		);
		assert.match(GOD_OBJECT.laterReduced.reason, /#2100/, "it names the issue that split it");
		assert.equal(LONG_FILE.after.longFileCount, 1, "only the Rust relay is still long");
	});

	it("measures no fp-filter file over either ceiling", () => {
		for (const rel of FAMILY) {
			assert.ok(CODE_EXTS.includes(`.${rel.split(".").pop()}`), `${rel} is scored`);
			assert.ok(declarations(rel) <= 20, `${rel} is a VBA God Module`);
			assert.ok(declarations(rel) <= 15, `${rel} is a God Object`);
			assert.equal(isFlagged(read(rel), rel), false, `${rel} is a long file`);
		}
		assert.ok(
			FAMILY.every((rel) => existsSync(resolve(ROOT, rel))),
			"the drop did not come from deleting a file",
		);
	});

	it("names the per-module oracle and the reference doc next to the fixtures", () => {
		for (const rel of [
			"test/fp-filter-module-split-2100.test.mts",
			".pi/skills/audit-codeflow-analysis/references/fp-filter-modules-2100.md",
		]) {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing register artifact: ${rel}`);
		}
	});

	it("re-anchors the two registers the split also moved", () => {
		// God Object / large files: the index left the flagged set and the family is
		// recorded, so the live residue is the Rust group plus the unfiled siblings.
		const large = JSON.parse(read("test/fixtures/large-files-2031-baseline.json"));
		assert.ok(large.reducedBy.includes(INDEX_REL), "large-files-baseline cites the index");
		const largeDeferred = (large.deferred ?? []).flatMap((entry: any) => entry.files ?? []);
		assert.equal(largeDeferred.includes(INDEX_REL), false, "the index is no longer a large file");
		assert.equal(Object.keys(large.fpFilterModules).length, 9, "the family is recorded");
		// That register records the raw-text `countFunctions` branch (the mirror its
		// own oracle applies), not the acorn-babel branch this issue is filed on; the
		// acorn counts are pinned by the family conservation test above.
		for (const [rel, n] of Object.entries(large.fpFilterModules as Record<string, number>)) {
			assert.equal(
				countFunctions(read(rel), "js"),
				n,
				`${rel} drifted from the recorded raw-text count`,
			);
			assert.ok(declarations(rel) <= 15, `${rel} is over the acorn-babel God Object ceiling`);
		}
		// Complexity: the file stays a critical-complexity path (the family is still
		// above 30), so the register keeps the entry and re-anchors its score.
		const complexity = JSON.parse(read("test/fixtures/complexity-baseline-2107.json"));
		const cited = complexity.cited.find((entry: any) => entry.path === INDEX_REL);
		assert.ok(cited, "the complexity register cites the index");
		assert.ok(cited.after < cited.before, "the split lowered the recorded score");
		assert.equal(calcComplexity(read(INDEX_REL)).score, cited.after, "the recorded score drifted");
		assert.match(complexity.deferred[INDEX_REL].reason, /#2100/, "the deferral names the split");
	});

	it("records the new critical-complexity paths instead of hiding them", () => {
		// The two metrics pull against each other: `VBA God Module` counts
		// declarations per file, so clearing it adds scored files, and the
		// complexity metric sums RAW-text branch tokens, so the family always sums
		// higher than the one file it replaced. The split must therefore be booked
		// in the #2033 envelope — one path at a time, never as a silent regression.
		const envelope2033 = JSON.parse(read("test/fixtures/complexity-baseline-2033.json"));
		for (const rel of FAMILY) {
			const entry = envelope2033.deferred[rel];
			assert.ok(entry, `${rel} is a measured critical path but not deferred in #2033`);
			assert.ok(entry.reason.length > 0, `${rel} states no reason`);
			assert.ok(entry.requires.length > 0, `${rel} states no requires pointer`);
			assert.ok(
				calcComplexity(read(rel)).score > 30,
				`${rel} sank under the ceiling — drop the stale #2033 deferral`,
			);
		}
		assert.equal(
			envelope2033.after.criticalCount,
			Object.keys(envelope2033.deferred).length,
			"the #2033 after count is the deferral list",
		);
		assert.equal(
			envelope2033.after.criticalCount,
			envelope2033.before.criticalCount - envelope2033.after.expectedDrop,
			"#2033 after must still be before minus the recorded drop",
		);
		assert.ok(
			envelope2033.after.criticalCount < envelope2033.before.criticalCount,
			"the ratchet still falls",
		);
		assert.ok(
			envelope2033.after.criticalCount <= envelope2033.filedBaseline.criticalCount,
			"never above the filed baseline",
		);
		// #2107 replays the same tree-wide count; the two registers may not drift.
		const complexity2107 = JSON.parse(read("test/fixtures/complexity-baseline-2107.json"));
		assert.equal(
			complexity2107.controls.criticalCount,
			envelope2033.after.criticalCount,
			"#2107 controls.criticalCount drifted from the #2033 envelope",
		);
	});
});
