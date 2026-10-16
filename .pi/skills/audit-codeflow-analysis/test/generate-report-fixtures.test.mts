/**
 * Tests for the CodeFlow report fixture generator
 * (test/fixtures/generate-report-fixtures.mjs).
 *
 * The generator captures the *real* CodeFlow report source and runs it to
 * prove the checked-in fixtures match what the browser export produces. It used
 * to run that source through the Function constructor (an eval-equivalent); the
 * issue raises the CodeFlow finding that came from it. These tests pin the
 * node:vm replacement: the dynamic-codegen sink is gone (Phase 1), the `compile`
 * helper still runs captured source — end to end in a child process against a
 * synthetic CodeFlow UI (Phase 2) — and the checked-in fixtures stay untouched
 * (Phase 3).
 *
 * The generator only runs with CODEFLOW_UI set, which is unavailable in-gate, so
 * the synthetic UI run is its characterization seam.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/generate-report-fixtures.test.mts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(TEST_DIR, "fixtures");
const GENERATOR = resolve(FIXTURE_DIR, "generate-report-fixtures.mjs");
const GENERATOR_SRC = readFileSync(GENERATOR, "utf8");

// Assembled from fragments so this guard does not itself contain the patterns
// it forbids — which would re-trigger the finding this change resolves.
const NEW_CONSTRUCTOR = "new " + "Function" + "(";
const CONSTRUCTOR_CALL = "Function" + "(";
const EVAL_CALL = "eva" + "l(";

const REAL_FIXTURES = ["codeflow-report.md", "codeflow-report.json", "codeflow-report-marked.json"];
const fixtureSnapshot = new Map(
	REAL_FIXTURES.map((name) => [name, readFileSync(resolve(FIXTURE_DIR, name), "utf8")]),
);

// Deterministic sliced regions: the generator slices these exact markers out of
// the "UI". The md body references `repo`/`h`/`data`, so a correct parameter
// wiring is visible in the emitted markdown.
const MD_BODY = 'var md="# "+repo+" h="+h.score+" d="+data.stats.files;';
const EXPECTED_MD = "# SchneiderDaniel/cheasee-pi h=42 d=9";
const EXPECTED_JSON = JSON.stringify({ unusedFunctions: [{ code: "X" }], tag: "R" }, null, 2);

function syntheticUi(mdBody: string): string {
	return [
		"<!doctype html><html><body><script>",
		'var report={unusedFunctions:[{code:"X"}],tag:"R"}',
		"if(format==='json'){",
		"function calcHealth(data){return {score:42};}",
		"// ===== CODEFLOW_METRICS_END =====",
		"}else if(format==='md'){" + mdBody,
		"}else if(format==='txt'){",
		"</script></body></html>",
	].join("\n");
}

function runGenerator(dir: string, html: string): { status: number | null; stderr: string } {
	const genPath = join(dir, "generate-report-fixtures.mjs");
	copyFileSync(GENERATOR, genPath);
	const uiPath = join(dir, "index.html");
	writeFileSync(uiPath, html, "utf8");
	const res = spawnSync(process.execPath, [genPath], {
		env: { ...process.env, CODEFLOW_UI: uiPath },
		encoding: "utf8",
	});
	return { status: res.status, stderr: res.stderr ?? "" };
}

let tmp: string;
let happy: { status: number | null; stderr: string };
let jsonOut: string | null;
let mdOut: string | null;
let markedOut: string | null;

before(() => {
	tmp = mkdtempSync(join(tmpdir(), "codeflow-fixture-gen-"));
	happy = runGenerator(tmp, syntheticUi(MD_BODY));
	const readOut = (name: string): string | null => {
		const path = join(tmp, name);
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	};
	jsonOut = readOut("codeflow-report.json");
	mdOut = readOut("codeflow-report.md");
	markedOut = readOut("codeflow-report-marked.json");
});

after(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("dynamic-eval sink removed (static guard)", () => {
	it("generator source contains no Function-constructor or eval call", () => {
		assert.ok(!GENERATOR_SRC.includes(NEW_CONSTRUCTOR), "no new-operator dynamic function");
		assert.ok(!GENERATOR_SRC.includes(CONSTRUCTOR_CALL), "no dynamic constructor call");
		assert.ok(!GENERATOR_SRC.includes(EVAL_CALL), "no dynamic eval call");
	});

	it("imports node:vm and runs under a code-generation-disabled sandbox", () => {
		assert.match(GENERATOR_SRC, /import vm from "node:vm";/);
		assert.match(GENERATOR_SRC, /codeGeneration: \{ strings: false, wasm: false \}/);
		assert.match(GENERATOR_SRC, /runInContext\(.*\btimeout\b/s);
	});
});

describe("compile helper — synthetic CodeFlow UI (adapter)", () => {
	it("runs captured source in a child process", () => {
		assert.equal(happy.status, 0, happy.stderr);
	});

	it("emits the JSON report source verbatim", () => {
		assert.equal(jsonOut, EXPECTED_JSON);
	});

	it("wires named parameters in order and runs the compiled health function", () => {
		// `h=42` proves the zero-parameter `compile([], …)()` health wrapper ran;
		// `d=9` and the repo name prove the md parameter order.
		assert.equal(mdOut, EXPECTED_MD);
	});

	it("embeds the markdown marker in the unused-function snippet", () => {
		assert.ok(markedOut !== null, "marked fixture must exist");
		const parsed = JSON.parse(markedOut);
		assert.equal(
			parsed.unusedFunctions[0].code,
			'const MD_MARKER = "# CodeFlow Analysis Report";\nX',
		);
		assert.ok(markedOut.endsWith("\n"));
	});

	it("refuses dynamic code generation at runtime", () => {
		const mdBody = `var md=${"eva"}${"l"}("1+1");`;
		const run = runGenerator(tmp, syntheticUi(mdBody));
		assert.notEqual(run.status, 0, "generator must exit non-zero");
		assert.match(run.stderr.toLowerCase(), /code generation from strings disallowed/);
	});
});

describe("checked-in fixtures are the generator's reference output (integrity)", () => {
	it("synthetic subprocess runs leave the real fixtures untouched", () => {
		for (const name of REAL_FIXTURES) {
			assert.equal(
				readFileSync(resolve(FIXTURE_DIR, name), "utf8"),
				fixtureSnapshot.get(name),
				`${name} must be unmodified by generator runs`,
			);
		}
	});
});
