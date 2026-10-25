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
 *   - Prettier format gate: `format:check` script (`prettier --check .`, check-only,
 *     directory scan) and a read-only `format-check` job that installs via `npm ci`
 *     before invoking the script, with no path filter
 *   - Failure propagation: no test step swallows failures
 *   - Non-vacuous green: scrapling venv/chromium provisioned and skip-gated;
 *     docker daemon reachability ordered before the dogfooding run
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github", "workflows", "tests.yml");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const PRETTIER_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "prettier");
const PRETTIERIGNORE_PATH = resolve(REPO_ROOT, ".prettierignore");

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
	permissions?: Record<string, string>;
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

describe("Prettier format gate", () => {
	describe("format:check port is present and check-only (package.json)", () => {
		function script(): string {
			const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as {
				scripts?: Record<string, string>;
			};
			const value = pkg.scripts?.["format:check"];
			assert.ok(
				typeof value === "string" && value.length > 0,
				'package.json scripts["format:check"] must be a non-empty string',
			);
			return value;
		}

		it("declares format:check as exactly `prettier --check .`", () => {
			assert.strictEqual(script(), "prettier --check .");
		});

		it("runs in check mode only and never --write", () => {
			const value = script();
			assert.ok(value.includes("--check"), "format:check must pass --check");
			assert.ok(!value.includes("--write"), "format:check must not pass --write");
		});

		it("scans the directory rather than enumerating non-JS language globs", () => {
			const value = script();
			for (const glob of [".go", ".py", ".txt", ".md"]) {
				assert.ok(
					!value.includes(glob),
					`format:check must not enumerate ${glob} (prettier exits 2 with no inferable parser)`,
				);
			}
			assert.ok(value.trim().endsWith("."), "format:check must scan the directory '.'");
		});
	});

	describe("format-check job is wired into tests.yml", () => {
		function job(): Job {
			const value = (parseWorkflow().jobs ?? {})["format-check"];
			assert.ok(value, 'tests.yml jobs["format-check"] must exist');
			return value;
		}

		it("runs on ubuntu-latest with a positive timeout-minutes", () => {
			const value = job();
			assert.strictEqual(value["runs-on"], "ubuntu-latest");
			assert.ok(
				typeof value["timeout-minutes"] === "number" && value["timeout-minutes"] > 0,
				"format-check must set a positive timeout-minutes",
			);
		});

		it("checks out the repo and sets up Node 22 with npm cache", () => {
			const steps = job().steps ?? [];
			assert.ok(
				steps.some((s) => s.uses?.startsWith("actions/checkout@v5")),
				"format-check must check out the repo via actions/checkout@v5",
			);
			const setupNode = steps.find((s) => s.uses?.startsWith("actions/setup-node@v5"));
			assert.ok(setupNode, "format-check missing actions/setup-node@v5");
			assert.strictEqual(setupNode.with?.["node-version"], "22");
			assert.strictEqual(setupNode.with?.cache, "npm");
		});

		it("installs with `npm ci --ignore-scripts` before running the port", () => {
			const steps = job().steps ?? [];
			const installIdx = steps.findIndex((s) => s.run?.includes("npm ci --ignore-scripts"));
			const checkIdx = steps.findIndex((s) => s.run?.includes("npm run format:check"));
			assert.ok(installIdx >= 0, "format-check must install via `npm ci --ignore-scripts`");
			assert.ok(checkIdx >= 0, "format-check must run `npm run format:check`");
			assert.ok(installIdx < checkIdx, "install must precede the format check");
		});

		it("uses the port, never an inlined npx prettier", () => {
			for (const step of job().steps ?? []) {
				assert.ok(
					!(step.run ?? "").includes("npx prettier"),
					"format-check must invoke the format:check port, not npx prettier",
				);
			}
		});

		it("reports on every PR to main (no path-filter hole)", () => {
			const workflow = parseWorkflow();
			assert.strictEqual(workflow.on?.pull_request?.paths, undefined);
			assert.ok(workflow.on?.pull_request?.branches?.includes("main"));
		});
	});

	describe("format-check failure propagation and read-only guarantees", () => {
		function steps(): Step[] {
			const value = (parseWorkflow().jobs ?? {})["format-check"];
			assert.ok(value, 'tests.yml jobs["format-check"] must exist');
			return value.steps ?? [];
		}

		it("does not set continue-on-error on the format step", () => {
			const formatStep = steps().find((s) => s.run?.includes("npm run format:check"));
			assert.ok(formatStep, "format step missing");
			assert.notStrictEqual(formatStep["continue-on-error"], true);
		});

		it("does not swallow failures with || true / || exit 0", () => {
			for (const step of steps()) {
				const run = step.run ?? "";
				assert.ok(
					!run.includes("|| true") && !run.includes("|| exit 0"),
					`format-check step masks failures: ${step.name ?? run.slice(0, 40)}`,
				);
			}
		});

		it("is read-only: no --write, no git commit/push/add", () => {
			const forbidden = ["--write", "git commit", "git push", "git add"];
			for (const step of steps()) {
				const run = step.run ?? "";
				for (const needle of forbidden) {
					assert.ok(
						!run.includes(needle),
						`format-check must not contain '${needle}': ${step.name ?? run.slice(0, 40)}`,
					);
				}
			}
		});

		it("keeps permissions at contents: read", () => {
			const workflow = parseWorkflow();
			assert.strictEqual(workflow.permissions?.contents, "read");
			const jobPermissions = (workflow.jobs ?? {})["format-check"]?.permissions;
			if (jobPermissions?.contents !== undefined) {
				assert.strictEqual(jobPermissions.contents, "read");
			}
		});
	});

	describe("Prettier sweep scope (.prettierignore)", () => {
		const GOLDENS = ".pi/extensions/session-logger/test/fixtures/session-logger-renderer-goldens/";
		function entries(): string[] {
			return readFileSync(PRETTIERIGNORE_PATH, "utf-8")
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !l.startsWith("#"));
		}

		it("carves out the generated renderer byte-goldens", () => {
			assert.ok(
				entries().includes(GOLDENS),
				"the generated goldens dir must be quarantined from the sweep",
			);
		});

		it("never quarantines hand-written source", () => {
			for (const entry of entries()) {
				assert.ok(
					!entry.startsWith(".pi/extensions/scrapling/"),
					`prettierignore must not hide hand-written source: ${entry}`,
				);
				assert.ok(
					!entry.includes("renderer.ts"),
					`the exclusion must stay in config, never source: ${entry}`,
				);
			}
		});

		it("holds only build/vendor ignores plus the golden carve-out", () => {
			const allowed = new Set([
				"node_modules/",
				"dist/",
				"build/",
				"coverage/",
				".git/",
				"tmp/",
				"*.min.js",
				"*.min.css",
				"package-lock.json",
				GOLDENS,
				"cmd/cheasee-pi/embedded/docker/ui/provider_env_map.json",
			]);
			for (const entry of entries()) {
				assert.ok(allowed.has(entry), `unexpected .prettierignore entry: ${entry}`);
			}
		});
	});

	describe("Prettier CLI exit-code contract", () => {
		function withTempDir(files: Record<string, string>, fn: (dir: string) => void): void {
			assert.ok(existsSync(PRETTIER_BIN), "prettier binary missing — run `npm ci` first");
			const dir = mkdtempSync(join(tmpdir(), "prettier-contract-"));
			try {
				for (const [name, content] of Object.entries(files)) {
					writeFileSync(join(dir, name), content);
				}
				fn(dir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		function check(dir: string, args: string[] = ["."]): { status: number; output: string } {
			const result = spawnSync(PRETTIER_BIN, ["--check", ...args], {
				cwd: dir,
				encoding: "utf-8",
			});
			return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
		}

		it("exits 0 on a well-formatted tree", () => {
			withTempDir({ "a.ts": "const x = 1;\n" }, (dir) => {
				assert.strictEqual(check(dir).status, 0);
			});
		});

		it("exits 1 and reports code style issues on a misformatted file", () => {
			withTempDir({ "a.ts": "const    x=1\n" }, (dir) => {
				const { status, output } = check(dir);
				assert.strictEqual(status, 1);
				assert.match(output, /Code style issues/);
			});
		});

		it("leaves the misformatted fixture byte-identical (read-only)", () => {
			withTempDir({ "a.ts": "const    x=1\n" }, (dir) => {
				const before = readFileSync(join(dir, "a.ts"));
				check(dir);
				assert.deepStrictEqual(readFileSync(join(dir, "a.ts")), before);
			});
		});

		it("exits 0 on a non-JS-only tree (no exit 2 on unknown languages)", () => {
			withTempDir({ "x.go": "package main\n", "y.py": "x = 1\n", "note.txt": "hi\n" }, (dir) => {
				const { status, output } = check(dir);
				assert.strictEqual(status, 0);
				assert.ok(!output.includes("No parser could be inferred"));
			});
		});

		it("pins the characterization: an explicit .go path exits 2", () => {
			withTempDir({ "x.go": "package main\n" }, (dir) => {
				const { status, output } = check(dir, ["x.go"]);
				assert.strictEqual(status, 2);
				assert.match(output, /No parser could be inferred/);
			});
		});
	});
});
