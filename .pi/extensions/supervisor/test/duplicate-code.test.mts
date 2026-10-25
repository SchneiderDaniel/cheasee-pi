/**
 * Tests for checks/duplicate-code.ts — pre-audit duplicate detection gate
 *
 * Pure function tests for DuplicateCodeResult interface, filter logic,
 * jscpd type mapping, and runDuplicateCheck orchestration.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/duplicate-code.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	type DuplicateCodeResult,
	type JscpdClone,
	type JscpdOutput,
	type NormalizedClone,
	filterClonesToChangedFiles,
	mapJscpdType,
	sumDuplicateLines,
	buildResult,
} from "../checks/duplicate-code.ts";
import type { ExecFn } from "../checks/shared.ts";
import { makeClone } from "./duplicate-code-harness.mts";
// ═══════════════════════════════════════════════════════════════════════
// Domain: Interface shape
// ═══════════════════════════════════════════════════════════════════════

describe("DuplicateCodeResult interface", () => {
	it("status field accepts all 4 literal string values", () => {
		const clean: DuplicateCodeResult = {
			status: "clean",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
		};
		const found: DuplicateCodeResult = {
			status: "duplicates_found",
			clones: [],
			totalDuplicateLines: 10,
			changedFilesScanned: [],
		};
		const error: DuplicateCodeResult = {
			status: "error",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
		};
		const noJscpd: DuplicateCodeResult = {
			status: "no_jscpd",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
		};

		assert.equal(clean.status, "clean");
		assert.equal(found.status, "duplicates_found");
		assert.equal(error.status, "error");
		assert.equal(noJscpd.status, "no_jscpd");
	});

	it("clones array items have correct shape", () => {
		const result: DuplicateCodeResult = {
			status: "duplicates_found",
			clones: [
				{
					type: "exact",
					lines: 10,
					similarity: 100,
					locations: [
						{ file: "src/a.ts", startLine: 1, endLine: 10 },
						{ file: "src/b.ts", startLine: 20, endLine: 29 },
					],
				},
			],
			totalDuplicateLines: 20,
			changedFilesScanned: ["src/a.ts"],
		};

		assert.equal(result.clones.length, 1);
		assert.equal(result.clones[0]!.type, "exact");
		assert.equal(result.clones[0]!.lines, 10);
		assert.equal(result.clones[0]!.similarity, 100);
		assert.equal(result.clones[0]!.locations.length, 2);
		assert.equal(result.clones[0]!.locations[0]!.file, "src/a.ts");
		assert.equal(result.clones[0]!.locations[0]!.startLine, 1);
		assert.equal(result.clones[0]!.locations[0]!.endLine, 10);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: filterClonesToChangedFiles
// ═══════════════════════════════════════════════════════════════════════

describe("filterClonesToChangedFiles()", () => {
	it("keeps clone with location in changed files", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/c.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, ["src/a.ts"]);
		assert.equal(filtered.length, 1);
		assert.equal(filtered[0]!.locations[0]!.file, "src/a.ts");
	});

	it("drops clone with no location in changed files", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/b.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, ["src/c.ts"]);
		assert.equal(filtered.length, 0);
	});

	it("keeps clone when at least one location is in changed files (one in, one out)", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/b.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, ["src/b.ts"]);
		assert.equal(filtered.length, 1);
	});

	it("returns empty array when no clones provided", () => {
		const filtered = filterClonesToChangedFiles([], ["src/a.ts"]);
		assert.equal(filtered.length, 0);
	});

	it("returns empty array when changed files list is empty", () => {
		const clones = [
			makeClone({
				files: [{ name: "src/a.ts", startLine: 1, endLine: 10 }],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, []);
		assert.equal(filtered.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: mapJscpdType
// ═══════════════════════════════════════════════════════════════════════

describe("mapJscpdType()", () => {
	it("maps type 1 to 'exact'", () => {
		assert.equal(mapJscpdType(1), "exact");
	});

	it("maps type 2 to 'renamed'", () => {
		assert.equal(mapJscpdType(2), "renamed");
	});

	it("maps type 3 to 'near-miss'", () => {
		assert.equal(mapJscpdType(3), "near-miss");
	});

	it("maps any other number to 'near-miss' (graceful fallback)", () => {
		assert.equal(mapJscpdType(0), "near-miss");
		assert.equal(mapJscpdType(4), "near-miss");
		assert.equal(mapJscpdType(-1), "near-miss");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: similarity lookup keyed by normalized type (via normalizeClone)
// ═══════════════════════════════════════════════════════════════════════

describe("similarity via filterClonesToChangedFiles()", () => {
	// SIMILARITY_BY_TYPE is module-private; exercise through the public
	// normalize path (filterClonesToChangedFiles → normalizeClone).
	const normalizeOne = (clone: JscpdClone): NormalizedClone => {
		const [normalized] = filterClonesToChangedFiles([clone], ["src/a.ts"]);
		assert.ok(normalized, "clone should pass the changed-file filter");
		return normalized;
	};

	it("type 1 → { type: 'exact', similarity: 100 }", () => {
		assert.deepEqual(normalizeOne(makeClone({ type: 1 })), {
			type: "exact",
			lines: 10,
			similarity: 100,
			locations: [{ file: "src/a.ts", startLine: 1, endLine: 10 }],
		});
	});

	it("type 2 → { type: 'renamed', similarity: 90 }", () => {
		assert.deepEqual(normalizeOne(makeClone({ type: 2 })), {
			type: "renamed",
			lines: 10,
			similarity: 90,
			locations: [{ file: "src/a.ts", startLine: 1, endLine: 10 }],
		});
	});

	it("type 3 → { type: 'near-miss', similarity: 70 }", () => {
		assert.deepEqual(normalizeOne(makeClone({ type: 3 })), {
			type: "near-miss",
			lines: 10,
			similarity: 70,
			locations: [{ file: "src/a.ts", startLine: 1, endLine: 10 }],
		});
	});

	it("out-of-range types 0, 4, -1 → { type: 'near-miss', similarity: 70 }", () => {
		for (const type of [0, 4, -1]) {
			const normalized = normalizeOne(makeClone({ type }));
			assert.equal(normalized.type, "near-miss");
			assert.equal(normalized.similarity, 70);
		}
	});

	it("clone without type field → { type: 'near-miss', similarity: 70 } (real jscpd shape)", () => {
		// Real jscpd output sets no numeric type; makeClone's `?? 1` cannot
		// produce undefined, so build the literal inline.
		const noTypeClone = {
			id: "clone-no-type",
			format: "typescript",
			lines: 10,
			tokens: 50,
			fragments: [{ fragment: "code fragment", file: "src/a.ts", start: 1, end: 10 }],
		} as unknown as JscpdClone;
		const normalized = normalizeOne(noTypeClone);
		assert.equal(normalized.type, "near-miss");
		assert.equal(normalized.similarity, 70);
	});

	it("lockstep: (type, similarity) pairs match the SIMILARITY_BY_TYPE partitions for all inputs", () => {
		const expected: Array<[number | undefined, string, number]> = [
			[1, "exact", 100],
			[2, "renamed", 90],
			[3, "near-miss", 70],
			[0, "near-miss", 70],
			[4, "near-miss", 70],
			[-1, "near-miss", 70],
			[undefined, "near-miss", 70],
		];
		for (const [type, label, similarity] of expected) {
			const clone =
				type === undefined
					? ({
							id: "clone-no-type",
							format: "typescript",
							lines: 10,
							tokens: 50,
							fragments: [{ fragment: "code fragment", file: "src/a.ts", start: 1, end: 10 }],
						} as unknown as JscpdClone)
					: makeClone({ type });
			const normalized = normalizeOne(clone);
			assert.equal(normalized.type, label, `type ${String(type)} → label`);
			assert.equal(normalized.similarity, similarity, `type ${String(type)} → similarity`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: sumDuplicateLines
// ═══════════════════════════════════════════════════════════════════════

describe("sumDuplicateLines()", () => {
	it("sums endLine - startLine + 1 across all clone locations", () => {
		const clones: DuplicateCodeResult["clones"] = [
			{
				type: "exact",
				lines: 10,
				similarity: 100,
				locations: [
					{ file: "a.ts", startLine: 1, endLine: 10 },
					{ file: "b.ts", startLine: 20, endLine: 29 },
					{ file: "c.ts", startLine: 5, endLine: 14 },
				],
			},
			{
				type: "renamed",
				lines: 5,
				similarity: 90,
				locations: [{ file: "d.ts", startLine: 1, endLine: 5 }],
			},
		];
		// Clone 1: (10-1+1) + (29-20+1) + (14-5+1) = 10 + 10 + 10 = 30
		// Clone 2: (5-1+1) = 5
		// Total: 35
		assert.equal(sumDuplicateLines(clones), 35);
	});

	it("returns 0 for empty clones array", () => {
		assert.equal(sumDuplicateLines([]), 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: buildResult
// ═══════════════════════════════════════════════════════════════════════

describe("buildResult()", () => {
	it("builds 'clean' result when no clones pass filter", () => {
		const result = buildResult([], ["src/a.ts"]);
		assert.equal(result.status, "clean");
		assert.equal(result.clones.length, 0);
		assert.equal(result.totalDuplicateLines, 0);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts"]);
	});

	it("builds 'duplicates_found' result when clone passes filter", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/b.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		// Use filterClonesToChangedFiles to get normalized clones
		const filtered = filterClonesToChangedFiles(clones, ["src/a.ts"]);
		const result = buildResult(filtered, ["src/a.ts"]);
		assert.equal(result.status, "duplicates_found");
		assert.equal(result.clones.length, 1);
		assert.equal(result.clones[0]!.type, "exact");
		assert.equal(result.clones[0]!.lines, 10);
		assert.equal(result.clones[0]!.similarity, 100);
		assert.ok(result.totalDuplicateLines > 0);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts"]);
	});
});
