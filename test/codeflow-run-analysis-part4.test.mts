import assert from "node:assert";

import { spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

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
	reducedByLater?: { issue: number; reason: string; files: string[] };
	deferred: { reason: string; files?: string[] }[];
};

describe("vba god module metric oracle (issue #2006)", () => {
	it("records a real drop between two immutable commits on the pinned analyzer", () => {
		assert.strictEqual(VBA_GOD_BASELINE.provenance.issue, 2006);
		assert.strictEqual(
			VBA_GOD_BASELINE.provenance.filedCount,
			44,
			"the issue's filed count; the re-measured base differs once main advanced",
		);
		assert.strictEqual(VBA_GOD_BASELINE.provenance.filedAnalyzedAt, 1791738325602);
		assert.match(VBA_GOD_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			VBA_GOD_BASELINE.provenance.metric,
			/functions\.length > 20/,
			"the metric names the exact predicate",
		);
		assert.match(
			VBA_GOD_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		for (const [side, ref] of [
			["before", VBA_GOD_BASELINE.before],
			["after", VBA_GOD_BASELINE.after],
		] as const) {
			assert.match(ref.commit, /^[0-9a-f]{40}$/, `${side}.commit must be an immutable commit`);
		}
		assert.notStrictEqual(
			VBA_GOD_BASELINE.after.commit,
			VBA_GOD_BASELINE.before.commit,
			"before and after must be different snapshots",
		);
		assert.ok(
			VBA_GOD_BASELINE.after.vbaGodModuleCount < VBA_GOD_BASELINE.before.vbaGodModuleCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			VBA_GOD_BASELINE.after.files > VBA_GOD_BASELINE.before.files,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(VBA_GOD_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of VBA_GOD_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(
				!rel.endsWith(".mts"),
				`${rel} is test-only: the pinned analyzer never counts a .mts file`,
			);
		}
	});

	it("defers the Rust set, never citing one path twice", () => {
		const deferred = VBA_GOD_BASELINE.deferred;
		assert.strictEqual(deferred.length, 1, "only the Rust set is still deferred");
		for (const entry of deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		const withFiles = deferred.filter((d) => (d.files ?? []).length > 0);
		const rust = withFiles.find((d) => d.files!.every((f) => f.endsWith(".rs")));
		assert.ok(rust, "the Rust set is recorded as deferred");
		// #2031 split server.py below the ceiling, so it is cited there instead.
		assert.deepStrictEqual(VBA_GOD_BASELINE.reducedByLater?.files, [
			"cmd/cheasee-pi/embedded/docker/codeflow/server.py",
		]);
		assert.strictEqual(VBA_GOD_BASELINE.reducedByLater?.issue, 2031);
		for (const rel of withFiles.flatMap((d) => d.files!)) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing deferred path: ${rel}`);
			assert.ok(
				!VBA_GOD_BASELINE.reducedBy.includes(rel),
				`${rel} is both deferred and cited as reduced`,
			);
			assert.ok(
				!(VBA_GOD_BASELINE.reducedByLater?.files ?? []).includes(rel),
				`${rel} is both deferred and reduced by a later issue`,
			);
		}
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		const files = VBA_GOD_BASELINE.deferred.flatMap((d) => d.files ?? []);
		assert.strictEqual(
			VBA_GOD_BASELINE.before.vbaGodModuleCount,
			VBA_GOD_BASELINE.reducedBy.length +
				(VBA_GOD_BASELINE.reducedByLater?.files.length ?? 0) +
				files.length,
			"the base count must equal reduced + reduced-by-a-later-issue + deferred",
		);
		assert.strictEqual(
			VBA_GOD_BASELINE.after.vbaGodModuleCount,
			files.length,
			"every file still flagged on the delivered tree is a recorded deferral",
		);
	});

	it("names the per-sibling oracle and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/vba-god-module-refactor-2006.test.mts",
			".pi/skills/audit-codeflow-analysis/references/vba-god-module-2006.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});
});

// ─── VBA god module oracle (issue #2036) ──────────────────────────
// The re-filed `VBA God Module` metric. This block replays the recorded
// envelope and guards its shape; the per-sibling structural oracle lives in
// `test/vba-god-module-refactor-2036.test.mts`.
const VBA_GOD_2036_BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "vba-god-module-baseline-2036.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	before: { commit: string; codeFiles: number; vbaGodModuleCount: number };
	after: { ref: string; codeFiles: number; vbaGodModuleCount: number };
	baseAdvance: { resolvedFiles: string[] };
	reducedBy: string[];
	deferred: { reason: string; files?: string[] }[];
};

describe("vba god module metric oracle (issue #2036)", () => {
	it("records a real drop on the pinned analyzer", () => {
		assert.strictEqual(VBA_GOD_2036_BASELINE.provenance.issue, 2036);
		assert.strictEqual(VBA_GOD_2036_BASELINE.provenance.filedCount, 25);
		assert.strictEqual(VBA_GOD_2036_BASELINE.provenance.filedAnalyzedAt, 1791804971015);
		assert.match(VBA_GOD_2036_BASELINE.provenance.ref, /^[0-9a-f]{40}$/, "pinned analyzer ref");
		assert.match(
			VBA_GOD_2036_BASELINE.provenance.metric,
			/functions\.length > 20/,
			"the metric names the exact predicate",
		);
		assert.match(
			VBA_GOD_2036_BASELINE.provenance.metric,
			/isCode !== false/,
			"the metric names the `isCode` gate",
		);
		assert.match(VBA_GOD_2036_BASELINE.before.commit, /^[0-9a-f]{40}$/, "immutable base commit");
		assert.ok(
			VBA_GOD_2036_BASELINE.after.vbaGodModuleCount <
				VBA_GOD_2036_BASELINE.before.vbaGodModuleCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			VBA_GOD_2036_BASELINE.after.codeFiles > VBA_GOD_2036_BASELINE.before.codeFiles,
			"the split adds files; the drop is not from dropping files",
		);
	});

	it("cites only existing, non-test-only reduction sources", () => {
		assert.ok(VBA_GOD_2036_BASELINE.reducedBy.length > 0, "reducedBy must be non-empty");
		for (const rel of VBA_GOD_2036_BASELINE.reducedBy) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing reduction source: ${rel}`);
			assert.ok(!rel.endsWith(".mts"), `${rel} is test-only: the analyzer never counts a .mts`);
		}
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		const files = VBA_GOD_2036_BASELINE.deferred.flatMap((d) => d.files ?? []);
		assert.strictEqual(
			VBA_GOD_2036_BASELINE.before.vbaGodModuleCount,
			VBA_GOD_2036_BASELINE.reducedBy.length +
				files.length +
				VBA_GOD_2036_BASELINE.baseAdvance.resolvedFiles.length,
			"the base count must equal reduced + deferred + resolved after the pinned base",
		);
		assert.strictEqual(
			VBA_GOD_2036_BASELINE.after.vbaGodModuleCount,
			files.length,
			"every file still flagged on the delivered tree is a recorded deferral",
		);
	});

	it("names the per-sibling oracle and the reference doc next to the fixture", () => {
		for (const rel of [
			"test/vba-god-module-refactor-2036.test.mts",
			".pi/skills/audit-codeflow-analysis/references/vba-god-module-2036.md",
		]) {
			assert.ok(existsSync(resolve(HERE, "..", rel)), `missing register artifact: ${rel}`);
		}
	});
});
