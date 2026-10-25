/**
 * Regenerate test/fixtures/codeflow-real-analysis-fp.json.
 *
 * Records the *pinned* CodeFlow analyzer's output for this repository (the
 * snapshot `git archive HEAD` produces), before the false-positive filter runs.
 * The acceptance test replays `sanitizeAnalysisData` on this recording, so the
 * regression is pinned against real analyzer field shapes without needing a
 * network fetch or the checkout — the previous audit could not run the live
 * acceptance test, and this is the non-skipped replacement.
 *
 * Usage:
 *   CODEFLOW_UI=/path/to/codeflow node test/fixtures/generate-real-analysis-fp-fixture.mjs
 *
 * `deadFunctions` is the analyzer's own name for the dead-code list the export
 * reports as `unusedFunctions`; only name/file are recorded, which is all the
 * reference rule reads. `suggestions` is the analyzer's derived card set — the
 * pipeline re-derives it after filtering, so the recording pins the stale shape
 * the replay proves gone.
 *
 * Source: https://github.com/braedonsaunders/codeflow at the revision pinned by
 * `ARG CODEFLOW_REF` in cmd/cheasee-pi/embedded/docker/codeflow/Dockerfile
 * (b0e82d127fc4990f571ebc6da6c5d9af2591aaa1). Re-run when the pin or the repo's
 * own analysis-relevant sources move; keep the ref in the fixture header.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ui = process.env.CODEFLOW_UI;
if (!ui) {
	console.error("Set CODEFLOW_UI=/path/to/codeflow (checkout at the pinned ref)");
	process.exit(2);
}
const repo = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const out = join(dirname(new URL(import.meta.url).pathname), "codeflow-real-analysis-fp.json");
const ref = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";

const snapshot = mkdtempSync(join(tmpdir(), "fp-fixture-snap-"));
try {
	const archive = execFileSync("git", ["archive", "HEAD"], { cwd: repo, maxBuffer: 1 << 30 });
	execFileSync("tar", ["-x", "-C", snapshot], { input: archive });

	const require = createRequire(import.meta.url);
	const analysis = require(join(ui, "card", "lib", "analysis.js"));
	const { data } = await analysis.analyze({
		repoRoot: snapshot,
		indexHtmlPath: join(ui, "index.html"),
		actionDir: join(ui, "card"),
	});

	const violations = (data.layerViolations || []).map((v) => ({
		from: v.from,
		to: v.to,
		fromLayer: v.fromLayer,
		toLayer: v.toLayer,
	}));
	// Only the connection pairs an existing violation names can ever matter to
	// the filter's edge rule, so the recording stays small.
	const wanted = new Set(violations.map((v) => `${v.from}\u0000${v.to}`));

	const fixture = {
		provenance: {
			analyzer: "https://github.com/braedonsaunders/codeflow",
			ref,
			snapshot: "git archive HEAD",
		},
		stats: data.stats,
		issues: (data.issues || []).map((i) => ({
			title: i.title,
			severity: i.severity,
			category: i.category,
		})),
		// The derived cards (issue #2030) carry no file of their own; only the title,
		// count and priority matter to the pipeline that re-derives them from the
		// same arrays, so the recording stays readable.
		suggestions: (data.suggestions || []).map((s) => ({
			title: s.title,
			desc: s.desc,
			priority: s.priority,
		})),
		securityIssues: (data.securityIssues || []).map((i) => ({
			title: i.title,
			severity: i.severity,
			description: i.description,
			path: i.path,
			code: i.code,
		})),
		layerViolations: violations,
		deadFunctions: (data.deadFunctions || []).map((fn) => ({ name: fn.name, file: fn.file })),
		connections: (data.connections || [])
			.filter((c) => wanted.has(`${c.source}\u0000${c.target}`))
			.map((c) => ({ source: c.source, target: c.target, type: c.type })),
		files: (data.files || []).map((f) => ({ path: f.path, layer: f.layer })),
	};
	writeFileSync(out, `${JSON.stringify(fixture, null, "\t")}\n`);
	console.log(
		`wrote ${out}: ${fixture.securityIssues.length} security, ` +
			`${fixture.layerViolations.length} layer, ${fixture.deadFunctions.length} dead, ${fixture.files.length} files`,
	);
} finally {
	rmSync(snapshot, { recursive: true, force: true });
}
