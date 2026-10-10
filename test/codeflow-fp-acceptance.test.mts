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

// The revision this issue reports on. Pinning the live acceptance run to it
// (not HEAD) means the assertions reproduce the affected report rather than
// whatever the branch happens to be.
const ISSUE_SNAPSHOT = "17c991c033073dccdd549c335abe6c594643b009";
// Measured on that snapshot with the pinned analyzer: every HIGH security hit
// (the reported nine) and the entire layer category (357 edges) is a false
// positive. Deterministic for a fixed revision plus fixed analyzer pin.
const EXPECTED_SECURITY_SUPPRESSED = 9;
const EXPECTED_LAYER_VIOLATIONS_SUPPRESSED = 357;
// The filtered report these expectations imply.
const EXPECTED_HEALTH_SCORE = 92;

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
		assert.deepStrictEqual(crossLanguageOf(data), [], "cross-language layer edges must not survive");
		assert.deepStrictEqual(inventedLayerOf(data), [], "invented layer labels must not survive");

		const after = calcHealth(data);
		assert.ok(after.score >= 90, `expected an A (>= 90), got ${after.score} (${after.grade})`);
		assert.strictEqual(after.grade, "A");
	});
});

describe("fp-filter — live acceptance against the pinned analyzer", () => {
	/** The issue revision, fetched when this checkout does not already carry it. */
	function ensureIssueSnapshot(): string {
		try {
			execFileSync("git", ["cat-file", "-e", `${ISSUE_SNAPSHOT}^{commit}`], {
				cwd: REPO_ROOT,
				stdio: "ignore",
			});
		} catch {
			execFileSync("git", ["fetch", "--depth", "1", "origin", ISSUE_SNAPSHOT], {
				cwd: REPO_ROOT,
				stdio: "ignore",
				timeout: 180_000,
			});
		}
		return ISSUE_SNAPSHOT;
	}

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

	it("headless report on the issue snapshot scores an A and drops every false positive", { skip: UI_DIR ? false : SKIP }, () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "fp-accept-snap-"));
		const outDir = mkdtempSync(join(tmpdir(), "fp-accept-out-"));
		cleanups.push(snapshotDir, outDir);

		// Deterministic snapshot: the exact revision the issue reports on, fed to
		// the producer the way the shim feeds it.
		const archive = execFileSync("git", ["archive", ensureIssueSnapshot()], {
			cwd: REPO_ROOT,
			maxBuffer: 1 << 30,
		});
		execFileSync("tar", ["-x", "-C", snapshotDir], { input: archive });

		const run = spawnSync(process.execPath, [RUNNER, snapshotDir, UI_DIR!, outDir], {
			encoding: "utf-8",
			timeout: 300_000,
		});
		assert.strictEqual(run.status, 0, `producer failed:\n${run.stderr}`);

		// The producer reports suppression instead of dropping silently, and the
		// counts must reproduce the affected report's false positives exactly.
		const suppressed = /fp-filter: suppressed (\d+) security issue\(s\), (\d+) layer violation\(s\)/.exec(
			run.stderr,
		);
		assert.ok(suppressed, `the producer must report what it dropped:\n${run.stderr}`);
		assert.strictEqual(
			Number(suppressed![1]),
			EXPECTED_SECURITY_SUPPRESSED,
			"all nine HIGH security hits must be suppressed on the issue snapshot",
		);
		assert.strictEqual(
			Number(suppressed![2]),
			EXPECTED_LAYER_VIOLATIONS_SUPPRESSED,
			"the whole layer-violation category must be suppressed on the issue snapshot",
		);

		const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf-8"));
		assert.strictEqual(
			report.summary.healthScore,
			EXPECTED_HEALTH_SCORE,
			`expected the corrected score, got ${report.summary.healthScore} (${report.summary.healthGrade})`,
		);
		assert.ok(report.summary.healthScore >= 90, "the corrected score must be an A");
		assert.strictEqual(report.summary.healthGrade, "A");
		assert.deepStrictEqual(highsOf(report), [], "no HIGH security finding may remain");
		assert.deepStrictEqual(crossLanguageOf(report), [], "cross-language layer edges must not be emitted");
		assert.deepStrictEqual(inventedLayerOf(report), [], "unsupported layer labels must not survive");

		// The report must not contradict its own score: the summary counts move
		// with the filtered arrays, or an A still advertises nine HIGH findings.
		assert.strictEqual(report.summary.highSecurityIssues, 0, "summary must not still count the dropped highs");
		assert.strictEqual(report.summary.layerViolations, 0, "summary must not still count the dropped edges");
	});
});
