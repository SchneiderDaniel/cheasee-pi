/**
 * Authoritative acceptance check for the CodeFlow false-positive filter.
 *
 * Check 1 (always runs) replays `sanitizeAnalysisData` on a *recording* of the
 * pinned analyzer's own output for this repository (see
 * fixtures/generate-real-analysis-fp-fixture.mjs and the fixture header). The
 * recording carries the false positives the issue filed against — 11 HIGH
 * security hits and 360 layer edges, including the three invented-layer pairs a
 * previous audit found surviving — so the check pins the real field shapes and
 * the layer guard without a network fetch or the checkout. It is the
 * non-skipped replacement for the env-gated live run the audit could not
 * perform.
 *
 * Check 2 (opt-in) drives the *live* pinned analyzer against a `git archive
 * HEAD` snapshot. Point it at a checkout:
 *
 *   CODEFLOW_UI_DIR=/path/to/codeflow node --experimental-strip-types --test \
 *     test/codeflow-fp-acceptance.test.mts
 *
 * Or let it fetch the pinned revision itself (needs network):
 *
 *   CODEFLOW_FP_E2E=1 node --experimental-strip-types --test \
 *     test/codeflow-fp-acceptance.test.mts
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
	/** A usable pinned checkout, or null when none is present and none was fetched. */
	function resolveCheckout(): string | null {
		const explicit = process.env.CODEFLOW_UI_DIR || "/opt/codeflow-ui";
		if (existsSync(join(explicit, "index.html")) && existsSync(join(explicit, "card", "lib", "analysis.js"))) {
			return explicit;
		}
		if (process.env.CODEFLOW_FP_E2E !== "1") return null;
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
	const SKIP = "pinned CodeFlow checkout unavailable (set CODEFLOW_UI_DIR or CODEFLOW_FP_E2E=1)";

	it("headless report scores an A and carries none of the false positives", { skip: UI_DIR ? false : SKIP }, () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "fp-accept-snap-"));
		const outDir = mkdtempSync(join(tmpdir(), "fp-accept-out-"));
		cleanups.push(snapshotDir, outDir);

		// Deterministic snapshot: exactly what the shim feeds the producer.
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
		assert.match(
			run.stderr,
			/fp-filter: suppressed \d+ security issue\(s\), \d+ layer violation\(s\)/,
			"the producer must run the filter and report what it dropped",
		);

		const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf-8"));
		assert.ok(
			report.summary.healthScore >= 90,
			`expected an A (>= 90), got ${report.summary.healthScore} (${report.summary.healthGrade})`,
		);
		assert.strictEqual(report.summary.healthGrade, "A");
		assert.deepStrictEqual(highsOf(report), [], "no HIGH security finding may remain");
		assert.deepStrictEqual(crossLanguageOf(report), [], "cross-language layer edges must not be emitted");
		assert.deepStrictEqual(inventedLayerOf(report), [], "unsupported layer labels must not survive");

		// Guard: the live run is only meaningful if the analyzer produced the
		// false positives on this snapshot.
		assert.match(run.stderr, /suppressed [1-9]\d* security issue\(s\)/);
	});
});
