import assert from "node:assert";

import { spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

import { measureWorktree } from "./fixtures/long-file-mirror.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

const RUNNER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");

const ANALYZER_BLOCK = readFileSync(
	resolve(HERE, "fixtures", "codeflow-analyzer-block.txt"),
	"utf-8",
);

function generateReportBody(emitJson = true, emitDead = false): string {
	return `
function generateReport(format) {
  if (format === "json"${emitJson ? "" : " && false"}) {
    var blob = new Blob([JSON.stringify({ architectureIssues: data.architectureIssues || [], duplicates: data.duplicates || [{ files: ["a", "b"] }], layerViolations: data.layerViolations || [{ from: "UI", to: "DB" }], suggestions: [{ text: "split" }], marker: data.marker, securityIssues: data.securityIssues || null${emitDead ? ", unusedFunctions: data.deadFunctions || null, stats: data.stats || null" : ""}})], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "codeflow-report.json";
    a.click();
    URL.revokeObjectURL(url);
  } else if (format === "md") {
    var md = "# CodeFlow Analysis Report\\n\\nmarker=" + data.marker + "\\n";
    var blob2 = new Blob([md], { type: "text/markdown" });
    var url2 = URL.createObjectURL(blob2);
    var a2 = document.createElement("a");
    a2.href = url2;
    a2.download = "codeflow-report.md";
    a2.click();
    URL.revokeObjectURL(url2);
  }
}
`;
}

interface Fixture {
	uiDir: string;
	sourceDir: string;
	outDir: string;
}

function analysisJs(data: unknown): string {
	return `"use strict";
module.exports = {
  async analyze() {
    return { schemaVersion: 1, data: ${JSON.stringify(data)}, snapshot: {} };
  },
};
`;
}

const CANON_STATS = { files: 1026, functions: 4890, connections: 5006, dead: 24, loc: 12345 };

function makeFixture(
	opts: {
		emitJson?: boolean;
		emitDead?: boolean;
		analyzerBlock?: string;
		analysisJs?: string | null;
		stats?: unknown;
	} = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "codeflow-runner-"));
	const uiDir = join(root, "ui");
	const sourceDir = join(root, "src");
	const outDir = join(root, "out");
	mkdirSync(join(uiDir, "card", "lib"), { recursive: true });
	mkdirSync(sourceDir, { recursive: true });
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(sourceDir, "a.ts"), "export const a = 1;\n");
	const block = opts.analyzerBlock ?? ANALYZER_BLOCK;
	writeFileSync(
		join(uiDir, "index.html"),
		`<html><body><script type="text/babel">${block}${generateReportBody(opts.emitJson !== false, opts.emitDead === true)}</script></body></html>`,
	);
	if (opts.analysisJs !== null) {
		writeFileSync(
			join(uiDir, "card", "lib", "analysis.js"),
			opts.analysisJs ??
				`"use strict";
const stats = ${"stats" in opts ? JSON.stringify(opts.stats) : JSON.stringify(CANON_STATS)};
module.exports = {
  async analyze(options) {
    return { schemaVersion: 1, data: { marker: "FIXTURE", stats }, snapshot: {} };
  },
};
`,
		);
	}
	return { uiDir, sourceDir, outDir };
}

function runRunner(fx: Fixture): { code: number | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [RUNNER, fx.sourceDir, fx.uiDir, fx.outDir], {
		encoding: "utf-8",
	});
	return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function envelope(stdout: string): {
	markdown: string;
	json: string | null;
	analyzedAt: number;
	stats: Record<string, number> | null;
	terms: { coupling: number; deadCode: number } | null;
} {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1]);
}

const runWithStats = (stats: unknown, emitJson = true) => {
	const fx = makeFixture({ stats, emitJson });
	const { code, stdout, stderr } = runRunner(fx);
	return { code, stderr, env: envelope(stdout), fx };
};

const COUPLING_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "coupling-baseline.json"), "utf-8"),
) as {
	provenance: { filedCoupled: number };
	before: {
		commit: string;
		files: number;
		functions: number;
		connections: number;
		coupled: number;
	};
	after: { commit: string; files: number; functions: number; connections: number; coupled: number };
	reducedBy: string[];
	callSiteOnly: string[];
};

const COMPLEXITY_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "complexity-baseline.json"), "utf-8"),
) as {
	provenance: { issue: number; ref: string; metric: string; filedCount: number };
	before: { commit: string; files: number; complexityCount: number };
	after: { commit: string; files: number; complexityCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

const GOD_OBJECT_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "god-object-baseline.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; files: number; godObjectCount: number };
	after: { commit: string; files: number; godObjectCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

const LONG_FILE_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "long-file-baseline.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; files: number; longFileCount: number };
	after: { commit: string; files: number; longFileCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[] }[];
};

const VBA_GOD_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "vba-god-module-baseline.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; files: number; vbaGodModuleCount: number };
	after: { commit: string; files: number; vbaGodModuleCount: number };
	reducedBy: string[];
	deferred: { reason: string; files?: string[] }[];
};

describe("complexity metric oracle (issue #2003)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(COMPLEXITY_BASELINE.provenance.issue, 2003);
		assert.strictEqual(
			COMPLEXITY_BASELINE.provenance.filedCount,
			202,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.match(COMPLEXITY_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			COMPLEXITY_BASELINE.provenance.metric,
			/critical/,
			"the metric names the `critical` predicate",
		);
		for (const [side, ref] of [
			["before", COMPLEXITY_BASELINE.before],
			["after", COMPLEXITY_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			COMPLEXITY_BASELINE.after.commit,
			COMPLEXITY_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.strictEqual(
			COMPLEXITY_BASELINE.before.complexityCount,
			216,
			"the re-measured base on origin/main",
		);
		assert.ok(
			COMPLEXITY_BASELINE.after.complexityCount < COMPLEXITY_BASELINE.before.complexityCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			COMPLEXITY_BASELINE.after.files > COMPLEXITY_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(COMPLEXITY_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of COMPLEXITY_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("defers the Rust and embedded .sh/.js sets with reasons, and touches none of them", () => {
		const deferred = COMPLEXITY_BASELINE.deferred;
		assert.ok(deferred.length >= 2, "the Rust and .sh/.js deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const withFiles = deferred.filter((d) => (d.files ?? []).length > 0);
		const rust = withFiles.find((d) => d.files!.every((f) => f.endsWith(".rs")));
		const shellJs = withFiles.find((d) => d.files!.every((f) => /\.(sh|js|mjs)$/.test(f)));
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.ok(shellJs, "the embedded .sh/.js set is recorded as deferred");
		assert.ok(rust.files!.length >= 8 && shellJs.files!.length >= 5);
		for (const rel of [...rust.files!, ...shellJs.files!]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(
				!COMPLEXITY_BASELINE.reducedBy.includes(rel),
				`${rel} is both deferred and cited as reduced`,
			);
		}
	});
});
describe("god object metric oracle (issue #2004)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(GOD_OBJECT_BASELINE.provenance.issue, 2004);
		assert.strictEqual(
			GOD_OBJECT_BASELINE.provenance.filedCount,
			63,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.strictEqual(GOD_OBJECT_BASELINE.provenance.filedAnalyzedAt, 1791738325602);
		assert.match(GOD_OBJECT_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			GOD_OBJECT_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		assert.match(
			GOD_OBJECT_BASELINE.provenance.metric,
			/functions\.length > 15/,
			"the metric names the exact predicate",
		);
		for (const [side, ref] of [
			["before", GOD_OBJECT_BASELINE.before],
			["after", GOD_OBJECT_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			GOD_OBJECT_BASELINE.after.commit,
			GOD_OBJECT_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			GOD_OBJECT_BASELINE.after.godObjectCount < GOD_OBJECT_BASELINE.before.godObjectCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			GOD_OBJECT_BASELINE.after.files > GOD_OBJECT_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(GOD_OBJECT_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of GOD_OBJECT_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("defers the Rust, embedded asset and offline-suite sets with reasons", () => {
		const deferred = GOD_OBJECT_BASELINE.deferred;
		assert.ok(deferred.length >= 2, "the Rust and .sh/.js deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const withFiles = deferred.filter((d) => (d.files ?? []).length > 0);
		const rust = withFiles.find((d) => d.files!.every((f) => f.endsWith(".rs")));
		const shellJs = withFiles.find((d) => d.files!.every((f) => /\.(sh|js|mjs)$/.test(f)));
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.ok(shellJs, "the embedded .sh/.js set is recorded as deferred");
		assert.ok(rust.files!.length >= 8 && shellJs.files!.length >= 5);
		for (const rel of [...rust.files!, ...shellJs.files!]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(
				!GOD_OBJECT_BASELINE.reducedBy.includes(rel),
				`${rel} is both deferred and cited as reduced`,
			);
		}
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		// The offline safety-net suite is the one flagged file this change does not
		// split; it must be named in deferred[] with a reason rather than dropped.
		const suite = "test/dependency-existence-check.test.py";
		const entry = GOD_OBJECT_BASELINE.deferred.find((d) => (d.files ?? []).includes(suite));
		assert.ok(entry, `${suite} must be split or deferred, never silently omitted`);
		assert.ok(entry!.reason.length > 0, `${suite} deferral must state a reason`);
		assert.ok(
			!GOD_OBJECT_BASELINE.reducedBy.includes(suite),
			`${suite} is both deferred and cited as reduced`,
		);
	});
});
describe("long file metric oracle (issue #2005)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(LONG_FILE_BASELINE.provenance.issue, 2005);
		assert.strictEqual(
			LONG_FILE_BASELINE.provenance.filedCount,
			61,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.strictEqual(LONG_FILE_BASELINE.provenance.filedAnalyzedAt, 1791738325602);
		assert.match(LONG_FILE_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			LONG_FILE_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		assert.match(
			LONG_FILE_BASELINE.provenance.metric,
			/lines > 500/,
			"the metric names the exact predicate",
		);
		for (const [side, ref] of [
			["before", LONG_FILE_BASELINE.before],
			["after", LONG_FILE_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			LONG_FILE_BASELINE.after.commit,
			LONG_FILE_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			LONG_FILE_BASELINE.after.longFileCount < LONG_FILE_BASELINE.before.longFileCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			LONG_FILE_BASELINE.after.files > LONG_FILE_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(LONG_FILE_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of LONG_FILE_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("records the remaining served-asset deferral, never omitting a leftover flag", () => {
		const deferred = LONG_FILE_BASELINE.deferred;
		assert.ok(deferred.length >= 1, "the remaining deferrals are recorded");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
			for (const rel of entry.files ?? []) {
				assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
				assert.ok(
					!LONG_FILE_BASELINE.reducedBy.includes(rel),
					`${rel} is both deferred and cited as reduced`,
				);
			}
		}
	});

	it("names the record and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/long-file-refactor-2005.test.mts",
			".pi/skills/audit-codeflow-analysis/references/long-file-2005.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});

	it("ties the recorded after envelope to the delivered tree", () => {
		// Recompute the pinned predicate over the delivered tracked tree with the
		// same mirror the per-sibling oracle uses, so the recorded count and the
		// deferral list cannot drift from the source they describe.
		const measured = measureWorktree(resolve(HERE, ".."));
		// The envelope records the #2005 delivery (17). A later refactor may only
		// move declarations out of a recorded long file — #2036 split eleven of the
		// seventeen below 500 segments and added one new long module (the
		// `session.rs` relay), which is recorded in the deferrals below — so the
		// measured count can fall but must never exceed the recorded envelope.
		assert.ok(
			measured.flagged.length <= LONG_FILE_BASELINE.after.longFileCount,
			"the delivered tree must not carry more long files than the recorded envelope",
		);
		// The recorded envelope is anchored to an ancestor commit, so the delivered
		// tree can only have gained scored files since; a lower count means code was
		// deleted, which is the drift this guards against.
		assert.ok(
			measured.codeFiles >= LONG_FILE_BASELINE.after.codeFiles,
			"the delivered tree must still carry the recorded scored files",
		);
		const recordedDeferrals = LONG_FILE_BASELINE.deferred.flatMap((d) => d.files ?? []).sort();
		for (const rel of measured.flagged) {
			assert.ok(
				recordedDeferrals.includes(rel),
				`${rel} is flagged in the delivered tree but is not a recorded deferral`,
			);
		}
	});
});
