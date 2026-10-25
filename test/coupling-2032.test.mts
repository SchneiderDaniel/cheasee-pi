import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { ANALYZER_REF } from "./fixtures/long-file-mirror.mts";

// `N Highly Coupled` is the pinned analyzer's own count over `data.connections`
// (files with more than 8 incoming resolved references), so the delivered
// number is measured, never derived here. This suite replays the record in
// `test/fixtures/coupling-baseline-2032.json` against the tree it was measured
// on and asserts the two source-side levers that produced the drop: a token the
// analyzer can no longer resolve cannot create an edge.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

interface ReducedBy {
	path: string;
	tokens: string[];
	edit: string;
}

const BASELINE = JSON.parse(
	readFileSync(resolve(HERE, "fixtures", "coupling-baseline-2032.json"), "utf-8"),
) as {
	provenance: {
		issue: number;
		ref: string;
		metric: string;
		filedAnalyzedAt: number;
		filedCoupled: number;
	};
	before: {
		commit: string;
		files: number;
		functions: number;
		connections: number;
		coupled: number;
	};
	after: {
		commit: string | null;
		commitNote: string;
		reducedFilesDigest: string;
		files: number;
		functions: number;
		connections: number;
		coupled: number;
		unflagged: string[];
		newlyFlagged: string[];
	};
	reducedBy: ReducedBy[];
	deferred: { reason: string; requires: string }[];
};

const RECORD = resolve(REPO, ".pi/skills/audit-codeflow-analysis/references/coupling-2032.md");

const sha1 = (data: string | Buffer): string => createHash("sha1").update(data).digest("hex");

// A declaration is resolved repo-wide only when it has a single definition, so a
// file that no longer contains the token cannot be the source of an edge.
const tokenRe = (token: string): RegExp =>
	new RegExp(`(^|[^\\w$])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`);

function treeDigest(paths: string[]): string {
	const hash = createHash("sha1");
	for (const rel of [...paths].sort()) {
		hash.update(rel);
		hash.update("\0");
		hash.update(sha1(readFileSync(resolve(REPO, rel))));
		hash.update("\0");
	}
	return hash.digest("hex");
}

describe("coupling baseline (issue #2032)", () => {
	it("records the filing and pins the analyzer the number came from", () => {
		assert.equal(BASELINE.provenance.issue, 2032);
		assert.equal(BASELINE.provenance.filedCoupled, 199, "the issue's filed count");
		assert.equal(BASELINE.provenance.filedAnalyzedAt, 1791804971015);
		assert.equal(BASELINE.provenance.ref, ANALYZER_REF, "one pin owner across the skill records");
		assert.match(BASELINE.provenance.metric, /connections/);
		assert.match(BASELINE.provenance.metric, /> 8/);
		assert.match(BASELINE.provenance.metric, /NOT an import count/);
	});

	it("records a real drop on the delivered tree", () => {
		assert.match(BASELINE.before.commit, /^[0-9a-f]{40}$/);
		assert.match(BASELINE.after.reducedFilesDigest, /^[0-9a-f]{40}$/);
		assert.ok(
			BASELINE.after.coupled < BASELINE.before.coupled,
			"fewer files must exceed the 8-reference ceiling",
		);
		assert.ok(
			BASELINE.after.connections < BASELINE.before.connections,
			"the connection list must shrink, not just the flagged count",
		);
		assert.ok(
			BASELINE.before.coupled - BASELINE.after.coupled >= 5,
			"the record documents a drop worth shipping, not a rounding difference",
		);
		assert.deepEqual(BASELINE.after.newlyFlagged, [], "the change must not couple a new file");
		assert.equal(
			new Set(BASELINE.after.unflagged).size,
			BASELINE.after.unflagged.length,
			"a file is named once",
		);
		assert.equal(
			BASELINE.after.unflagged.length,
			BASELINE.before.coupled - BASELINE.after.coupled,
			"every file the drop accounts for is named",
		);
	});

	it("replays the measurement stamp against the delivered files", () => {
		assert.equal(BASELINE.after.commit, null, "the pipeline commits after this record is written");
		assert.ok(BASELINE.after.commitNote.length > 0, "the missing commit id is explained");
		assert.equal(
			treeDigest(BASELINE.reducedBy.map((entry) => entry.path)),
			BASELINE.after.reducedFilesDigest,
			"the recorded digest must describe the files in this tree",
		);
	});

	it("removed every token whose declaration created the edges", () => {
		for (const entry of BASELINE.reducedBy) {
			const abs = resolve(REPO, entry.path);
			assert.ok(existsSync(abs), `${entry.path} exists`);
			assert.ok(!entry.path.endsWith(".mts"), `${entry.path} is not test-only`);
			assert.ok(entry.tokens.length > 0, `${entry.path} names what it removed`);
			const text = readFileSync(abs, "utf-8");
			for (const token of entry.tokens) {
				assert.ok(!tokenRe(token).test(text), `${entry.path} must not still name ${token}`);
			}
		}
	});

	it("names each reduced file once and leaves the port contracts alone", () => {
		const paths = BASELINE.reducedBy.map((entry) => entry.path);
		assert.equal(new Set(paths).size, paths.length, "no file is claimed twice");
		for (const contract of [
			"cmd/cheasee-pi/config.go",
			"cmd/cheasee-pi/embedded/docker/ui/src/rpc/framing.rs",
			".pi/extensions/lib/proper-lockfile-ambient.ts",
		]) {
			assert.ok(!paths.includes(contract), `${contract} carries a port contract`);
		}
	});

	it("leaves the rest of the metric documented as deferred", () => {
		assert.ok(BASELINE.deferred.length >= 4);
		for (const entry of BASELINE.deferred) {
			assert.ok(entry.reason.length > 0, "a deferral states why");
			assert.ok(entry.requires.length > 0, "a deferral states what would unblock it");
		}
		const text = BASELINE.deferred.map((entry) => `${entry.reason} ${entry.requires}`).join("\n");
		assert.match(text, /cargo/, "the Rust sources are deferred with a cargo requirement");
		assert.match(text, /\.mts/, "test-only phantoms are recorded as unscored");
	});

	it("keeps the production path free of a second metric implementation", () => {
		const runner = readFileSync(
			resolve(REPO, "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs"),
			"utf-8",
		);
		const filter = readFileSync(
			resolve(REPO, "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js"),
			"utf-8",
		);
		// The title can only come from the analyzer's own deriver, and the prune
		// seam is gone: it could not re-title the card the analyzer derives inline.
		for (const [name, text] of [
			["run-analysis.mjs", runner],
			["fp-filter.js", filter],
		] as const) {
			assert.doesNotMatch(text, /Highly Coupled/, `${name} must not spell the card's title`);
			assert.doesNotMatch(text, /pruneCouplingEdges/, `${name} must not carry the prune seam`);
			assert.doesNotMatch(text, /coupledTargetCount/, `${name} must not re-count the ceiling`);
		}
	});

	it("ships the record next to the skill's other metric records", () => {
		assert.ok(existsSync(RECORD), "the reference doc exists");
		const doc = readFileSync(RECORD, "utf-8");
		assert.ok(doc.includes(BASELINE.before.commit), "the doc cites the measured base commit");
		assert.ok(
			doc.includes(BASELINE.after.reducedFilesDigest),
			"the doc cites the delivered-tree stamp",
		);
		assert.match(doc, /not an import count/, "the doc corrects the filing's premise");
		assert.match(doc, /left alone/i, "the doc names what was left alone");
	});
});
