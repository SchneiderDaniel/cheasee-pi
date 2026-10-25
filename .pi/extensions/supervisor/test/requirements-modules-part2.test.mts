/**
 * Tests for the split checks/requirements/ modules — seam-level proof
 * that each extracted module preserves its behavior, plus orchestrator
 * contract tests (early-return semantics, runStep error strings, gap
 * order) and the shim public-surface contract.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/requirements-modules.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ExecFn } from "../checks/shared.ts";
import { checkOldReferenceCleanup } from "../checks/requirements/cleanup.ts";
import { checkTestFileParity } from "../checks/requirements/parity.ts";
import {
	runRequirementsTraceability,
	type TraceabilityGap,
	type FilteredIssueData,
} from "../checks/requirements-traceability.ts";

// ═══════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════

function mockDiffExec(lines: string[]): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "grep") return { code: 1, stdout: "", stderr: "" };
		if (cmd === "git" && args.includes("grep")) return { code: 1, stdout: "", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
}

function createTempDir(prefix: string, files: Record<string, string>): string {
	const baseDir = join(process.cwd(), "ignore");
	const tempDir = join(baseDir, `rt-mod-${prefix}-${Date.now()}`);
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = join(tempDir, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}
	return tempDir;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: shim public-surface contract
// ═══════════════════════════════════════════════════════════════════════

// Split from requirements-modules.test.mts (issue #2035 Long File refactor).
describe("cleanup.ts checkOldReferenceCleanup", () => {
	it("D with refs → exact detail", async () => {
		const exec: ExecFn = async () => ({ code: 0, stdout: "src/remaining.ts\n", stderr: "" });
		const gaps = await checkOldReferenceCleanup(exec, "/fake/worktree", [
			{ status: "D", path: "docs/deleted-guide.md" },
		]);
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]!.check, "old-reference-cleanup");
		assert.equal(
			gaps[0]!.detail,
			'Deleted/renamed file "docs/deleted-guide.md" still referenced in 1 file(s): src/remaining.ts',
		);
	});

	it(">5 files → truncation suffix", async () => {
		const files = [
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
			"src/f.ts",
			"src/g.ts",
		];
		const exec: ExecFn = async () => ({ code: 0, stdout: files.join("\n") + "\n", stderr: "" });
		const gaps = await checkOldReferenceCleanup(exec, "/fake/worktree", [
			{ status: "D", path: "docs/deleted-guide.md" },
		]);
		assert.equal(gaps.length, 1);
		assert.ok(
			gaps[0]!.detail.includes(
				"still referenced in 7 file(s): src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts... and 2 more",
			),
		);
	});

	it("no refs (git grep code 1) → []", async () => {
		const exec = mockDiffExec([]);
		const gaps = await checkOldReferenceCleanup(exec, "/fake/worktree", [
			{ status: "D", path: "docs/deleted-guide.md" },
		]);
		assert.deepEqual(gaps, []);
	});

	it("no D/R entries → []", async () => {
		const exec = mockDiffExec([]);
		assert.deepEqual(await checkOldReferenceCleanup(exec, "/fake/worktree", []), []);
		assert.deepEqual(
			await checkOldReferenceCleanup(exec, "/fake/worktree", [
				{ status: "A", path: "src/new.ts" },
				{ status: "M", path: "src/mod.ts" },
			]),
			[],
		);
	});

	it("git grep throw → non-fatal, no gap", async () => {
		const exec: ExecFn = async () => {
			throw new Error("git grep exploded");
		};
		const gaps = await checkOldReferenceCleanup(exec, "/fake/worktree", [
			{ status: "D", path: "docs/deleted-guide.md" },
		]);
		assert.deepEqual(gaps, []);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: parity.ts (real temp dirs)
// ═══════════════════════════════════════════════════════════════════════

describe("parity.ts checkTestFileParity", () => {
	const cases: Array<{ name: string; files: Record<string, string>; changed: string[] }> = [
		{ name: "test/foo.test.ts", files: { "test/foo.test.ts": "" }, changed: ["src/foo.ts"] },
		{
			name: "test/sub/foo.test.ts subdir mirror",
			files: { "test/sub/foo.test.ts": "" },
			changed: ["src/sub/foo.ts"],
		},
		{
			name: "tests/foo.test.ts variant",
			files: { "tests/foo.test.ts": "" },
			changed: ["src/foo.ts"],
		},
		{
			name: "test/foo.spec.ts variant",
			files: { "test/foo.spec.ts": "" },
			changed: ["src/foo.ts"],
		},
		{
			name: "test/foo.test.mts variant",
			files: { "test/foo.test.mts": "" },
			changed: ["src/foo.ts"],
		},
		{
			name: "src-relative mirror test/foo.ts",
			files: { "test/foo.ts": "" },
			changed: ["src/foo.ts"],
		},
		{
			name: "non-src lib/foo.ts → test/lib/foo.test.ts",
			files: { "test/lib/foo.test.ts": "" },
			changed: ["lib/foo.ts"],
		},
	];

	for (const c of cases) {
		it(`${c.name} → no gap`, async () => {
			const tempDir = createTempDir("parity-boundary", c.files);
			try {
				const gaps = await checkTestFileParity(c.changed, tempDir);
				assert.deepEqual(gaps, []);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	}

	it("missing test → warning gap with expected paths", async () => {
		const tempDir = createTempDir("parity-missing", { "src/foo.ts": "" });
		try {
			const gaps = await checkTestFileParity(["src/foo.ts"], tempDir);
			assert.equal(gaps.length, 1);
			assert.equal(gaps[0]!.severity, "warning");
			assert.ok(
				gaps[0]!.detail.startsWith(
					'Source file "src/foo.ts" has no corresponding test file. Expected one of: test/foo.test.ts, test/foo.test.mts, test/foo.spec.ts',
				),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("empty changedFiles → []", async () => {
		assert.deepEqual(await checkTestFileParity([], "/fake/worktree"), []);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: orchestrator contract via shim
// ═══════════════════════════════════════════════════════════════════════

describe("runRequirementsTraceability orchestrator contract", () => {
	it("step-1 diff failure → exactly one diff gap (early return), exact-array", async () => {
		const exec: ExecFn = async () => ({
			code: 1,
			stdout: "",
			stderr: "fatal: not a git repository",
		});
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "## Tasks\n- [ ] Something", comments: [] },
			"add something",
		);
		assert.deepEqual(result, [
			{
				check: "diff",
				severity: "warning",
				detail: "git diff failed: fatal: not a git repository",
			},
		]);
	});

	it("step-1 empty stderr → 'unknown error', length 1", async () => {
		const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "" });
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		assert.deepEqual(result, [
			{ check: "diff", severity: "warning", detail: "git diff failed: unknown error" },
		]);
	});

	it("step-1 throw → 'git diff failed: boom', length 1", async () => {
		const exec: ExecFn = async () => {
			throw new Error("boom");
		};
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		assert.deepEqual(result, [
			{ check: "diff", severity: "warning", detail: "git diff failed: boom" },
		]);
	});

	it("internal-catch: exec throws on grep → no 'check failed' error gaps", async () => {
		// Coverage path: A src file with checklist; grep throws → swallowed in coverage,
		// so the item is reported unmatched (pre-split semantics) but no error gap fires.
		const coverageExec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
				return { code: 0, stdout: "A src/auth.ts", stderr: "" };
			}
			throw new Error("grep exploded");
		};
		const tempDir = createTempDir("int-catch-cov", { "test/auth.test.ts": "" });
		try {
			const result = await runRequirementsTraceability(
				coverageExec,
				tempDir,
				"main",
				{ body: "## Tasks\n- [ ] Add user authentication flow", comments: [] },
				"add auth",
			);
			assert.equal(result.filter((g) => g.check === "checklist-keyword-coverage").length, 1);
			assert.equal(
				result.some((g) => g.detail.startsWith("Checklist keyword check failed")),
				false,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}

		// Cleanup path: D file; git grep throws → swallowed in cleanup → no gaps at all.
		const cleanupExec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
				return { code: 0, stdout: "D docs/old.md", stderr: "" };
			}
			throw new Error("git grep exploded");
		};
		const result2 = await runRequirementsTraceability(
			cleanupExec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		assert.deepEqual(result2, []);
	});

	it("runStep error strings: non-string body → checklist gap AND later checks still run", async () => {
		const tempDir = createTempDir("runstep-body", { "src/uncovered.ts": "" });
		try {
			const exec = mockDiffExec(["A src/uncovered.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: 42 as unknown as string, comments: [] },
				"",
			);
			const checklistGap = result.find((g) => g.check === "checklist-keyword-coverage");
			assert.ok(checklistGap);
			assert.equal(
				checklistGap!.detail,
				"Checklist keyword check failed: body.trim is not a function",
			);
			// Later checks still ran: parity fired for the testable src file.
			assert.ok(result.some((g) => g.check === "test-file-parity"));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runStep error strings: non-string title → title-diff-direction gap", async () => {
		const result = await runRequirementsTraceability(
			mockDiffExec([]),
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			42 as unknown as string,
		);
		assert.deepEqual(result, [
			{
				check: "title-diff-direction",
				severity: "warning",
				detail: "Title-diff direction check failed: title.trim is not a function",
			},
		]);
	});

	it("gap order: all-checks case → checklist, parity, cleanup, title", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
				return {
					code: 0,
					stdout: "A src/uncovered.ts\nD docs/old.md\nD docs/another.md",
					stderr: "",
				};
			}
			if (cmd === "git" && args.includes("grep")) {
				return { code: 0, stdout: "src/remaining.ts\n", stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "" };
		};
		const tempDir = createTempDir("gap-order", { "src/uncovered.ts": "" });
		try {
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "## Tasks\n- [ ] Build X-5000 controller", comments: [] },
				"add new controller",
			);
			assert.deepEqual(
				result.map((g) => g.check),
				[
					"checklist-keyword-coverage",
					"test-file-parity",
					"old-reference-cleanup",
					"old-reference-cleanup",
					"title-diff-direction",
				],
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("gate: H3 Reproduction Steps items produce no checklist gap (issue symptom)", async () => {
		const exec = mockDiffExec(["A README.md"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "### Reproduction Steps\n- [ ] install deps", comments: [] },
			"",
		);
		assert.deepEqual(result, []);
	});

	it("gate: mixed H3/H1 excluded + H2 included → only Tasks item gap", async () => {
		const exec = mockDiffExec(["A README.md"]);
		const body =
			"### Prerequisites\n- [ ] Clone repo\n\n# Setup\n- [ ] Configure env\n\n## Tasks\n- [ ] Build feature";
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body, comments: [] },
			"",
		);
		const gaps = result.filter((g) => g.check === "checklist-keyword-coverage");
		assert.equal(gaps.length, 1);
		assert.ok(gaps[0]!.detail.includes('"Build feature"'));
	});

	it("gate: H2-only body gap output is byte-identical (regression)", async () => {
		const exec = mockDiffExec(["A README.md"]);
		const body =
			"## Prerequisites\n- [ ] Clone repo\n## Setup\n- [ ] Configure env\n## Tasks\n- [ ] Build feature";
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body, comments: [] },
			"",
		);
		assert.deepEqual(result, [
			{
				check: "checklist-keyword-coverage",
				severity: "warning",
				detail:
					'Checklist item "Build feature" — no keywords matched in changed files. Keywords checked: Build, feature',
			},
		]);
	});
});
