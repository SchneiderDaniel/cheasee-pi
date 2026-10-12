/**
 * Authoritative acceptance check for the CodeFlow false-positive filter.
 *
 * Check 1 replays `sanitizeAnalysisData` on a *recording* of the pinned
 * analyzer's own output for this repository (see
 * fixtures/generate-real-analysis-fp-fixture.mjs and the fixture header). It is
 * a fast offline regression that pins the real field shapes and the layer
 * guard without a checkout.
 *
 * Check 2 is the authoritative acceptance check and runs by default: it drives
 * the *live* pinned analyzer through the headless producer against a
 * `git archive HEAD` snapshot, then asserts the generated report.json scores an
 * A and carries none of the false positives. When no checkout is present it
 * fetches the pinned revision itself. Point it at a local checkout instead with
 * `CODEFLOW_UI_DIR=/path/to/codeflow`; opt out of the network fetch with
 * `CODEFLOW_FP_E2E=0` (the test then skips if no checkout is present).
 */

import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const RUNNER = join(REPO_ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");
const FILTER = join(REPO_ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");
const FIXTURE = join(HERE, "fixtures", "codeflow-real-analysis-fp.json");
const PINNED_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";
const CHECKOUT_URL = "https://github.com/braedonsaunders/codeflow";

// The four sites this issue reports on. The recording below carries the pinned
// analyzer's MEDIUM `Command Execution` hits at exactly these paths; the live
// acceptance runs on the fixed tree and requires none of them to survive.
const CITED_COMMAND_EXECUTION_PATHS = [
	".pi/extensions/context-info/codeflow.ts",
	".pi/extensions/lsp-auditor/lsp-client/audit-group.ts",
	".pi/extensions/lsp-auditor/lsp-client/runtime.ts",
	".pi/extensions/supervisor/agent/runner/spawn.ts",
];

const requireCjs = createRequire(import.meta.url);
const { sanitizeAnalysisData } = requireCjs(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
	) => { data: any; suppressed: { security: any[]; layerViolations: any[] } };
};
const { calcHealth } = (await import("./fixtures/codeflow-calc-health.mjs")) as {
	calcHealth: (data: any) => { score: number; grade: string };
};

const cleanups: string[] = [];
after(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

const ext = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();
// A layer label is real only when the endpoint path carries it as a directory.
const groundsLayer = (layer: string, p: string): boolean =>
	p
		.toLowerCase()
		.split("/")
		.slice(0, -1)
		.includes(String(layer).toLowerCase());

const highsOf = (data: { securityIssues: Array<{ severity: string }> }) =>
	data.securityIssues.filter((s) => String(s.severity).toLowerCase() === "high");
const crossLanguageOf = (data: { layerViolations: Array<{ from: string; to: string }> }) =>
	data.layerViolations.filter((v) => ext(v.from) !== ext(v.to));
const inventedLayerOf = (
	data: { layerViolations: Array<{ from: string; to: string; fromLayer: string; toLayer: string }> },
) => data.layerViolations.filter((v) => !groundsLayer(v.fromLayer, v.from) || !groundsLayer(v.toLayer, v.to));

/** The cited MEDIUM `Command Execution` hits that must not survive the filter. */
const commandExecutionOf = (data: { securityIssues: Array<{ title: string; path: string }> }) =>
	data.securityIssues.filter(
		(s) => String(s.title).trim() === "Command Execution" && CITED_COMMAND_EXECUTION_PATHS.includes(s.path),
	);

/** Read one analyzed path out of the repo, mirroring the producer's containment. */
function makeRepoReadFile(): (path: unknown) => string | null {
	const root = realpathSync(REPO_ROOT);
	return (rel: unknown) => {
		if (typeof rel !== "string" || rel === "" || isAbsolute(rel) || rel.includes("..")) return null;
		try {
			const real = realpathSync(resolve(root, rel));
			if (!real.startsWith(root + sep)) return null;
			return readFileSync(real, "utf8");
		} catch {
			return null;
		}
	};
}

describe("fp-filter — acceptance against pinned-analyzer output", () => {
	// Always runs: the recording is real analyzer output, so this is the
	// non-skipped score/no-invented-layer assertion the audit asked for.
	it("recorded pinned-analyzer output scores an A with no false positives", () => {
		const recorded = JSON.parse(readFileSync(FIXTURE, "utf8"));
		assert.strictEqual(
			recorded.provenance.ref,
			PINNED_REF,
			"the recording must come from the pinned CodeFlow revision",
		);

		// Guard: the recording is only meaningful if it actually holds the false
		// positives the issue and the previous audit found (else the assertions
		// below would pass vacuously).
		assert.ok(highsOf(recorded).length >= 9, "recording must carry the HIGH security hits");
		assert.deepStrictEqual(
			commandExecutionOf(recorded)
				.map((s) => s.path)
				.sort(),
			[...CITED_COMMAND_EXECUTION_PATHS].sort(),
			"recording must carry the four cited MEDIUM Command Execution hits",
		);
		assert.ok(crossLanguageOf(recorded).length > 0, "recording must carry cross-language edges");
		assert.ok(inventedLayerOf(recorded).length > 0, "recording must carry invented-layer edges");

		const before = calcHealth(recorded);
		assert.ok(before.score < 90, `before-filter score should not already pass: ${before.score}`);

		const { data, suppressed } = sanitizeAnalysisData(recorded, makeRepoReadFile());
		assert.ok(suppressed.security.length >= 9, "every HIGH security hit must be suppressed");
		assert.strictEqual(
			suppressed.layerViolations.length,
			recorded.layerViolations.length,
			"the whole real layer category is noise",
		);

		assert.deepStrictEqual(highsOf(data), [], "no HIGH security finding may survive");
		// The recording is the pre-fix analyzer output, but the filter reads the
		// files on disk — the fixed ones. Every cited spawn now routes through the
		// shared argv policy, so the whole-file finding is a proven false positive
		// and none of the four survives.
		assert.deepStrictEqual(
			commandExecutionOf(data),
			[],
			"no cited MEDIUM Command Execution may survive on the fixed tree",
		);
		assert.deepStrictEqual(crossLanguageOf(data), [], "cross-language layer edges must not survive");
		assert.deepStrictEqual(inventedLayerOf(data), [], "invented layer labels must not survive");

		const after = calcHealth(data);
		assert.ok(after.score >= 90, `expected an A (>= 90), got ${after.score} (${after.grade})`);
		assert.strictEqual(after.grade, "A");
	});
});

describe("fp-filter — live acceptance against the pinned analyzer", () => {
	/** A usable pinned checkout, or null when none is present and none was fetched. */
	function resolveCheckout(): string | null {
		const explicit = process.env.CODEFLOW_UI_DIR || "/opt/codeflow-ui";
		if (existsSync(join(explicit, "index.html")) && existsSync(join(explicit, "card", "lib", "analysis.js"))) {
			return explicit;
		}
		// Fetch the pin by default so the authoritative check actually runs; an
		// offline environment skips below, and CODEFLOW_FP_E2E=0 opts out.
		if (process.env.CODEFLOW_FP_E2E === "0") return null;
		const dir = mkdtempSync(join(tmpdir(), "fp-accept-ui-"));
		cleanups.push(dir);
		try {
			execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", CHECKOUT_URL, dir], {
				stdio: "ignore",
				timeout: 180_000,
			});
			execFileSync("git", ["-C", dir, "fetch", "--depth", "1", "origin", PINNED_REF], {
				stdio: "ignore",
				timeout: 180_000,
			});
			execFileSync("git", ["-C", dir, "checkout", "--detach", "FETCH_HEAD"], { stdio: "ignore" });
		} catch {
			return null;
		}
		return existsSync(join(dir, "card", "lib", "analysis.js")) ? dir : null;
	}

	const UI_DIR = resolveCheckout();
	const SKIP =
		"pinned CodeFlow checkout unavailable (set CODEFLOW_UI_DIR, or CODEFLOW_FP_E2E=0 to skip)";

	// The audit asked for the signal to be resolved on the *fixed* tree, not
	// merely reproduced on the pre-fix revision: the producer analyzes the branch
	// under test and the four cited MEDIUM hits must be gone.
	it("headless report on the updated tree emits no cited Command Execution", { skip: UI_DIR ? false : SKIP }, () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "fp-accept-snap-"));
		const outDir = mkdtempSync(join(tmpdir(), "fp-accept-out-"));
		cleanups.push(snapshotDir, outDir);

		// The updated tree, fed to the producer the way the shim feeds it. The
		// filter reads these files, so each cited spawn is proven argv-safe and
		// the stale whole-file finding is dropped.
		const archive = execFileSync("git", ["archive", "HEAD"], {
			cwd: REPO_ROOT,
			maxBuffer: 1 << 30,
		});
		execFileSync("tar", ["-x", "-C", snapshotDir], { input: archive });

		const run = spawnSync(process.execPath, [RUNNER, snapshotDir, UI_DIR!, outDir], {
			encoding: "utf-8",
			timeout: 300_000,
		});
		assert.strictEqual(run.status, 0, `producer failed:\n${run.stderr}`);

		// The producer reports suppression instead of dropping silently.
		const suppressed = /fp-filter: suppressed (\d+) security issue\(s\), (\d+) layer violation\(s\)/.exec(
			run.stderr,
		);
		assert.ok(suppressed, `the producer must report what it dropped:\n${run.stderr}`);

		const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf-8"));
		assert.deepStrictEqual(
			commandExecutionOf(report),
			[],
			"the four cited MEDIUM Command Execution hits must be resolved on the fixed tree",
		);
		assert.deepStrictEqual(highsOf(report), [], "no HIGH security finding may remain");
		assert.ok(report.summary.healthScore >= 90, "the corrected score must be an A");
		assert.strictEqual(report.summary.healthGrade, "A");
		assert.deepStrictEqual(crossLanguageOf(report), [], "cross-language layer edges must not be emitted");
		assert.deepStrictEqual(inventedLayerOf(report), [], "unsupported layer labels must not survive");

		// The report must not contradict its own score: the summary counts move
		// with the filtered arrays.
		assert.strictEqual(report.summary.highSecurityIssues, 0, "summary must not still count the dropped highs");
		assert.strictEqual(report.summary.layerViolations, 0, "summary must not still count the dropped edges");
	});
});
