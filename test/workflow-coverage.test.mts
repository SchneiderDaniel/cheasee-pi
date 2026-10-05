/**
 * Workflow coverage guard — every test file under test/ and docker/test/ must
 * execute in CI (directly or via `npm test`), so no test can silently escape
 * the pipeline (issue #1519, AC #1/#3).
 *
 * Coverage model:
 *   - A file's basename is "covered" when it appears in a workflow `run:` string,
 *     or in package.json `scripts.test` while some workflow runs `npm test`.
 *   - Each extension must also be invoked with the matching runner:
 *     .sh → `bash`, .py → `python3`,
 *     .mts/.ts → `node --experimental-strip-types --test`.
 *
 * Static analysis only — no test execution.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { load } from "js-yaml";

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
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

const TEST_EXTENSIONS = new Set([".mts", ".ts", ".sh", ".py"]);

/** Basenames of every test file under test/ and docker/test/ (fixtures excluded). */
function testFileBasenames(): string[] {
	const dirs = [join(ROOT, "test"), join(ROOT, "docker", "test")];
	const files: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const full of walk(dir)) {
			if (full.includes(`${join("test", "fixtures")}`)) continue;
			if (TEST_EXTENSIONS.has(extname(full))) files.push(full);
		}
	}
	return [...new Set(files.map((f) => f.split("/").pop() as string))];
}

const runs = allRunStrings();
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
	scripts?: Record<string, string>;
};
const npmTestScript = packageJson.scripts?.test ?? "";
const npmTestRunsInWorkflow = runs.some((r) => /\bnpm test\b/.test(r));
const coveredTexts = npmTestRunsInWorkflow ? [...runs, npmTestScript] : runs;

function isCovered(basename: string): boolean {
	return coveredTexts.some((text) => text.includes(basename));
}

function invokedWithForm(basename: string, runner: string): boolean {
	return coveredTexts.some((text) => text.includes(basename) && text.includes(runner));
}

describe("workflow coverage — no orphan tests", () => {
	it("npm test runs in a workflow (so package.json-covered files count)", () => {
		assert.ok(npmTestRunsInWorkflow, "no workflow runs `npm test`");
	});

	it("every test/ and docker/test/ file is referenced by a workflow run or npm test", () => {
		const orphans = testFileBasenames().filter((name) => !isCovered(name));
		assert.deepStrictEqual(orphans, [], `uncovered test files: ${orphans.join(", ")}`);
	});

	it("covers every previously-uncovered standalone file", () => {
		const expected = [
			"docs-installation.test.mts",
			"dogfooding-dedup.test.sh",
			"external-issue-skill.test.mts",
			"goreleaser-config.test.mts",
			"no-submodules.test.sh",
			"release-workflow.test.mts",
			"writing-voice.test.mts",
			"unbreak-worktrees.test.mts",
		];
		for (const name of expected) {
			assert.ok(isCovered(name), `${name} is not referenced by any workflow`);
		}
	});

	it("covers repo-hygiene-dead-artifacts.test.sh (issue's all-files-under-test/ scope)", () => {
		assert.ok(isCovered("repo-hygiene-dead-artifacts.test.sh"));
	});

	it("covers the meta-tests themselves (no orphan guard)", () => {
		assert.ok(isCovered("tests-workflow.test.mts"));
		assert.ok(isCovered("workflow-coverage.test.mts"));
	});

	it("invokes each extension with the matching runner", () => {
		for (const name of testFileBasenames()) {
			const ext = extname(name);
			if (ext === ".sh") {
				assert.ok(invokedWithForm(name, "bash"), `${name} is not run via bash`);
			} else if (ext === ".py") {
				assert.ok(invokedWithForm(name, "python3"), `${name} is not run via python3`);
			} else {
				assert.ok(
					invokedWithForm(name, "node --experimental-strip-types --test"),
					`${name} is not run via node --experimental-strip-types --test`,
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
