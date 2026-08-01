/**
 * Golden-master (characterization) tests for requirements-traceability.
 *
 * Captures full serialized gap arrays from a fixed input corpus and
 * replays them byte-identical on subsequent runs. Any incidental drift
 * (whitespace, rewording, reorder, dedupe) after a refactor fails here.
 *
 * Capture mode (one-time, on the PRE-split implementation, commits the fixture):
 *   REQ_GOLDEN_CAPTURE=1 node --experimental-strip-types --test .pi/extensions/supervisor/test/requirements-golden.test.mts
 *
 * Compare mode (default): deep-equals replay vs the committed fixture.
 * Missing fixture in compare mode = hard fail (fail closed, no silent capture).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/requirements-golden.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

import {
	runRequirementsTraceability,
	type TraceabilityGap,
	type FilteredIssueData,
} from "../checks/requirements-traceability.ts";
import type { ExecFn } from "../checks/shared.ts";

const FIXTURE_URL = new URL("./fixtures/requirements-golden.json", import.meta.url);
const CAPTURE = process.env.REQ_GOLDEN_CAPTURE === "1";

// ═══════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mock ExecFn that branches plain `grep` (checklist keyword coverage) vs
 * `git grep` (old reference cleanup) vs `git diff --name-status`.
 */
function goldenExec(opts: {
	diffLines: string[];
	grepCode?: number;
	gitGrepStdout?: string | null;
}): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			return { code: 0, stdout: opts.diffLines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "grep") {
			return { code: opts.grepCode ?? 1, stdout: "", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			return opts.gitGrepStdout == null
				? { code: 1, stdout: "", stderr: "" }
				: { code: 0, stdout: opts.gitGrepStdout, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

/** Mock ExecFn that fails the step-1 git diff with a non-zero code. */
function diffFailExec(stderr: string): ExecFn {
	return async () => ({ code: 1, stdout: "", stderr });
}

/** Mock ExecFn that throws on the step-1 git diff. */
function diffThrowExec(): ExecFn {
	return async () => {
		throw new Error("boom");
	};
}

/**
 * Create a temp directory for file-system-based scenarios.
 * Returns the temp dir path. Caller must clean up with rmSync.
 */
function createTempDir(prefix: string, files: Record<string, string>): string {
	const baseDir = join(process.cwd(), "ignore");
	const tempDir = join(baseDir, `rt-golden-${prefix}-${Date.now()}`);
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = join(tempDir, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}
	return tempDir;
}

// ═══════════════════════════════════════════════════════════════════════
// Corpus — fixed inputs whose full gap output is pinned byte-identical
// ═══════════════════════════════════════════════════════════════════════

interface Scenario {
	id: string;
	exec: ExecFn;
	/** Temp worktree files (real dir when file-system checks matter). */
	files?: Record<string, string>;
	body: unknown;
	title: unknown;
}

const SCENARIOS: Scenario[] = [
	{
		id: "empty-all",
		exec: goldenExec({ diffLines: [] }),
		body: "",
		title: "",
	},
	{
		// Maximal case: all 4 checks fire (checklist + parity + 2× cleanup + title).
		id: "all-checks-firing",
		exec: goldenExec({
			diffLines: ["A src/uncovered.ts", "D src/old-module.ts", "D src/other-old.ts"],
			gitGrepStdout: "src/remaining.ts\n",
		}),
		files: {
			"src/uncovered.ts": "export function uncovered() {}",
			"test/old-module.test.ts": "// covered",
			"test/other-old.test.ts": "// covered",
		},
		body: "## Tasks\n- [ ] Build X-5000 controller",
		title: "add new controller",
	},
	{
		id: "diff-fail-stderr",
		exec: diffFailExec("fatal: not a git repository"),
		body: "## Tasks\n- [ ] Something",
		title: "add something",
	},
	{
		id: "diff-fail-empty-stderr",
		exec: diffFailExec(""),
		body: "## Tasks\n- [ ] Something",
		title: "add something",
	},
	{
		id: "diff-throw",
		exec: diffThrowExec(),
		body: "## Tasks\n- [ ] Something",
		title: "add something",
	},
	{
		// Rename R100: oldPath appended to changedFiles; cleanup fires on oldPath.
		id: "rename-oldpath",
		exec: goldenExec({
			diffLines: ["R100\tsrc/old-name.ts\tsrc/new-name.ts"],
			gitGrepStdout: "src/remaining.ts\n",
		}),
		files: {
			"src/old-name.ts": "export function oldName() {}",
			"test/old-name.test.ts": "// covered",
			"test/new-name.test.ts": "// covered",
		},
		body: "",
		title: "",
	},
	{
		id: "deleted-file",
		exec: goldenExec({
			diffLines: ["D docs/deleted-guide.md"],
			gitGrepStdout: "src/remaining-file.ts\n",
		}),
		body: "",
		title: "",
	},
	{
		// grep found (code 0) → no checklist gap; README.md not testable → no parity.
		id: "grep-found-no-gap",
		exec: goldenExec({ diffLines: ["A README.md"], grepCode: 0 }),
		body: "## Tasks\n- [ ] Add user authentication flow",
		title: "add auth",
	},
	{
		// Items under Prerequisites/Setup excluded; only Tasks item checked.
		id: "excluded-headings",
		exec: goldenExec({ diffLines: ["A README.md"] }),
		body: "## Prerequisites\n- [ ] Clone repo\n\n## Setup\n- [ ] Configure env\n\n## Tasks\n- [ ] Build feature",
		title: "",
	},
	{
		id: "ambiguous-title",
		exec: goldenExec({ diffLines: ["A docs/new.md", "D docs/old.md"] }),
		body: "",
		title: "add and remove things",
	},
	{
		// Title "add" but diff has net deletions → exact +1A, -2D detail.
		id: "title-mismatch-add",
		exec: goldenExec({ diffLines: ["D docs/old.md", "D docs/another.md", "A src/new.ts"] }),
		files: { "test/new.test.ts": "// covered" },
		body: "",
		title: "add new feature",
	},
	{
		// Title "remove" but diff has net additions → exact +2A, -1D detail.
		id: "title-mismatch-remove",
		exec: goldenExec({ diffLines: ["A docs/new.md", "A docs/another.md", "D docs/old.md"] }),
		body: "",
		title: "remove old code",
	},
	{
		// Colon-prefix title: verb extracted from after "feat:".
		id: "colon-prefix-title",
		exec: goldenExec({ diffLines: ["D docs/old.md", "D docs/other.md", "A src/login.ts"] }),
		files: { "test/login.test.ts": "// covered" },
		body: "",
		title: "feat: add login",
	},
	{
		// Non-string body → runStep catches, later checks still run.
		id: "non-string-body",
		exec: goldenExec({ diffLines: [] }),
		body: 42,
		title: "",
	},
	{
		// Non-string title → title step catches.
		id: "non-string-title",
		exec: goldenExec({ diffLines: [] }),
		body: "",
		title: 42,
	},
	{
		id: "only-m-diff",
		exec: goldenExec({ diffLines: ["M docs/guide.md"] }),
		body: "",
		title: "add something",
	},
];

// ═══════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════

async function runScenarios(): Promise<Array<{ id: string; gaps: TraceabilityGap[] }>> {
	const results: Array<{ id: string; gaps: TraceabilityGap[] }> = [];

	for (const scenario of SCENARIOS) {
		const worktreePath = scenario.files
			? createTempDir(scenario.id, scenario.files)
			: "/fake/worktree";
		try {
			const filteredData: FilteredIssueData = {
				body: scenario.body as string,
				comments: [],
			};
			const gaps = await runRequirementsTraceability(
				scenario.exec,
				worktreePath,
				"main",
				filteredData,
				scenario.title as string,
			);
			results.push({ id: scenario.id, gaps });
		} finally {
			if (scenario.files) {
				rmSync(worktreePath, { recursive: true, force: true });
			}
		}
	}

	return results;
}

describe("requirements-traceability golden corpus", () => {
	it("gap output is byte-identical to the committed fixture", async () => {
		const results = await runScenarios();

		if (CAPTURE) {
			writeFileSync(FIXTURE_URL, JSON.stringify(results, null, 2) + "\n", "utf8");
			// Capture mode also self-checks: report the serialized corpus for review.
			console.log(`[golden] captured ${results.length} scenarios → ${FIXTURE_URL}`);
			return;
		}

		let fixtureRaw: string;
		try {
			fixtureRaw = readFileSync(FIXTURE_URL, "utf8");
		} catch {
			assert.fail(
				"Golden fixture missing — run with REQ_GOLDEN_CAPTURE=1 on the pre-split implementation to create it (fail closed, no silent capture)",
			);
		}

		assert.deepEqual(
			results,
			JSON.parse(fixtureRaw) as Array<{ id: string; gaps: TraceabilityGap[] }>,
		);
	});
});
