/**
 * Validate .github/workflows/release.yml workflow structure.
 *
 * Covers:
 *   - YAML parseable
 *   - Triggers: push tags v*, pull_request on relevant paths
 *   - test job: go build ./cmd/cheasee-pi/
 *   - release job: permissions, condition, checkout fetch-depth: 0, goreleaser-action
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const WORKFLOW_PATH = resolve(import.meta.dirname, "..", ".github", "workflows", "release.yml");

interface WorkflowConfig {
	name?: string;
	on?: {
		push?: { tags?: string[]; branches?: string[] };
		pull_request?: { paths?: string[]; branches?: string[] };
	};
	permissions?: Record<string, string>;
	defaults?: { run?: { shell?: string } };
	jobs?: Record<
		string,
		{
			"if"?: string;
			needs?: string | string[];
			"runs-on"?: string;
			permissions?: Record<string, string>;
			steps?: Array<{
				uses?: string;
				name?: string;
				run?: string;
				with?: Record<string, string>;
			}>;
		}
	>;
}

function parseWorkflow(): WorkflowConfig {
	const raw = readFileSync(WORKFLOW_PATH, "utf-8");
	return load(raw) as WorkflowConfig;
}

describe(".github/workflows/release.yml", () => {
	describe("Phase 1: File existence and YAML validity", () => {
		it("exists as a regular file", () => {
			assert.ok(existsSync(WORKFLOW_PATH), "release.yml not found");
		});

		it("parses as valid YAML", () => {
			const workflow = parseWorkflow();
			assert.ok(workflow, "workflow must parse as valid YAML");
			assert.ok(workflow.name, "workflow must have a name");
		});
	});

	describe("Phase 2: Triggers", () => {
		it("triggers on push tags v*", () => {
			const workflow = parseWorkflow();
			const push = workflow.on?.push;
			assert.ok(push, "on.push section missing");
			assert.ok(push.tags?.includes("v*"), "push.tags must include v*");
		});

		it("triggers on pull_request with path filters for cmd/cheasee-pi/**, go.mod, go.sum, release.yml", () => {
			const workflow = parseWorkflow();
			const pr = workflow.on?.pull_request;
			assert.ok(pr, "on.pull_request section missing");
			assert.ok(pr.paths, "on.pull_request.paths missing");
			assert.ok(pr.paths.includes("cmd/cheasee-pi/**"), "missing cmd/cheasee-pi/** path");
			assert.ok(pr.paths.includes("go.mod"), "missing go.mod path");
			assert.ok(pr.paths.includes("go.sum"), "missing go.sum path");
			assert.ok(
				pr.paths.includes(".github/workflows/release.yml"),
				"missing .github/workflows/release.yml path"
			);
		});
	});

	describe("Phase 3: test job", () => {
		it("defines a test job running on ubuntu-latest", () => {
			const workflow = parseWorkflow();
			assert.ok(workflow.jobs?.test, "test job missing");
			assert.strictEqual(workflow.jobs.test["runs-on"], "ubuntu-latest");
		});

		it("test job runs go build ./cmd/cheasee-pi/", () => {
			const workflow = parseWorkflow();
			const steps = workflow.jobs?.test?.steps || [];
			const buildStep = steps.find(
				(s) => s.run && s.run.includes("go build ./cmd/cheasee-pi/")
			);
			assert.ok(buildStep, "test job missing go build step");
		});

		it("test job checks out code and sets up Go", () => {
			const workflow = parseWorkflow();
			const steps = workflow.jobs?.test?.steps || [];
			const checkoutStep = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
			const setupGoStep = steps.find((s) => s.uses?.startsWith("actions/setup-go@"));
			assert.ok(checkoutStep, "test job missing checkout step");
			assert.ok(setupGoStep, "test job missing setup-go step");
		});
	});

	describe("Phase 4: release job", () => {
		it("defines a release job that needs test", () => {
			const workflow = parseWorkflow();
			assert.ok(workflow.jobs?.release, "release job missing");
			const needs = workflow.jobs.release.needs;
			assert.ok(needs === "test" || (Array.isArray(needs) && needs.includes("test")),
				"release job must need test");
		});

		it("release job is gated by startsWith(github.ref, 'refs/tags/v')", () => {
			const workflow = parseWorkflow();
			const releaseJob = workflow.jobs?.release;
			assert.ok(releaseJob, "release job missing");
			assert.ok(
				releaseJob["if"]?.includes("startsWith(github.ref, 'refs/tags/v')"),
				"release job must have if condition for tag push"
			);
		});

		it("release job has permissions.contents: write", () => {
			const workflow = parseWorkflow();
			const releaseJob = workflow.jobs?.release;
			assert.ok(releaseJob, "release job missing");
			assert.ok(releaseJob.permissions, "release job permissions missing");
			assert.strictEqual(
				releaseJob.permissions.contents,
				"write",
				"release job permissions.contents must be write"
			);
		});

		it("release job runs on ubuntu-latest", () => {
			const workflow = parseWorkflow();
			assert.strictEqual(
				workflow.jobs?.release?.["runs-on"],
				"ubuntu-latest",
				"release job must run on ubuntu-latest"
			);
		});

		it("release job uses actions/checkout@v4 with fetch-depth: 0", () => {
			const workflow = parseWorkflow();
			const steps = workflow.jobs?.release?.steps || [];
			const checkoutStep = steps.find((s) => s.uses?.startsWith("actions/checkout@v4"));
			assert.ok(checkoutStep, "release job missing actions/checkout@v4");
			assert.strictEqual(
				checkoutStep?.with?.["fetch-depth"],
				0,
				"checkout must have fetch-depth: 0"
			);
		});

		it("release job uses goreleaser/goreleaser-action@v6 with args: release --clean", () => {
			const workflow = parseWorkflow();
			const steps = workflow.jobs?.release?.steps || [];
			const goreleaserStep = steps.find((s) =>
				s.uses?.startsWith("goreleaser/goreleaser-action@v6")
			);
			assert.ok(goreleaserStep, "release job missing goreleaser/goreleaser-action@v6");
			assert.strictEqual(
				goreleaserStep?.with?.args,
				"release --clean",
				"goreleaser args must include release --clean"
			);
		});

		it("release job sets up Go", () => {
			const workflow = parseWorkflow();
			const steps = workflow.jobs?.release?.steps || [];
			const setupGoStep = steps.find((s) => s.uses?.startsWith("actions/setup-go@"));
			assert.ok(setupGoStep, "release job missing setup-go step");
		});
	});
});
