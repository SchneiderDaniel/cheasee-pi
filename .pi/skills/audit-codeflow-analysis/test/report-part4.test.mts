/**
 * Triage policy for derived facts (issue #2030).
 *
 * Split out of `report.test.mts`, which #2035 keeps at or under the 500-segment
 * ceiling. A `suggestions[]` card restates the findings underneath it, so it is
 * narration: it resolves through its source facts and is never filed standalone.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/report-part4.test.mts
 */

import assert from "node:assert";

import { describe, it } from "node:test";

import { classifyFinding, groupIssues, type Disposition, type IssueFact } from "../lib/report.ts";

// Issue #2030. `suggestions[]` is not a finding: each card restates an underlying
// signal (dead code, coupling, a violated layer edge) that already has its own
// fact. Filing it standalone produced file-less issues ("Fix Security Issues")
// whose counts contradicted the export. Triage therefore keeps derived facts as
// narration and resolves them through their source facts.
describe("classifyFinding — derived facts (issue #2030, Phase 5)", () => {
	const fact = (kind: string, title: string): IssueFact => ({
		id: `${kind}:0`,
		kind,
		title,
		targets: [{ kind: "symbol", name: title }],
		files: [],
	});

	it("routes a suggestion to derived/link-derived with the exact reason", () => {
		assert.deepStrictEqual(classifyFinding(fact("suggestion", "Fix Security Issues")), {
			issueType: "derived",
			disposition: "link-derived",
			reason: "derived aggregate — resolves through its source facts; never filed standalone",
		});
	});

	it("never puts a suggestion in bug scope, whatever its title looks like", () => {
		for (const title of [
			"Hardcoded Secret",
			"81 Large Files",
			"157 Architecture Violations",
			"Resolve Naming Conflicts",
		]) {
			const r = classifyFinding(fact("suggestion", title));
			assert.strictEqual(r.issueType, "derived", title);
			assert.strictEqual(r.disposition, "link-derived", title);
		}
	});

	it("keeps every other kind where it was", () => {
		for (const kind of ["security", "dead-code", "duplicate", "layer-violation", "architecture"]) {
			assert.strictEqual(classifyFinding(fact(kind, "x")).issueType, "bug", kind);
		}
		assert.strictEqual(classifyFinding(fact("pattern", "Singleton")).issueType, "informational");
		assert.strictEqual(classifyFinding(fact("anti-pattern", "God Object")).issueType, "chore");
		assert.strictEqual(classifyFinding(fact("mystery", "x")).issueType, "out-of-scope");
	});

	it("returns union members only, deterministically", () => {
		const allowed: Disposition[] = [
			"file-bug",
			"file-refactor",
			"offer-optional",
			"drop",
			"link-derived",
		];
		const all = [
			fact("suggestion", "Fix Security Issues"),
			fact("architecture", "157 Architecture Violations"),
			fact("pattern", "Singleton"),
			fact("anti-pattern", "God Object"),
			fact("mystery", "x"),
		];
		for (const f of all) {
			const a = classifyFinding(f);
			assert.deepStrictEqual(a, classifyFinding(f));
			assert.ok(allowed.includes(a.disposition), `${f.kind} → ${a.disposition}`);
			assert.ok(a.reason.length > 0);
		}
	});

	it("still groups a file-less derived fact as one isolated group", () => {
		const suggestion = fact("suggestion", "Remove Dead Code");
		const groups = groupIssues([suggestion]);
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].isolated, true);
		assert.deepStrictEqual(groups[0].issues, [suggestion]);
		assert.deepStrictEqual(groups[0].overlaps, [], "a file-less fact claims no path");
	});
});
