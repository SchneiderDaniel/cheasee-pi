/**
 * Tests for .pi/skills/audit-codeflow-analysis/lib/fast-path.ts (deterministic
 * known-false-positive pre-filter) and its CLI adapter
 * scripts/fast-path.mts (finding-file parsing, rg/ast-grep evidence, exit
 * protocol).
 *
 * The rule engine is exercised against a *faked* `RepoPort`, so every rule is
 * pinned on its mechanism alone — no real repository is read. The adapter is
 * spawned as a subprocess against a temp mini-repo with PATH stubs for `rg` and
 * `ast-grep`, so the exit protocol (1 INVALID / 10 defer / 2 usage) is real.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/fast-path.test.mts
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { FAST_PATH_RULES, evaluateFastPath, type RepoPort } from "../lib/fast-path.ts";
import type { IssueFact } from "../lib/report.ts";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "fast-path.mts");

/** A finding with the fields the rules key on; overridden per case. */
function fact(over: Partial<IssueFact> = {}): IssueFact {
	return {
		id: "dead-code:0",
		kind: "dead-code",
		title: "unused_helper()",
		targets: [{ kind: "file", path: "src/a.ts" }],
		files: ["src/a.ts"],
		...over,
	};
}

/** A `RepoPort` that knows nothing; each case supplies only its own evidence. */
function port(over: Partial<RepoPort> = {}): RepoPort {
	return {
		readFile: () => null,
		findDeclarations: () => [],
		grep: () => [],
		...over,
	};
}

function decl(
	over: Partial<{
		file: string;
		line: number;
		owner: string | null;
		hasBody: boolean;
		ambient: boolean;
	}> = {},
) {
	return { file: "src/a.ts", line: 1, owner: null, hasBody: true, ambient: false, ...over };
}

const SAFE_CALL = `import { spawn } from "node:child_process";\nspawn("git", ["status"]);\n`;
const SHELL_STRING_CALL = `import { spawn } from "node:child_process";\nspawn("git status", { stdio: "inherit" });\n`;

describe("fast-path row 5 — command execution with an argv array and no shell", () => {
	const finding = fact({
		kind: "security",
		title: "MEDIUM: Command Execution",
		targets: [{ kind: "file", path: "src/run.ts" }],
		files: ["src/run.ts"],
	});
	const twoFiles = fact({
		kind: "security",
		title: "MEDIUM: Command Execution",
		targets: [
			{ kind: "file", path: "src/run.ts" },
			{ kind: "file", path: "src/exec.ts" },
		],
		files: ["src/run.ts", "src/exec.ts"],
	});

	it("fires when the cited file's only call is argv-array with no shell: true", async () => {
		const v = await evaluateFastPath(finding, port({ readFile: () => SAFE_CALL }));
		assert.ok(v, "expected INVALID");
		assert.strictEqual(v.verdict, "INVALID");
		assert.strictEqual(v.row, 5);
		assert.strictEqual(v.ruleId, "argv-array-no-shell");
	});

	it("defers when a call passes a shell string instead of an argv array", async () => {
		assert.strictEqual(
			await evaluateFastPath(finding, port({ readFile: () => SHELL_STRING_CALL })),
			null,
		);
	});

	it("defers on shell: true", async () => {
		const text = `spawn("git", ["status"], { shell: true });\n`;
		assert.strictEqual(await evaluateFastPath(finding, port({ readFile: () => text })), null);
	});

	it("defers on a mixed file (one argv call, one shell call)", async () => {
		const text = `${SAFE_CALL}exec("echo hi", { shell: true });\n`;
		assert.strictEqual(await evaluateFastPath(finding, port({ readFile: () => text })), null);
	});

	it("defers when the cited file contains no spawn/execFile call at all", async () => {
		assert.strictEqual(
			await evaluateFastPath(finding, port({ readFile: () => "export const value = 1;\n" })),
			null,
		);
	});

	it("defers when the cited file cannot be read", async () => {
		assert.strictEqual(await evaluateFastPath(finding, port({ readFile: () => null })), null);
	});

	it("fires when two cited files are both all-argv", async () => {
		const v = await evaluateFastPath(twoFiles, port({ readFile: () => SAFE_CALL }));
		assert.strictEqual(v?.row, 5);
	});

	it("defers when one of two cited files has an unsafe call", async () => {
		const v = await evaluateFastPath(
			twoFiles,
			port({ readFile: (p) => (p === "src/exec.ts" ? SHELL_STRING_CALL : SAFE_CALL) }),
		);
		assert.strictEqual(v, null);
	});
});

describe("fast-path row 11 — ambient/type-only declaration", () => {
	it("fires on a bodyless member of a declare module", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({ findDeclarations: () => [decl({ hasBody: false, ambient: true })] }),
		);
		assert.strictEqual(v?.row, 11);
		assert.strictEqual(v?.ruleId, "ambient-type-only-member");
	});

	it("fires on a bodyless member of declare global", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: () => [decl({ file: "src/global.d.ts", hasBody: false, ambient: true })],
			}),
		);
		assert.strictEqual(v?.row, 11);
	});

	it("fires on a bodyless function in a declaration file", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: () => [decl({ file: "src/types.d.ts", hasBody: false, ambient: true })],
			}),
		);
		assert.strictEqual(v?.row, 11);
	});

	it("defers when the declaration has a body", async () => {
		const v = await evaluateFastPath(fact(), port({ findDeclarations: () => [decl({ hasBody: true })] }));
		assert.strictEqual(v, null);
	});

	it("defers on an ambient member that carries a body", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({ findDeclarations: () => [decl({ hasBody: true, ambient: true })] }),
		);
		assert.strictEqual(v, null);
	});

	it("defers when no declaration was found", async () => {
		assert.strictEqual(await evaluateFastPath(fact(), port()), null);
	});
});

describe("fast-path row 10 — phantom symbol", () => {
	it("fires on a builtin type token used as a name", async () => {
		const v = await evaluateFastPath(
			fact({ title: "string()" }),
			port({ findDeclarations: () => [decl({ hasBody: false })] }),
		);
		assert.strictEqual(v?.row, 10);
		assert.strictEqual(v?.ruleId, "phantom-symbol");
	});

	it("fires when every occurrence sits in a comment", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				grep: () => [
					{ file: "src/a.ts", line: 3, text: "// unused_helper is invented from a def-shaped comment" },
					{ file: "src/a.ts", line: 9, text: "/* unused_helper: no body anywhere */" },
				],
			}),
		);
		assert.strictEqual(v?.row, 10);
	});

	it("fires when every occurrence sits inside a string literal", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				grep: () => [
					{ file: "src/a.ts", line: 4, text: 'const doc = "unused_helper";' },
					{ file: "src/b.ts", line: 1, text: "fixture.push('unused_helper');" },
				],
			}),
		);
		assert.strictEqual(v?.row, 10);
	});

	it("defers when a real declaration with a body exists", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: () => [decl({ hasBody: true })],
				grep: () => [{ file: "src/a.ts", line: 1, text: "function unused_helper() {" }],
			}),
		);
		assert.strictEqual(v, null);
	});

	it("defers when the symbol is absent from the whole repo", async () => {
		assert.strictEqual(await evaluateFastPath(fact(), port()), null);
	});

	it("defers when a real occurrence exists but no body-bearing declaration does", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({ grep: () => [{ file: "src/a.ts", line: 7, text: "const x = unused_helper;" }] }),
		);
		assert.strictEqual(v, null);
	});
});

describe("fast-path row 8 — declaration reached indirectly", () => {
	it("fires when the symbol is passed as a value", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: () => [decl({ line: 12 })],
				grep: () => [
					{ file: "src/b.ts", line: 4, text: "const handlers = { unused_helper };" },
					{ file: "src/a.ts", line: 12, text: "export function unused_helper() {" },
				],
			}),
		);
		assert.strictEqual(v?.row, 8);
		assert.strictEqual(v?.ruleId, "indirect-dispatch");
	});

	it("fires when the symbol is reached through a dispatch seam", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: () => [decl({ file: "src/handler.rs", line: 20, owner: "Worker" })],
				grep: () => [
					{ file: "src/handler.rs", line: 20, text: "fn unused_helper(&self) {" },
					{ file: "src/wire.rs", line: 8, text: "dispatcher.register(unused_helper);" },
				],
			}),
		);
		assert.strictEqual(v?.row, 8);
	});

	it("defers when the symbol only appears in its own declaration", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: () => [decl({ line: 12 })],
				grep: () => [{ file: "src/a.ts", line: 12, text: "export function unused_helper() {" }],
			}),
		);
		assert.strictEqual(v, null);
	});

	it("defers when the only other reference is a direct call", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: () => [decl({ line: 12 })],
				grep: () => [
					{ file: "src/a.ts", line: 12, text: "export function unused_helper() {" },
					{ file: "src/b.ts", line: 4, text: "unused_helper();" },
				],
			}),
		);
		assert.strictEqual(v, null);
	});
});

describe("fast-path — duplicate same-name across distinct types", () => {
	const dup = fact({
		kind: "duplicate",
		title: "Same Name: render",
		targets: [{ kind: "file", path: "src/a.ts" }],
		files: ["src/a.ts"],
	});

	it("fires when two distinct enclosing types declare the name", async () => {
		const v = await evaluateFastPath(
			dup,
			port({
				findDeclarations: () => [
					decl({ owner: "TextRenderer" }),
					decl({ owner: "CanvasRenderer", line: 42 }),
				],
			}),
		);
		assert.strictEqual(v?.row, 14);
		assert.strictEqual(v?.ruleId, "duplicate-same-name");
	});

	it("defers when only one enclosing type declares it", async () => {
		const v = await evaluateFastPath(dup, port({ findDeclarations: () => [decl({ owner: "TextRenderer" })] }));
		assert.strictEqual(v, null);
	});

	it("defers when the enclosing type cannot be attributed", async () => {
		const v = await evaluateFastPath(
			dup,
			port({ findDeclarations: () => [decl({ owner: null }), decl({ owner: null, line: 9 })] }),
		);
		assert.strictEqual(v, null);
	});
});

describe("fast-path — similar-code cluster", () => {
	const cluster = fact({
		kind: "duplicate",
		title: "Similar Code: parseRow",
		targets: [{ kind: "file", path: "src/a.ts" }],
		files: ["src/a.ts", "src/b.ts"],
	});

	it("defers when all members are one language family and not test fixtures", async () => {
		assert.strictEqual(await evaluateFastPath(cluster, port()), null);
	});

	it("fires when the members span distinct language families", async () => {
		const v = await evaluateFastPath({ ...cluster, files: ["src/a.ts", "src/b.py"] }, port());
		assert.strictEqual(v?.row, 15);
		assert.strictEqual(v?.ruleId, "similar-code-cross-family");
	});

	it("fires when every member is a test-fixture path", async () => {
		const v = await evaluateFastPath(
			{ ...cluster, files: ["test/fixtures/a.ts", "test/fixtures/b.ts"] },
			port(),
		);
		assert.strictEqual(v?.row, 15);
	});
});

describe("fast-path — suggestion and zero-file derived facts", () => {
	it("fires on a suggestion", async () => {
		const v = await evaluateFastPath(
			fact({ kind: "suggestion", title: "extract shared helper", targets: [], files: [] }),
			port(),
		);
		assert.strictEqual(v?.row, 12);
		assert.strictEqual(v?.ruleId, "suggestion-derived-fact");
	});

	it("fires on any fact with no target and no cited file", async () => {
		const v = await evaluateFastPath(
			fact({ kind: "architecture", title: "8 Highly Coupled", targets: [], files: [] }),
			port(),
		);
		assert.strictEqual(v?.row, 13);
		assert.strictEqual(v?.ruleId, "zero-file-derived-fact");
	});

	it("defers on a non-suggestion fact with a locatable symbol target", async () => {
		const v = await evaluateFastPath(
			fact({
				kind: "architecture",
				title: "8 Highly Coupled",
				targets: [{ kind: "symbol", name: "execFn" }],
				files: [],
			}),
			port(),
		);
		assert.strictEqual(v, null);
	});
});

describe("fast-path — decision contract", () => {
	it("resolves null when the port rejects on readFile", async () => {
		const v = await evaluateFastPath(
			fact({ kind: "security", title: "MEDIUM: Command Execution" }),
			port({
				readFile: async () => {
					throw new Error("rg exploded");
				},
			}),
		);
		assert.strictEqual(v, null);
	});

	it("resolves null when the port rejects on findDeclarations", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				findDeclarations: async () => {
					throw new Error("ast-grep exploded");
				},
			}),
		);
		assert.strictEqual(v, null);
	});

	it("resolves null when the port rejects on grep", async () => {
		const v = await evaluateFastPath(
			fact(),
			port({
				grep: async () => {
					throw new Error("rg exploded");
				},
			}),
		);
		assert.strictEqual(v, null);
	});

	it("reports a port failure through the warn hook instead of swallowing it", async () => {
		const seen: string[] = [];
		await evaluateFastPath(
			fact(),
			port({
				findDeclarations: async () => {
					throw new Error("ast-grep exploded");
				},
			}),
			(err) => seen.push(String(err)),
		);
		assert.strictEqual(seen.length, 1);
		assert.match(seen[0] ?? "", /ast-grep exploded/);
	});

	it("defers on an unknown kind or an unrecognized title", async () => {
		assert.strictEqual(await evaluateFastPath(fact({ kind: "pattern", title: "Factory" }), port()), null);
		assert.strictEqual(
			await evaluateFastPath(fact({ kind: "dead-code", title: "no symbol here" }), port()),
			null,
		);
	});

	it("is deterministic and sorts evidence regardless of port enumeration order", async () => {
		const matches = [
			{ file: "src/a.ts", line: 2, text: "const x = { unused_helper };" },
			{ file: "src/a.ts", line: 12, text: "export function unused_helper() {" },
			{ file: "src/z.ts", line: 4, text: "wire(unused_helper);" },
		];
		const a = await evaluateFastPath(
			fact(),
			port({ findDeclarations: () => [decl({ line: 12 })], grep: () => matches }),
		);
		const b = await evaluateFastPath(
			fact(),
			port({ findDeclarations: () => [decl({ line: 12 })], grep: () => [...matches].reverse() }),
		);
		assert.deepStrictEqual(a, b);
		assert.strictEqual(a?.evidence, "src/a.ts:2 — const x = { unused_helper };");
	});

	it("every non-null verdict is INVALID with a complete verdict record", async () => {
		const cases: Array<[IssueFact, RepoPort]> = [
			[fact({ kind: "suggestion", title: "s", targets: [], files: [] }), port()],
			[
				fact({ kind: "security", title: "MEDIUM: Command Execution" }),
				port({ readFile: () => SAFE_CALL }),
			],
			[fact(), port({ findDeclarations: () => [decl({ hasBody: false, ambient: true })] })],
			[
				fact(),
				port({
					findDeclarations: () => [decl({ hasBody: false })],
					grep: () => [{ file: "src/a.ts", line: 2, text: "// unused_helper (comment ink)" }],
				}),
			],
			[
				fact({ kind: "duplicate", title: "Same Name: render" }),
				port({ findDeclarations: () => [decl({ owner: "A" }), decl({ owner: "B", line: 3 })] }),
			],
			[fact({ kind: "duplicate", title: "Similar Code: x", files: ["src/a.ts", "src/b.py"] }), port()],
		];
		for (const [finding, repo] of cases) {
			const v = await evaluateFastPath(finding, repo);
			assert.ok(v, `expected an INVALID verdict for ${finding.title}`);
			assert.strictEqual(v.verdict, "INVALID");
			assert.ok(v.ruleId.length > 0, "ruleId must be non-empty");
			assert.ok(Number.isInteger(v.row), "row must be an integer");
			assert.ok(v.reason.length > 0, "reason must be non-empty");
			assert.ok(v.evidence.length > 0, "evidence must be non-empty");
		}
	});

	it("declares no rule that overlaps the classifyKnownNoise shapes (rows 6/7/9)", () => {
		const rows = FAST_PATH_RULES.map((r) => r.row);
		assert.ok(rows.length > 0, "the rule catalogue must not be empty");
		for (const noiseRow of [6, 7, 9]) {
			assert.ok(
				!rows.includes(noiseRow),
				`row ${noiseRow} belongs to classifyKnownNoise, not the fast path`,
			);
		}
		assert.strictEqual(new Set(FAST_PATH_RULES.map((r) => r.ruleId)).size, FAST_PATH_RULES.length);
	});
});

// ─── CLI adapter (exit protocol) ──────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "fast-path-cli-"));
after(() => {
	spawnSync("rm", ["-rf", TMP]);
});

const REPO = join(TMP, "repo");
mkdirSync(join(REPO, "src"), { recursive: true });
writeFileSync(join(REPO, "src/a.ts"), 'declare module "x" {\n  function ambient_member(): void;\n}\n');

/** PATH with only `node`: the adapter must fail open when its tools are absent. */
const NODE_ONLY = join(TMP, "node-only");
mkdirSync(NODE_ONLY, { recursive: true });
symlinkSync(process.execPath, join(NODE_ONLY, "node"));

/** Stub tools: `rg` answers the adapter's probes, `ast-grep` reports one decl. */
const STUB_BIN = join(TMP, "stub-bin");
mkdirSync(STUB_BIN, { recursive: true });
writeFileSync(
	join(STUB_BIN, "rg"),
	[
		"#!/usr/bin/env node",
		'const args = process.argv.slice(2);',
		'if (args.includes("--files-with-matches")) process.stdout.write("src/a.ts\\n");',
		'else process.stdout.write("src/a.ts:2:  function ambient_member(): void;\\n");',
		"",
	].join("\n"),
);
writeFileSync(
	join(STUB_BIN, "ast-grep"),
	[
		"#!/usr/bin/env node",
		'process.stdout.write(JSON.stringify({text: "function ambient_member(): void;", range: {start: {line: 1}}, file: "src/a.ts"}) + "\\n");',
		"",
	].join("\n"),
);
chmodSync(join(STUB_BIN, "rg"), 0o755);
chmodSync(join(STUB_BIN, "ast-grep"), 0o755);

function writeFinding(name: string, fields: Record<string, string>): string {
	const file = join(TMP, name);
	writeFileSync(
		file,
		[
			`# CodeFlow finding (${fields.Kind ?? "dead-code"})`,
			"",
			`**Kind:** ${fields.Kind ?? "dead-code"}`,
			"**Issue type:** bug",
			"**Disposition:** file-bug",
			`**Title:** ${fields.Title ?? "ambient_member()"}`,
			`**Id:** ${fields.Id ?? "dead-code:0"}`,
			`**Targets:** ${fields.Targets ?? "`src/a.ts`"}`,
			`**Files:** ${fields.Files ?? "src/a.ts"}`,
			"",
		].join("\n"),
	);
	return file;
}

function runCli(args: string[], path = `${STUB_BIN}:${process.env.PATH ?? ""}`) {
	const res = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
		encoding: "utf-8",
		env: { ...process.env, PATH: path },
	});
	return { code: res.status ?? -1, out: res.stdout ?? "", err: res.stderr ?? "" };
}

describe("fast-path CLI adapter", () => {
	const ambientFinding = writeFinding("row11.md", {});
	const deferFinding = writeFinding("defer.md", {
		Kind: "security",
		Title: "HIGH: Hardcoded Secret",
		Id: "security:0",
	});

	it("prints the verdict block and exits 1 for a fast-path INVALID", () => {
		const res = runCli([ambientFinding, REPO]);
		assert.strictEqual(res.code, 1, `expected exit 1, got ${res.code}: ${res.err}`);
		assert.match(res.out, /^VERDICT: INVALID$/m);
		assert.match(res.out, /^REASON: .+$/m);
		assert.match(res.out, /^EVIDENCE: .+$/m);
		assert.match(res.out, /^RULE: ambient-type-only-member \(known-fp row 11\)$/m);
		assert.doesNotMatch(res.out, /VERDICT: VALID/);
	});

	it("prints nothing and exits 10 for a deferred finding", () => {
		const res = runCli([deferFinding, REPO]);
		assert.strictEqual(res.code, 10, `expected exit 10, got ${res.code}`);
		assert.strictEqual(res.out, "");
	});

	it("exits 2 on a missing finding file, no argument, and a bad repo root", () => {
		for (const args of [
			[join(TMP, "nope.md"), REPO],
			[],
			[ambientFinding, join(TMP, "not-a-repo-path")],
		]) {
			const res = runCli(args);
			assert.strictEqual(res.code, 2, `expected exit 2 for ${JSON.stringify(args)}`);
			assert.strictEqual(res.out, "");
		}
	});

	it("exits 10 without crashing when rg is absent", () => {
		const res = runCli([ambientFinding, REPO], NODE_ONLY);
		assert.strictEqual(res.code, 10, `expected defer, got ${res.code}: ${res.err}`);
		assert.strictEqual(res.out, "");
		assert.match(res.err, /defer/, "the deferral must be disclosed on stderr");
	});

	it("exits 10 without crashing when ast-grep is absent", () => {
		const noSg = join(TMP, "no-sg-bin");
		mkdirSync(noSg, { recursive: true });
		symlinkSync(join(STUB_BIN, "rg"), join(noSg, "rg"));
		const res = runCli([ambientFinding, REPO], `${noSg}:${NODE_ONLY}`);
		assert.strictEqual(res.code, 10, `expected defer, got ${res.code}: ${res.err}`);
		assert.strictEqual(res.out, "");
	});

	it("routes a finding with no cited file and a symbol target without crashing", () => {
		const file = writeFinding("nofile.md", {
			Kind: "architecture",
			Title: "8 Highly Coupled",
			Targets: "`execFn`",
			Files: "(none)",
		});
		const res = runCli([file, REPO]);
		assert.strictEqual(res.code, 10, `expected defer, got ${res.code}: ${res.err}`);
		assert.strictEqual(res.out, "");
	});

	it("exits 10 for an unparsable finding file", () => {
		const file = join(TMP, "garbage.md");
		writeFileSync(file, "not a finding\n");
		const res = runCli([file, REPO]);
		assert.strictEqual(res.code, 10);
		assert.strictEqual(res.out, "");
	});

	it("never prints VERDICT: VALID and renders stable output across runs", () => {
		const file = writeFinding("suggestion.md", {
			Kind: "suggestion",
			Title: "extract a shared helper",
			Id: "suggestion:0",
			Targets: "(no file — derived signal)",
			Files: "(none)",
		});
		const first = runCli([file, REPO]);
		const second = runCli([file, REPO]);
		assert.strictEqual(first.code, 1, `expected exit 1, got ${first.code}: ${first.err}`);
		assert.strictEqual(first.out, second.out);
		assert.doesNotMatch(first.out, /VERDICT: VALID/);
		assert.match(first.out, /RULE: suggestion-derived-fact \(known-fp row 12\)/);
	});
});

// ─── CLI adapter against the real toolchain ───────────────────────

const REAL_TOOLS =
	spawnSync("sh", ["-c", "command -v rg && command -v ast-grep"], { stdio: "ignore" }).status === 0;

describe("fast-path CLI adapter — real rg + ast-grep", () => {
	it(
		"resolves a bodyless ambient member that lives in a hidden directory",
		{ skip: REAL_TOOLS ? false : "rg/ast-grep are not on PATH; the pre-filter fails open without them" },
		() => {
			// Pins two adapter details that stubbed tools can hide: the checkout walk
			// must include dot-directories, and `rg` must be given an explicit path
			// (a pattern alone plus a non-tty stdin makes rg search stdin).
			const repo = join(TMP, "hidden-repo");
			mkdirSync(join(repo, ".hidden", "lib"), { recursive: true });
			writeFileSync(
				join(repo, ".hidden", "lib", "ambient.ts"),
				'declare module "third-party" {\n\tfunction only_declared(): void;\n}\n',
			);
			const finding = writeFinding("hidden.md", {
				Title: "only_declared()",
				Targets: "`.hidden/lib/ambient.ts`",
				Files: ".hidden/lib/ambient.ts",
			});
			const res = runCli([finding, repo], process.env.PATH ?? "");
			assert.strictEqual(res.code, 1, `expected exit 1, got ${res.code}: ${res.err}`);
			assert.match(res.out, /RULE: ambient-type-only-member \(known-fp row 11\)/);
			assert.match(res.out, /EVIDENCE: \.hidden\/lib\/ambient\.ts:\d+/);
		},
	);
});
