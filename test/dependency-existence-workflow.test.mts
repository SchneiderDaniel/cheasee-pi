/**
 * Validate .github/workflows/dependency-existence.yml workflow structure.
 *
 * Covers:
 *   - YAML parseable, header comment with budget
 *   - Triggers: pull_request branches [main], push branches [main],
 *     workflow_dispatch
 *   - permissions: contents: read; defaults.run.shell: bash; timeout-minutes
 *   - Job order: offline unit tests first, then the live check
 *   - Live job: invokes the stdlib checker with --root . --json, emits
 *     ::error:: per finding, uploads the JSON report on failure
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const WORKFLOW_PATH = resolve(
	import.meta.dirname,
	"..",
	".github",
	"workflows",
	"dependency-existence.yml"
);

interface WorkflowConfig {
	name?: string;
	on?: {
		pull_request?: { branches?: string[] };
		push?: { branches?: string[] };
		workflow_dispatch?: unknown;
	};
	permissions?: Record<string, string>;
	defaults?: { run?: { shell?: string } };
	jobs?: Record<
		string,
		{
			needs?: string | string[];
			"runs-on"?: string;
			"timeout-minutes"?: number;
			steps?: Array<{ uses?: string; name?: string; run?: string; if?: string; with?: Record<string, string> }>;
		}
	>;
}

function parseWorkflow(): WorkflowConfig {
	const raw = readFileSync(WORKFLOW_PATH, "utf-8");
	return load(raw) as WorkflowConfig;
}

describe(".github/workflows/dependency-existence.yml", () => {
	it("exists as a regular file with a budget header comment", () => {
		assert.ok(existsSync(WORKFLOW_PATH), "dependency-existence.yml not found");
		const raw = readFileSync(WORKFLOW_PATH, "utf-8");
		assert.match(raw, /Budget:/, "header comment must state the time budget");
	});

	it("parses as valid YAML with a name", () => {
		const workflow = parseWorkflow();
		assert.ok(workflow, "workflow must parse as valid YAML");
		assert.ok(workflow.name, "workflow must have a name");
	});

	describe("Triggers", () => {
		it("triggers on pull_request to main", () => {
			const pr = parseWorkflow().on?.pull_request;
			assert.ok(pr, "on.pull_request section missing");
			assert.ok(pr.branches?.includes("main"), "pull_request branches must include main");
		});

		it("triggers on push to main", () => {
			const push = parseWorkflow().on?.push;
			assert.ok(push, "on.push section missing");
			assert.ok(push.branches?.includes("main"), "push branches must include main");
		});

		it("supports manual workflow_dispatch", () => {
			const workflow = parseWorkflow();
			assert.ok(
				workflow.on?.workflow_dispatch !== undefined,
				"workflow_dispatch trigger missing"
			);
		});
	});

	describe("Conventions (extension-checks.yml style)", () => {
		it("uses permissions: contents: read", () => {
			const workflow = parseWorkflow();
			assert.ok(workflow.permissions, "top-level permissions missing");
			assert.strictEqual(workflow.permissions.contents, "read");
		});

		it("defaults run shell to bash", () => {
			const workflow = parseWorkflow();
			assert.strictEqual(workflow.defaults?.run?.shell, "bash");
		});

		it("sets timeout-minutes on every job", () => {
			const jobs = parseWorkflow().jobs || {};
			assert.ok(Object.keys(jobs).length >= 2, "expected unit-tests + check jobs");
			for (const [name, job] of Object.entries(jobs)) {
				assert.ok(job["timeout-minutes"] && job["timeout-minutes"] > 0,
					`job ${name} must set timeout-minutes`);
			}
		});
	});

	describe("Job order", () => {
		it("runs offline unit tests before the live check", () => {
			const jobs = parseWorkflow().jobs || {};
			assert.ok(jobs["unit-tests"], "unit-tests job missing");
			assert.ok(jobs["check"], "check job missing");
			const needs = jobs.check.needs;
			assert.ok(
				needs === "unit-tests" || (Array.isArray(needs) && needs.includes("unit-tests")),
				"check job must need unit-tests"
			);
		});

		it("unit-tests job runs the offline python suite first", () => {
			const steps = parseWorkflow().jobs?.["unit-tests"]?.steps || [];
			const first = steps[0];
			assert.ok(first?.uses?.startsWith("actions/checkout@"), "unit-tests must checkout first");
			const testStep = steps.find((s) => s.run?.includes("dependency-existence-check.test.py"));
			assert.ok(testStep, "unit-tests job missing the offline python suite step");
		});

		it("live check invokes the checker with --root . --json", () => {
			const steps = parseWorkflow().jobs?.["check"]?.steps || [];
			const runStep = steps.find((s) => s.run?.includes("dependency-existence-check.py"));
			assert.ok(runStep, "check job missing the checker invocation step");
			assert.ok(
				runStep.run?.includes("--root . --json"),
				"checker must run with --root . --json"
			);
		});

		it("emits ::error:: annotations per failure", () => {
			const steps = parseWorkflow().jobs?.["check"]?.steps || [];
			const runStep = steps.find((s) => s.run?.includes("dependency-existence-check.py"));
			assert.ok(runStep, "check job missing the annotation step");
			assert.ok(runStep.run?.includes("::error::"), "annotations step must emit ::error::");
		});

		it("uploads the JSON report artifact on failure", () => {
			const steps = parseWorkflow().jobs?.["check"]?.steps || [];
			const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
			assert.ok(upload, "check job missing upload-artifact step");
			assert.strictEqual(upload.if, "failure()");
			assert.ok(
				upload.with?.path?.includes("dependency-existence-report.json"),
				"upload must include the JSON report path"
			);
		});

		it("caches registry responses via actions/cache", () => {
			const steps = parseWorkflow().jobs?.["check"]?.steps || [];
			const cache = steps.find((s) => s.uses?.startsWith("actions/cache@"));
			assert.ok(cache, "check job missing actions/cache step");
			assert.ok(cache.with?.path?.includes(".cache/slopsquat"), "cache path must be the slopsquat cache");
		});
	});
});
