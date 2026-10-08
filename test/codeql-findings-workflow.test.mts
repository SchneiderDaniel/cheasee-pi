/**
 * Validate .github/workflows/codeql-findings-gate.yml — the PR gate that fails
 * while CodeQL still reports open alerts for the PR head.
 *
 * Covers:
 *   - YAML parseable, header comment with a budget
 *   - Trigger: pull_request to main
 *   - permissions: contents/actions/security-events read; defaults.run.shell bash
 *   - Wait step polls the CodeQL run for this PR head, and runs before the
 *     findings step
 *   - Findings step queries the open CodeQL alerts for this PR and exits 1
 *     when any remain
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
	"codeql-findings-gate.yml",
);

interface Step {
	uses?: string;
	name?: string;
	run?: string;
	env?: Record<string, string>;
}

interface WorkflowConfig {
	name?: string;
	on?: { pull_request?: { branches?: string[] } };
	permissions?: Record<string, string>;
	defaults?: { run?: { shell?: string } };
	jobs?: Record<
		string,
		{
			"runs-on"?: string;
			"timeout-minutes"?: number;
			steps?: Step[];
		}
	>;
}

function parseWorkflow(): WorkflowConfig {
	return load(readFileSync(WORKFLOW_PATH, "utf-8")) as WorkflowConfig;
}

function stepsOf(workflow: WorkflowConfig): Step[] {
	return workflow.jobs?.["codeql-findings"]?.steps || [];
}

describe(".github/workflows/codeql-findings-gate.yml", () => {
	it("exists as a regular file with a budget header comment", () => {
		assert.ok(existsSync(WORKFLOW_PATH), "codeql-findings-gate.yml not found");
		assert.match(readFileSync(WORKFLOW_PATH, "utf-8"), /Budget:/);
	});

	it("parses as valid YAML with a name", () => {
		const workflow = parseWorkflow();
		assert.ok(workflow.name, "workflow must have a name");
	});

	it("triggers on pull_request to main", () => {
		const pr = parseWorkflow().on?.pull_request;
		assert.ok(pr?.branches?.includes("main"), "pull_request branches must include main");
	});

	it("declares the permissions the alert and run APIs need", () => {
		const permissions = parseWorkflow().permissions || {};
		assert.strictEqual(permissions.contents, "read");
		assert.strictEqual(permissions.actions, "read");
		assert.strictEqual(permissions["security-events"], "read");
	});

	it("defaults run shell to bash and sets a job timeout", () => {
		const workflow = parseWorkflow();
		assert.strictEqual(workflow.defaults?.run?.shell, "bash");
		const job = workflow.jobs?.["codeql-findings"];
		assert.ok(job?.["timeout-minutes"] && job["timeout-minutes"] > 0, "timeout-minutes missing");
	});

	it("waits for this PR's CodeQL run before checking alerts", () => {
		const steps = stepsOf(parseWorkflow());
		const wait = steps.findIndex((s) => s.run?.includes("head_sha="));
		const check = steps.findIndex((s) => s.run?.includes("--paginate"));
		assert.ok(wait >= 0, "wait step missing");
		assert.ok(check > wait, "wait for CodeQL must come before the findings check");
		const run = steps[wait].run || "";
		assert.ok(run.includes("actions/runs?head_sha=$HEAD_SHA"), "wait must list runs by head sha");
		assert.ok(run.includes("PR #$PR"), "wait must match the CodeQL run named 'PR #<number>'");
	});

	it("queries the open CodeQL alerts scoped to this PR", () => {
		const step = stepsOf(parseWorkflow()).find((s) => s.run?.includes("--paginate"));
		assert.ok(step, "findings step missing");
		const run = step.run || "";
		for (const expected of ["state=open", "tool_name=CodeQL", "pr=$PR", "--paginate"]) {
			assert.ok(run.includes(expected), `findings query must include ${expected}`);
		}
	});

	it("fails when any open finding remains", () => {
		const step = stepsOf(parseWorkflow()).find((s) => s.run?.includes("--paginate"));
		const run = step?.run || "";
		assert.ok(run.includes("exit 1"), "findings step must exit non-zero on a finding");
		assert.ok(run.includes("count"), "findings step must branch on the alert count");
	});
});
