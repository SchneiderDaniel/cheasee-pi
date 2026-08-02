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
import {
	parseIssueBodyChecklists,
	extractChecklistKeywords,
} from "../checks/requirements/parse.ts";
import {
	extractTitleVerb,
	classifyDiffDirection,
	checkTitleDiffDirection,
} from "../checks/requirements/title.ts";
import { getGitDiff } from "../checks/requirements/diff.ts";
import { checkChecklistKeywordCoverage } from "../checks/requirements/coverage.ts";
import { checkOldReferenceCleanup } from "../checks/requirements/cleanup.ts";
import { checkTestFileParity } from "../checks/requirements/parity.ts";
import {
	runRequirementsTraceability,
	parseIssueBodyChecklists as shimParse,
	extractTitleVerb as shimTitleVerb,
	extractChecklistKeywords as shimKeywords,
	classifyDiffDirection as shimClassify,
	isTestableFile,
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

describe("requirements-traceability shim surface", () => {
	it("all 8 historical names are reachable through the shim", () => {
		assert.equal(typeof runRequirementsTraceability, "function");
		assert.equal(typeof shimParse, "function");
		assert.equal(typeof shimTitleVerb, "function");
		assert.equal(typeof shimKeywords, "function");
		assert.equal(typeof shimClassify, "function");
		assert.equal(typeof isTestableFile, "function");
		// Types TraceabilityGap / FilteredIssueData are compile-time only (tsc proves shape).
		const gap: TraceabilityGap = { check: "x", severity: "warning", detail: "y" };
		const data: FilteredIssueData = { body: "", comments: [] };
		assert.equal(gap.check, "x");
		assert.equal(data.body, "");
	});

	it("shim re-exports behave identically to module implementations", () => {
		assert.deepEqual(
			shimParse("## Tasks\n- [ ] Add login"),
			parseIssueBodyChecklists("## Tasks\n- [ ] Add login"),
		);
		assert.equal(shimTitleVerb("feat: add login"), extractTitleVerb("feat: add login"));
		assert.deepEqual(
			shimKeywords([{ text: "Add login", checked: false }]),
			extractChecklistKeywords([{ text: "Add login", checked: false }]),
		);
		assert.equal(
			shimClassify("add login", ["A src/login.ts"]),
			classifyDiffDirection("add login", ["A src/login.ts"]),
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: parse.ts (pure)
// ═══════════════════════════════════════════════════════════════════════

describe("parse.ts", () => {
	it("empty body → []", () => {
		assert.deepEqual(parseIssueBodyChecklists(""), []);
		assert.deepEqual(parseIssueBodyChecklists("   "), []);
	});

	it("excludes items under Prerequisites/Setup headings", () => {
		const body =
			"## Prerequisites\n- [ ] Clone repo\n## Setup\n- [ ] Configure env\n## Tasks\n- [ ] Build feature";
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.text, "Build feature");
	});

	it("handles -, *, + bullets", () => {
		const body = "## Tasks\n- [ ] Dash\n* [ ] Star\n+ [ ] Plus";
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 3);
		assert.deepEqual(
			result.map((i) => i.text),
			["Dash", "Star", "Plus"],
		);
	});

	it("extractChecklistKeywords strips markdown artifacts", () => {
		const items = [
			{ text: "Add `login()` function", checked: false },
			{ text: "**Bold task**", checked: false },
			{ text: "See [docs](https://example.com)", checked: false },
		];
		const result = extractChecklistKeywords(items);
		assert.ok(result[0]!.keywords.some((k) => k.startsWith("login")));
		assert.ok(result[1]!.keywords.some((k) => k === "Bold"));
		assert.ok(result[2]!.keywords.some((k) => k === "docs"));
	});

	it("extractChecklistKeywords([]) → []", () => {
		assert.deepEqual(extractChecklistKeywords([]), []);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: title.ts (pure)
// ═══════════════════════════════════════════════════════════════════════

describe("title.ts", () => {
	it("extractTitleVerb: colon-prefix boundaries", () => {
		assert.equal(extractTitleVerb("feat: add login"), "add");
		assert.equal(extractTitleVerb("ADD: x"), "add");
		assert.equal(extractTitleVerb("feat: remove legacy"), "remove");
		assert.equal(extractTitleVerb("add: new feature"), "add");
	});

	it("classifyDiffDirection: A/D/M cases", () => {
		assert.equal(
			classifyDiffDirection("add login", ["A src/login.ts", "M src/index.ts"]),
			"additions",
		);
		assert.equal(classifyDiffDirection("remove old-api", ["D src/old-api.ts"]), "deletions");
		assert.equal(
			classifyDiffDirection("migrate from X to Y", ["D src/X.ts", "A src/Y.ts"]),
			"deletions",
		);
		assert.equal(classifyDiffDirection("fix bug", ["M src/bug.ts"]), null);
		assert.equal(classifyDiffDirection(null, ["A src/f.ts"]), null);
	});

	it("checkTitleDiffDirection: A>D no gap", () => {
		const gaps = checkTitleDiffDirection("add", "add new feature", [
			{ status: "A", path: "src/a.ts" },
			{ status: "D", path: "src/b.ts" },
		]);
		assert.deepEqual(gaps, []);
	});

	it("checkTitleDiffDirection: D>A info gap with exact detail", () => {
		const gaps = checkTitleDiffDirection("add", "add new feature", [
			{ status: "D", path: "src/a.ts" },
			{ status: "D", path: "src/b.ts" },
			{ status: "A", path: "src/c.ts" },
		]);
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]!.severity, "info");
		assert.equal(
			gaps[0]!.detail,
			'Issue title suggests "additions" but diff has net deletions (+1A, -2D). Verify this is intentional.',
		);
	});

	it("checkTitleDiffDirection: ambiguous title → no gap", () => {
		const gaps = checkTitleDiffDirection("add", "add and remove things", [
			{ status: "A", path: "src/a.ts" },
			{ status: "D", path: "src/b.ts" },
		]);
		assert.deepEqual(gaps, []);
	});

	it("checkTitleDiffDirection: only-M diff → no gap", () => {
		const gaps = checkTitleDiffDirection("add", "add something", [
			{ status: "M", path: "src/f.ts" },
		]);
		assert.deepEqual(gaps, []);
	});

	it("checkTitleDiffDirection: deletions-side mismatch detail", () => {
		const gaps = checkTitleDiffDirection("remove", "remove old code", [
			{ status: "A", path: "src/a.ts" },
			{ status: "A", path: "src/b.ts" },
			{ status: "D", path: "src/c.ts" },
		]);
		assert.equal(gaps.length, 1);
		assert.equal(
			gaps[0]!.detail,
			'Issue title suggests "deletions" but diff has net additions (+2A, -1D). Verify this is intentional.',
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: diff.ts (adapter)
// ═══════════════════════════════════════════════════════════════════════

describe("diff.ts getGitDiff", () => {
	it("code 0 → ok:true with entries + changedFiles", async () => {
		const exec = mockDiffExec(["A src/new.ts", "M src/index.ts"]);
		const result = await getGitDiff(exec, "/fake/worktree", "main");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.diffEntries.length, 2);
			assert.deepEqual(result.changedFiles, ["src/new.ts", "src/index.ts"]);
		}
	});

	it("rename R100 → oldPath appended to changedFiles", async () => {
		const exec = mockDiffExec(["R100\tsrc/old-name.ts\tsrc/new-name.ts"]);
		const result = await getGitDiff(exec, "/fake/worktree", "main");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.changedFiles, ["src/new-name.ts", "src/old-name.ts"]);
			assert.equal(result.diffEntries[0]!.oldPath, "src/old-name.ts");
		}
	});

	it("code 1 with stderr → ok:false error=stderr", async () => {
		const exec: ExecFn = async () => ({
			code: 1,
			stdout: "",
			stderr: "fatal: not a git repository",
		});
		const result = await getGitDiff(exec, "/fake/worktree", "main");
		assert.deepEqual(result, { ok: false, error: "fatal: not a git repository" });
	});

	it("code 1 with empty stderr → ok:false error='unknown error'", async () => {
		const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "" });
		const result = await getGitDiff(exec, "/fake/worktree", "main");
		assert.deepEqual(result, { ok: false, error: "unknown error" });
	});

	it("throw → ok:false error=message", async () => {
		const exec: ExecFn = async () => {
			throw new Error("boom");
		};
		const result = await getGitDiff(exec, "/fake/worktree", "main");
		assert.deepEqual(result, { ok: false, error: "boom" });
	});

	it("empty output → ok:true empty arrays", async () => {
		const exec = mockDiffExec([]);
		const result = await getGitDiff(exec, "/fake/worktree", "main");
		assert.deepEqual(result, { ok: true, diffEntries: [], changedFiles: [] });
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: coverage.ts (adapter)
// ═══════════════════════════════════════════════════════════════════════

describe("coverage.ts checkChecklistKeywordCoverage", () => {
	it("matched keyword (code 0) → no gap", async () => {
		const exec: ExecFn = async () => ({ code: 0, stdout: "src/auth.ts", stderr: "" });
		const gaps = await checkChecklistKeywordCoverage(
			exec,
			"/fake/worktree",
			["src/auth.ts"],
			[{ item: "Add user authentication flow", keywords: ["authentication"] }],
		);
		assert.deepEqual(gaps, []);
	});

	it("unmatched → exact detail", async () => {
		const exec = mockDiffExec([]);
		const gaps = await checkChecklistKeywordCoverage(
			exec,
			"/fake/worktree",
			["src/auth.ts"],
			[{ item: "Create the API for user module", keywords: ["Create", "API", "user", "module"] }],
		);
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]!.check, "checklist-keyword-coverage");
		assert.equal(gaps[0]!.severity, "warning");
		assert.equal(
			gaps[0]!.detail,
			'Checklist item "Create the API for user module" — no keywords matched in changed files. Keywords checked: Create, API, user, module',
		);
	});

	it("empty keywords or changedFiles → []", async () => {
		const exec = mockDiffExec([]);
		assert.deepEqual(
			await checkChecklistKeywordCoverage(exec, "/fake/worktree", ["src/a.ts"], []),
			[],
		);
		assert.deepEqual(
			await checkChecklistKeywordCoverage(
				exec,
				"/fake/worktree",
				[],
				[{ item: "x", keywords: ["y"] }],
			),
			[],
		);
	});

	it("stop-word-only item (no keywords) → skipped", async () => {
		const exec = mockDiffExec([]);
		const gaps = await checkChecklistKeywordCoverage(
			exec,
			"/fake/worktree",
			["src/a.ts"],
			[{ item: "The is a", keywords: [] }],
		);
		assert.deepEqual(gaps, []);
	});

	it("grep throw → non-fatal: treated as not-found gap, no 'check failed' error", async () => {
		const exec: ExecFn = async () => {
			throw new Error("grep exploded");
		};
		const gaps = await checkChecklistKeywordCoverage(
			exec,
			"/fake/worktree",
			["src/a.ts"],
			[{ item: "Add login", keywords: ["login"] }],
		);
		// Thrown grep = not found (pre-split semantics): the item gap fires, but the
		// throw is swallowed inside coverage — no "Checklist keyword check failed" gap.
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]!.check, "checklist-keyword-coverage");
		assert.ok(gaps[0]!.detail.startsWith('Checklist item "Add login"'));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: cleanup.ts (adapter)
// ═══════════════════════════════════════════════════════════════════════

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
});
