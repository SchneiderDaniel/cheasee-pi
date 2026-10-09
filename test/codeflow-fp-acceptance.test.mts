/**
 * Authoritative acceptance check for the CodeFlow false-positive filter.
 *
 * Unlike the fixture-level tests, this drives the *real* pinned CodeFlow
 * analyzer — the same `analysis.analyze` the headless producer calls — against a
 * `git archive HEAD` snapshot of this repository, then asserts the report the
 * producer exports is clean and scores an A. It is the check the issue's
 * acceptance criteria ask for: the false positives are gone and the health
 * score reflects the correction.
 *
 * The pinned checkout is not vendored in this repo, so the test skips unless one
 * is present. Point it at a checkout:
 *
 *   git clone https://github.com/braedonsaunders/codeflow /tmp/codeflow
 *   git -C /tmp/codeflow fetch --depth 1 origin b0e82d127fc4990f571ebc6da6c5d9af2591aaa1
 *   git -C /tmp/codeflow checkout --detach FETCH_HEAD
 *   CODEFLOW_UI_DIR=/tmp/codeflow node --experimental-strip-types --test \
 *     test/codeflow-fp-acceptance.test.mts
 *
 * Or let the test fetch the pinned revision itself (needs network):
 *
 *   CODEFLOW_FP_E2E=1 node --experimental-strip-types --test \
 *     test/codeflow-fp-acceptance.test.mts
 */

import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const RUNNER = join(REPO_ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");
const PINNED_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";
const CHECKOUT_URL = "https://github.com/braedonsaunders/codeflow";

const cleanups: string[] = [];
after(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

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
const SKIP = `pinned CodeFlow checkout unavailable (set CODEFLOW_UI_DIR or CODEFLOW_FP_E2E=1)`;

const ext = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();

// A layer label is real only when the endpoint path carries it as a directory.
const groundsLayer = (layer: string, p: string): boolean =>
	p
		.toLowerCase()
		.split("/")
		.slice(0, -1)
		.includes(String(layer).toLowerCase());

describe("fp-filter — acceptance against the pinned analyzer", () => {
	it(
		"headless report scores an A and carries none of the false positives",
		{ skip: UI_DIR ? false : SKIP },
		() => {
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

			// No HIGH security finding survives (empty/comment-only/type-union/env/
			// phantom shapes are exactly the HIGH class the filter removes).
			const highs = (report.securityIssues as Array<{ severity: string }>).filter(
				(s) => String(s.severity).toLowerCase() === "high",
			);
			assert.deepStrictEqual(highs, [], "no HIGH security finding may remain");

			// Every layer edge pairs two files that can import each other.
			const crossLanguage = (report.layerViolations as Array<{ from: string; to: string }>).filter(
				(v) => ext(v.from) !== ext(v.to),
			);
			assert.deepStrictEqual(crossLanguage, [], "cross-language layer edges must not be emitted");

			// No surviving edge may carry a layer the endpoint path does not name:
			// CodeFlow's `utils` fallback and loose substrings (`/handler` ->
			// `services`) invented the 3 edges the previous audit found.
			const invented = (
				report.layerViolations as Array<{ from: string; to: string; fromLayer: string; toLayer: string }>
			).filter((v) => !groundsLayer(v.fromLayer, v.from) || !groundsLayer(v.toLayer, v.to));
			assert.deepStrictEqual(invented, [], "unsupported layer labels must not survive");

			// Guard: the test is only meaningful if the pinned analyzer actually
			// produced false positives on this snapshot (it did: the issue's 9 HIGH
			// hits plus the cross-language edges).
			assert.match(run.stderr, /suppressed [1-9]\d* security issue\(s\)/);
		},
	);
});
