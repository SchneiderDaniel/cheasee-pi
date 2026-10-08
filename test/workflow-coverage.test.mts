/**
 * Workflow coverage guard — every test file under .pi/extensions/, test/ and
 * docker/test/ must execute in CI (directly or via `npm test`), so no test can
 * silently escape the pipeline (issue #1519, AC #1/#3; scope widened in #1859).
 *
 * Coverage model:
 *   - A node test (.mts/.ts) is "covered" when the package.json test globs
 *     register it (see test/lib/test-discovery.mts) while a workflow runs
 *     `npm test`, or when a workflow `run:` string names it directly.
 *   - .sh/.py files must be named by a workflow `run:` string.
 *   - Each file must also be invoked with the matching runner:
 *     .sh → `bash`, .py → `python3`,
 *     .mts/.ts → `node --experimental-strip-types --test`.
 *
 * Static analysis only — no test execution.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, extname, relative, basename } from "node:path";
import { load } from "js-yaml";

import {
	isGlobBased,
	isRegistered,
	parseTokens,
	testGlobs,
	testScript,
} from "./lib/test-discovery.mts";

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

interface WorkflowConfig {
	jobs?: Record<
		string,
		{ steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }> }
	>;
}

function workflowFiles(): string[] {
	return readdirSync(WORKFLOWS_DIR)
		.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
		.map((f) => join(WORKFLOWS_DIR, f));
}

function allRunStrings(): string[] {
	const runs: string[] = [];
	for (const path of workflowFiles()) {
		const wf = load(readFileSync(path, "utf-8")) as WorkflowConfig;
		for (const job of Object.values(wf.jobs ?? {})) {
			for (const step of job.steps ?? []) {
				if (typeof step.run === "string") runs.push(step.run);
			}
		}
	}
	return runs;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "fixtures" || entry.name === "node_modules") continue;
			walk(full, out);
		} else out.push(full);
	}
	return out;
}

const TEST_FILE_RE = /\.test\.(mts|ts|sh|py)$/;

/** Repo-relative paths of every test file in scope (fixtures excluded). */
function testFilePaths(): string[] {
	const dirs = [join(ROOT, ".pi", "extensions"), join(ROOT, "test"), join(ROOT, "docker", "test")];
	const files: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const full of walk(dir)) {
			if (TEST_FILE_RE.test(full)) files.push(relative(ROOT, full));
		}
	}
	return [...new Set(files)];
}

const runs = allRunStrings();
const npmTestRunsInWorkflow = runs.some((r) => /\bnpm test\b/.test(r));

/** True when the file is registered by the npm test globs (or named by a workflow). */
function isCovered(relPath: string): boolean {
	if (npmTestRunsInWorkflow && isRegistered(relPath)) return true;
	const base = basename(relPath);
	return runs.some((text) => text.includes(base));
}

/** True when the file is invoked with the given runner (glob-registered node tests count). */
function invokedWithForm(relPath: string, runner: string): boolean {
	if (
		npmTestRunsInWorkflow &&
		runner === "node --experimental-strip-types --test" &&
		isRegistered(relPath)
	) {
		return true;
	}
	const base = basename(relPath);
	return runs.some((text) => text.includes(base) && text.includes(runner));
}

describe("workflow coverage — no orphan tests", () => {
	it("npm test runs in a workflow (so glob-registered files count)", () => {
		assert.ok(npmTestRunsInWorkflow, "no workflow runs `npm test`");
	});

	it("the test script is glob-based (a literal roster cannot return)", () => {
		assert.ok(isGlobBased(testScript()), "package.json scripts.test must register via globs");
		assert.ok(
			testGlobs().every((t) => t.includes("*")),
			"every registered token must be a glob",
		);
	});

	it("the no-literal-roster assertion rejects a simulated literal script (TDD gate)", () => {
		const literal = "node --experimental-strip-types --test test/a.test.mts test/b.test.mts";
		assert.strictEqual(isGlobBased(literal), false, "a literal roster must not read as glob-based");
		assert.strictEqual(parseTokens(literal).length, 0, "a literal roster yields no glob tokens");
	});

	it("every test file in scope is covered by a workflow run or the npm test globs", () => {
		const orphans = testFilePaths().filter((rel) => !isCovered(rel));
		assert.deepStrictEqual(orphans, [], `uncovered test files: ${orphans.join(", ")}`);
	});

	it("covers every previously-uncovered standalone file", () => {
		const expected = [
			"test/docs-installation.test.mts",
			"test/dogfooding-dedup.test.sh",
			"test/git-issue-create-external-skill.test.mts",
			"test/goreleaser-config.test.mts",
			"test/no-submodules.test.sh",
			"test/release-workflow.test.mts",
			"test/voice-for-writing.test.mts",
			"docker/test/unbreak-worktrees.test.mts",
		];
		for (const rel of expected) {
			assert.ok(isCovered(rel), `${rel} is not covered by any workflow`);
		}
	});

	it("covers repo-hygiene-dead-artifacts.test.sh (issue's all-files-under-test/ scope)", () => {
		assert.ok(isCovered("test/repo-hygiene-dead-artifacts.test.sh"));
	});

	it("covers the meta-tests themselves (no orphan guard)", () => {
		assert.ok(isCovered("test/tests-workflow.test.mts"));
		assert.ok(isCovered("test/workflow-coverage.test.mts"));
	});

	it("invokes each test file with the matching runner", () => {
		for (const rel of testFilePaths()) {
			const ext = extname(rel);
			if (ext === ".sh") {
				assert.ok(invokedWithForm(rel, "bash"), `${rel} is not run via bash`);
			} else if (ext === ".py") {
				assert.ok(invokedWithForm(rel, "python3"), `${rel} is not run via python3`);
			} else {
				assert.ok(
					invokedWithForm(rel, "node --experimental-strip-types --test"),
					`${rel} is not run via node --experimental-strip-types --test`,
				);
			}
		}
	});

	it("runs the npm test suite and the Go package suite in tests.yml", () => {
		const testsYml = readFileSync(join(WORKFLOWS_DIR, "tests.yml"), "utf-8");
		assert.ok(/\bnpm test\b/.test(testsYml), "tests.yml must run npm test");
		assert.ok(
			testsYml.includes("go test ./cmd/cheasee-pi/ -count=1"),
			"tests.yml must run go test ./cmd/cheasee-pi/ -count=1",
		);
	});
});
