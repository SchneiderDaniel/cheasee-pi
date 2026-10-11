/**
 * Two-snapshot acceptance for the deterministic known-FP pre-filter (issue
 * #2014).
 *
 * Acceptance criterion: the fast path resolves ≥70% of the recurring INVALID
 * shapes (rows 5/8/10/11 + duplicate/similar-code/suggestion/zero-file) on TWO
 * unrelated repository snapshots, without ever losing a real bug.
 *
 * The snapshots are recorded fixture sets (candidate + the repo evidence the
 * rules would have read + the expected outcome), replayed through a faked
 * `RepoPort`. The second snapshot cannot be checked out in CI, so the recorded
 * replay is the CI form of the criterion; the "no VALID lost" LLM re-check stays
 * a documented run-time acceptance step (`manualAcceptance` in each fixture).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/fast-path-acceptance.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
	FAST_PATH_RULES,
	evaluateFastPath,
	type Declaration,
	type Match,
	type RepoPort,
} from "../lib/fast-path.ts";
import type { IssueFact } from "../lib/report.ts";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures", "fast-path");

interface RecordedPort {
	files?: Record<string, string>;
	declarations?: Record<string, Declaration[]>;
	grep?: Record<string, Match[]>;
}

interface Candidate {
	finding: IssueFact;
	port: RecordedPort;
	expected: { verdict: "INVALID" | "defer"; row?: number; ruleId?: string; note?: string };
}

interface Snapshot {
	name: string;
	provenance: string;
	manualAcceptance: string;
	sharedWith: string;
	candidates: Candidate[];
}

function load(name: string): Snapshot {
	return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf-8")) as Snapshot;
}

/** Replay the recorded evidence as a `RepoPort`; missing evidence is absent. */
function replayPort(record: RecordedPort): RepoPort {
	const files = record.files ?? {};
	const declarations = record.declarations ?? {};
	const greps = record.grep ?? {};
	return {
		readFile: (path) => (path in files ? (files[path] as string) : null),
		findDeclarations: (symbol) => declarations[symbol] ?? [],
		grep: (pattern) => greps[pattern] ?? [],
	};
}

const SNAPSHOTS = [load("snapshot-a"), load("snapshot-b")];

/** Every path a candidate names, from its targets and its evidence. */
function pathsOf(snapshot: Snapshot): Set<string> {
	const out = new Set<string>();
	for (const { finding, port } of snapshot.candidates) {
		for (const path of finding.files) out.add(path);
		for (const target of finding.targets) {
			if (target.kind === "file") out.add(target.path);
		}
		for (const path of Object.keys(port.files ?? {})) out.add(path);
		for (const matches of Object.values(port.grep ?? {})) {
			for (const match of matches) out.add(match.file);
		}
		for (const decls of Object.values(port.declarations ?? {})) {
			for (const decl of decls) out.add(decl.file);
		}
	}
	return out;
}

/** Every symbol a candidate names. */
function symbolsOf(snapshot: Snapshot): Set<string> {
	const out = new Set<string>();
	for (const { finding, port } of snapshot.candidates) {
		const paren = /^(?:[A-Za-z][A-Za-z ]*:\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\(\)$/.exec(finding.title.trim());
		if (paren) out.add(paren[1] as string);
		const label = /^[A-Za-z][A-Za-z ]*:\s*([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(finding.title.trim());
		if (label) out.add(label[1] as string);
		for (const target of finding.targets) {
			if (target.kind === "symbol") out.add(target.name);
		}
		for (const symbol of Object.keys(port.declarations ?? {})) out.add(symbol);
		for (const symbol of Object.keys(port.grep ?? {})) out.add(symbol);
	}
	return out;
}

describe("fast-path acceptance — two unrelated snapshots", () => {
	it("records two snapshots that share no path and no symbol", () => {
		assert.strictEqual(SNAPSHOTS.length, 2);
		const [a, b] = SNAPSHOTS as [Snapshot, Snapshot];
		assert.ok(a.candidates.length >= 10, `snapshot A must be substantive, got ${a.candidates.length}`);
		assert.ok(b.candidates.length >= 10, `snapshot B must be substantive, got ${b.candidates.length}`);
		for (const path of pathsOf(a)) {
			assert.ok(!pathsOf(b).has(path), `the snapshots must be unrelated but share the path ${path}`);
		}
		for (const symbol of symbolsOf(a)) {
			assert.ok(!symbolsOf(b).has(symbol), `the snapshots must be unrelated but share ${symbol}`);
		}
		for (const snapshot of SNAPSHOTS) {
			assert.match(snapshot.manualAcceptance, /LLM re-check/i);
			assert.match(snapshot.manualAcceptance, /residual risk/i);
			assert.ok(snapshot.provenance.length > 40, "a recorded snapshot must state its provenance");
		}
	});

	for (const snapshot of SNAPSHOTS) {
		describe(`${snapshot.name} — recorded replay`, () => {
			it("resolves at least 70% of the candidates deterministically", async () => {
				let invalid = 0;
				for (const { finding, port } of snapshot.candidates) {
					const verdict = await evaluateFastPath(finding, replayPort(port));
					if (verdict !== null) invalid++;
				}
				const ratio = invalid / snapshot.candidates.length;
				assert.ok(
					ratio >= 0.7,
					`expected >=70% INVALID, got ${invalid}/${snapshot.candidates.length} (${Math.round(ratio * 100)}%)`,
				);
			});

			it("emits exactly the expected verdict for every candidate (no wrong-rule coverage)", async () => {
				for (const { finding, port, expected } of snapshot.candidates) {
					const verdict = await evaluateFastPath(finding, replayPort(port));
					if (expected.verdict === "defer") {
						assert.strictEqual(
							verdict,
							null,
							`${finding.id} (${finding.title}) must defer${expected.note ? ` — ${expected.note}` : ""}`,
						);
						continue;
					}
					assert.ok(verdict, `${finding.id} (${finding.title}) must be INVALID, got a deferral`);
					assert.strictEqual(verdict.verdict, "INVALID");
					assert.strictEqual(verdict.row, expected.row, `${finding.id} must resolve through row ${expected.row}`);
					assert.strictEqual(verdict.ruleId, expected.ruleId, `${finding.id} must resolve through its own rule`);
					assert.ok(verdict.reason.length > 0 && verdict.evidence.length > 0);
				}
			});

			it("never loses a planted real bug and never drops a candidate verdict-less", async () => {
				let invalid = 0;
				let deferred = 0;
				for (const { finding, port, expected } of snapshot.candidates) {
					const verdict = await evaluateFastPath(finding, replayPort(port));
					if (verdict === null) {
						deferred++;
						assert.notStrictEqual(
							expected.verdict,
							"INVALID",
							`${finding.id} is a real bug and must never be INVALID`,
						);
						continue;
					}
					invalid++;
					// There is no VALID member to produce: every non-null verdict is INVALID
					// and only a proven mechanism yields one.
					assert.strictEqual(verdict.verdict, "INVALID");
					assert.ok(REACHABLE_ROWS.has(verdict.row), `row ${verdict.row} must be a documented rule`);
				}
				assert.strictEqual(
					invalid + deferred,
					snapshot.candidates.length,
					"every candidate must carry exactly one outcome",
				);
				const planted = snapshot.candidates.filter((c) => c.expected.note !== undefined);
				assert.ok(planted.length > 0, "each snapshot must plant a real bug the rules must not drop");
			});

			it("splits by rule exactly as the recorded expectations declare", async () => {
				const observed = new Map<string, number>();
				for (const { finding, port } of snapshot.candidates) {
					const verdict = await evaluateFastPath(finding, replayPort(port));
					if (verdict) observed.set(verdict.ruleId, (observed.get(verdict.ruleId) ?? 0) + 1);
				}
				const expected = new Map<string, number>();
				for (const candidate of snapshot.candidates) {
					const ruleId = candidate.expected.ruleId;
					if (ruleId) expected.set(ruleId, (expected.get(ruleId) ?? 0) + 1);
				}
				assert.deepStrictEqual(
					[...observed.entries()].sort(),
					[...expected.entries()].sort(),
					"the rule breakdown must match the recorded expectations",
				);
			});
		});
	}

	it("covers every fast-path row across the two snapshots", async () => {
		const rows = new Set<number>();
		for (const snapshot of SNAPSHOTS) {
			for (const { finding, port } of snapshot.candidates) {
				const verdict = await evaluateFastPath(finding, replayPort(port));
				if (verdict) rows.add(verdict.row);
			}
		}
		for (const { row } of FAST_PATH_RULES) {
			assert.ok(rows.has(row), `the acceptance fixture set must exercise row ${row}`);
		}
	});

	it("is deterministic across replays", async () => {
		for (const snapshot of SNAPSHOTS) {
			for (const { finding, port } of snapshot.candidates) {
				const first = await evaluateFastPath(finding, replayPort(port));
				const second = await evaluateFastPath(finding, replayPort(port));
				assert.deepStrictEqual(first, second, `${finding.id} must replay identically`);
			}
		}
	});
});

/** The rows a verdict may legitimately name. */
const REACHABLE_ROWS = new Set(FAST_PATH_RULES.map((r) => r.row));
