/**
 * Validate .github/workflows/tests.yml — the full-suite CI workflow.
 *
 * Covers:
 *   - YAML parseable, header comment with a runtime budget
 *   - Triggers: pull_request branches [main], push branches [main],
 *     workflow_dispatch, and NO pull_request path filter (full suite every PR)
 *   - Conventions: permissions contents: read, defaults.run.shell bash,
 *     top-level concurrency keyed on github.ref with cancel-in-progress
 *   - Every job: ubuntu-latest + timeout-minutes
 *   - Toolchain + invocations: setup-node@v5 (22, npm cache), npm ci,
 *     npm test, go test ./cmd/cheasee-pi/ -count=1, tsc --noEmit
 *   - setup-go@v6 with go-version 1.25
 *   - Failure propagation: no test step swallows failures
 *   - Non-vacuous green: scrapling venv/chromium provisioned and skip-gated;
 *     docker daemon reachability ordered before the dogfooding run
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const WORKFLOW_PATH = resolve(import.meta.dirname, "..", ".github", "workflows", "tests.yml");

interface Step {
	uses?: string;
	name?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
	"continue-on-error"?: boolean;
}

interface Job {
	"runs-on"?: string;
	"timeout-minutes"?: number;
	needs?: string | string[];
	env?: Record<string, string>;
	services?: Record<string, unknown>;
	steps?: Step[];
}

interface WorkflowConfig {
	name?: string;
	on?: {
		pull_request?: { branches?: string[]; paths?: string[] };
		push?: { branches?: string[] };
		workflow_dispatch?: unknown;
	};
	permissions?: Record<string, string>;
	defaults?: { run?: { shell?: string } };
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	jobs?: Record<string, Job>;
}

function parseWorkflow(): WorkflowConfig {
	return load(readFileSync(WORKFLOW_PATH, "utf-8")) as WorkflowConfig;
}

function allSteps(wf: WorkflowConfig): Step[] {
	return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function findRun(wf: WorkflowConfig, needle: string): Step | undefined {
	return allSteps(wf).find((s) => s.run?.includes(needle));
}

describe(".github/workflows/tests.yml", () => {
	describe("Phase 1: file, triggers, conventions", () => {
		it("exists as a regular file with a budget header comment", () => {
			assert.ok(existsSync(WORKFLOW_PATH), "tests.yml not found");
			const raw = readFileSync(WORKFLOW_PATH, "utf-8");
			assert.match(raw, /Budget:/, "header comment must state the time budget");
			assert.match(raw, /15 min|15-minute|under 15/i, "header must document the <15 min target");
		});

		it("parses as valid YAML with a name", () => {
			const workflow = parseWorkflow();
			assert.ok(workflow, "workflow must parse as valid YAML");
			assert.ok(workflow.name, "workflow must have a name");
		});

		it("triggers on pull_request and push to main, plus workflow_dispatch", () => {
			const workflow = parseWorkflow();
			assert.ok(
				workflow.on?.pull_request?.branches?.includes("main"),
				"pull_request branches must include main",
			);
			assert.ok(workflow.on?.push?.branches?.includes("main"), "push branches must include main");
			assert.ok(workflow.on?.workflow_dispatch !== undefined, "workflow_dispatch trigger missing");
		});

		it("runs the full suite on every PR (no pull_request path filter)", () => {
			const workflow = parseWorkflow();
			assert.strictEqual(
				workflow.on?.pull_request?.paths,
				undefined,
				"pull_request.paths must be absent for a full-suite workflow",
			);
		});

		it("uses permissions: contents: read and defaults.run.shell: bash", () => {
			const workflow = parseWorkflow();
			assert.strictEqual(workflow.permissions?.contents, "read");
			assert.strictEqual(workflow.defaults?.run?.shell, "bash");
		});

		it("cancels superseded runs via a github.ref-keyed concurrency group", () => {
			const workflow = parseWorkflow();
			const concurrency = workflow.concurrency;
			assert.ok(concurrency, "top-level concurrency missing");
			assert.strictEqual(concurrency["cancel-in-progress"], true);
			assert.ok(concurrency.group, "concurrency.group missing");
			assert.ok(
				concurrency.group.includes("github.ref"),
				"concurrency group must reference github.ref",
			);
		});

		it("gives every job ubuntu-latest + a positive timeout-minutes", () => {
			const jobs = parseWorkflow().jobs ?? {};
			assert.ok(Object.keys(jobs).length >= 2, "expected multiple jobs");
			for (const [name, job] of Object.entries(jobs)) {
				assert.strictEqual(job["runs-on"], "ubuntu-latest", `job ${name} must use ubuntu-latest`);
				assert.ok(
					typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 0,
					`job ${name} must set a positive timeout-minutes`,
				);
			}
		});
	});

	describe("Phase 2: toolchains and invocations", () => {
		it("sets up Node 22 with npm cache and installs deps via npm ci", () => {
			const steps = allSteps(parseWorkflow());
			const setupNode = steps.find((s) => s.uses?.startsWith("actions/setup-node@v5"));
			assert.ok(setupNode, "actions/setup-node@v5 step missing");
			assert.strictEqual(setupNode.with?.["node-version"], "22");
			assert.strictEqual(setupNode.with?.cache, "npm");
			assert.ok(findRun(parseWorkflow(), "npm ci"), "npm ci step missing");
		});

		it("runs npm test, go test ./cmd/cheasee-pi/ -count=1 and tsc --noEmit", () => {
			const workflow = parseWorkflow();
			assert.ok(findRun(workflow, "npm test"), "npm test step missing");
			assert.ok(
				findRun(workflow, "go test ./cmd/cheasee-pi/ -count=1"),
				"go test ./cmd/cheasee-pi/ -count=1 step missing",
			);
			assert.ok(
				findRun(workflow, "tsc --noEmit --project .pi/tsconfig.json"),
				"tsc --noEmit extension type-check step missing",
			);
		});

		it("sets up Go 1.25 via actions/setup-go@v6", () => {
			const setupGo = allSteps(parseWorkflow()).find((s) =>
				s.uses?.startsWith("actions/setup-go@v6"),
			);
			assert.ok(setupGo, "actions/setup-go@v6 step missing");
			assert.match(String(setupGo.with?.["go-version"] ?? ""), /^1\.25/);
		});
	});

	describe("Phase 3: failure propagation and non-vacuous green", () => {
		it("does not swallow failures in test-invoking steps", () => {
			const steps = allSteps(parseWorkflow());
			for (const step of steps) {
				const run = step.run ?? "";
				const isTestStep =
					run.includes(".test.") || /\bnpm test\b/.test(run) || /\bgo test\b/.test(run);
				if (!isTestStep) continue;
				assert.notStrictEqual(
					step["continue-on-error"],
					true,
					`test step must not set continue-on-error: ${step.name ?? run.slice(0, 40)}`,
				);
			}
		});

		it("never masks a test failure with || true / || exit 0", () => {
			const steps = allSteps(parseWorkflow());
			for (const step of steps) {
				const run = step.run ?? "";
				const exempt = step.if === "always()";
				if (exempt) continue;
				assert.ok(
					!run.includes("|| true") && !run.includes("|| exit 0"),
					`step masks failures with || true/|| exit 0: ${step.name ?? run.slice(0, 40)}`,
				);
			}
		});

		it("provisions the scrapling venv + chromium and gates silent skips", () => {
			const steps = allSteps(parseWorkflow());
			const venvStep = steps.find(
				(s) => s.run?.includes("python3 -m venv") || s.run?.includes("pip install"),
			);
			assert.ok(venvStep, "scrapling venv provisioning step missing");
			const chromiumStep = steps.find((s) => s.run?.includes("patchright install chromium"));
			assert.ok(chromiumStep, "patchright chromium provisioning step missing");
			const gate = steps.find(
				(s) =>
					s.run?.includes("NO_VENV_MSG") &&
					s.run?.includes("NO_CHROMIUM_MSG") &&
					/exit 1/.test(s.run),
			);
			assert.ok(
				gate,
				"scrapling skip gate step missing (must fail on NO_VENV_MSG/NO_CHROMIUM_MSG)",
			);
		});

		it("asserts the docker daemon is reachable before running dogfooding-dedup", () => {
			const workflow = parseWorkflow();
			const dockerJob = Object.values(workflow.jobs ?? {}).find((job) =>
				(job.steps ?? []).some((s) => s.run?.includes("dogfooding-dedup.test.sh")),
			);
			assert.ok(dockerJob, "docker job running dogfooding-dedup.test.sh not found");
			const steps = dockerJob.steps ?? [];
			const daemonIdx = steps.findIndex((s) => s.run?.includes("docker info"));
			const dedupIdx = steps.findIndex((s) => s.run?.includes("dogfooding-dedup.test.sh"));
			assert.ok(daemonIdx >= 0, "docker job missing a docker info reachability step");
			assert.ok(dedupIdx >= 0, "docker job missing the dogfooding-dedup step");
			assert.ok(daemonIdx < dedupIdx, "daemon reachability must run before dogfooding-dedup");
		});

		it("pre-primes the dogfooding image tag cheasee-pi:test-1497", () => {
			const workflow = parseWorkflow();
			assert.ok(
				findRun(workflow, "cheasee-pi:test-1497") ||
					allSteps(workflow).some((s) =>
						Object.values(s.with ?? {}).some((v) => String(v).includes("cheasee-pi:test-1497")),
					),
				"no step references the cheasee-pi:test-1497 image tag",
			);
		});
	});
});
