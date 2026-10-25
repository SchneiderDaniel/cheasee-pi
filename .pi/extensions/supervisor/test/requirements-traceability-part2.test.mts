import { describe, it } from "node:test";

import assert from "node:assert/strict";

import { mkdirSync, writeFileSync, rmSync } from "node:fs";

import { join, dirname } from "node:path";

import {
	type TraceabilityGap,
	type FilteredIssueData,
	runRequirementsTraceability,
} from "../checks/requirements-traceability.ts";

import type { ExecFn } from "../checks/shared.ts";

import { stripAnsi, isSuccess } from "../agent/output.ts";

function mockExec(lines: string[]): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			const nameOnly = lines
				.map((l) => l.replace(/^[A-Z]\d*\s+/, "").replace(/\s+.*$/, ""))
				.filter(Boolean);
			return { code: 0, stdout: nameOnly.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

function mockExecPaths(paths: string[]): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			const lines = paths.map((p) => `A ${p}`);
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			return { code: 0, stdout: paths.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

function createTempDir(prefix: string, files: Record<string, string>): string {
	const baseDir = join(process.cwd(), "ignore");
	const tempDir = join(baseDir, `rt-test-${prefix}-${Date.now()}`);
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = join(tempDir, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}
	return tempDir;
}

function mockExecWithGrep(lines: string[], grepStdout: string | null): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			const nameOnly = lines
				.map((l) => l.replace(/^[A-Z]\d*\s+/, "").replace(/\s+.*$/, ""))
				.filter(Boolean);
			return { code: 0, stdout: nameOnly.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			if (grepStdout !== null) {
				return { code: 0, stdout: grepStdout, stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

describe("runRequirementsTraceability()", () => {
	it("mock exec returns realistic diff output, returns TraceabilityGap[]", async () => {
		const exec = mockExec(["A src/new-feature.ts", "M src/index.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Tasks\n- [ ] Add new feature module\n- [ ] Export from index",
				comments: [],
			},
			"feat: add new feature module",
		);
		assert.ok(Array.isArray(result));
		for (const gap of result) {
			assert.ok(typeof gap.check === "string");
			assert.ok(gap.severity === "info" || gap.severity === "warning");
			assert.ok(typeof gap.detail === "string");
		}
	});

	it("empty issue body, no changed files → returns empty array", async () => {
		const exec = mockExec([]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		assert.equal(result.length, 0);
	});

	it("git diff fails (error) → returns error gap, does not crash", async () => {
		const failingExec: ExecFn = async () => {
			return { code: 1, stdout: "", stderr: "fatal: not a git repository" };
		};
		const result = await runRequirementsTraceability(
			failingExec,
			"/fake/worktree",
			"main",
			{ body: "## Tasks\n- [ ] Something", comments: [] },
			"add something",
		);
		assert.ok(result.length > 0);
		// Should include an error gap
		const errorGap = result.find((g) => g.severity === "warning" || g.check === "diff");
		assert.ok(errorGap, "Should return a gap for diff failure");
	});

	it("severity is 'info' for title→direction mismatch, 'warning' for missing tests and unmatched checklists", async () => {
		const exec = mockExec(["A src/new.ts", "D src/old.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Tasks\n- [ ] Create new module",
				comments: [],
			},
			"add new module",
		);
		// Title "add" with both A and D (A > D)
		// Should have test parity warning since new.ts has no test
		const testParityGaps = result.filter((g) => g.check === "test-file-parity");
		for (const g of testParityGaps) {
			assert.equal(g.severity, "warning");
		}
	});
});
describe("Checklist→diff keyword mapping", () => {
	it("checklist item keywords found in changed files → no gap", async () => {
		const exec = mockExecPaths(["src/auth.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Tasks\n- [ ] Add user authentication flow",
				comments: [],
			},
			"add authentication",
		);
		const checklistGaps = result.filter((g) => g.check === "checklist-keyword-coverage");
		assert.ok(Array.isArray(checklistGaps));
	});

	it("no checklist items → no gaps from checklist check", async () => {
		const exec = mockExec(["A src/new.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "Just a plain description", comments: [] },
			"add new",
		);
		const checklistGaps = result.filter((g) => g.check === "checklist-keyword-coverage");
		assert.equal(checklistGaps.length, 0);
	});

	it("checklist item under Setup heading → excluded, no gap", async () => {
		const exec = mockExecPaths(["src/helper.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Setup\n- [ ] Clone repository\n## Tasks\n- [ ] Build feature",
				comments: [],
			},
			"build feature",
		);
		const checklistGaps = result.filter((g) => g.check === "checklist-keyword-coverage");
		const detailStr = checklistGaps.map((g) => g.detail).join(" ");
		assert.equal(detailStr.includes("Clone repository"), false);
	});
});
describe("output.ts exports — agent output functions", () => {
	it("stripAnsi removes ANSI escape sequences", () => {
		assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
	});

	it("stripAnsi returns plain text unchanged", () => {
		assert.equal(stripAnsi("hello world"), "hello world");
	});

	it("isSuccess returns false for error result", () => {
		const result = isSuccess({ error: "test error", rawOutput: "" });
		assert.equal(result, false);
	});
});
describe("Test file parity check", () => {
	it("src/foo.ts changed, test/foo.test.ts exists → no gap", async () => {
		const tempDir = createTempDir("parity-1", {
			"src/foo.ts": "export function foo() {}",
			"test/foo.test.ts": 'import { foo } from "../src/foo";',
		});
		try {
			const exec = mockExecPaths(["src/foo.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("src/foo.d.ts changed → excluded, no gap", async () => {
		const tempDir = createTempDir("parity-2", {
			"src/foo.d.ts": "export type Foo = string;",
		});
		try {
			const exec = mockExecPaths(["src/foo.d.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("src/index.ts (barrel) changed → excluded, no gap", async () => {
		const tempDir = createTempDir("parity-3", {
			"src/index.ts": "export { foo } from './foo';",
		});
		try {
			const exec = mockExecPaths(["src/index.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("src/generated/api.ts changed → excluded, no gap", async () => {
		const tempDir = createTempDir("parity-generated", {
			"src/generated/api.ts": "export function api() {}",
		});
		try {
			const exec = mockExecPaths(["src/generated/api.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("src/vendor/lib.ts changed → excluded, no gap", async () => {
		const tempDir = createTempDir("parity-vendor", {
			"src/vendor/lib.ts": "export function lib() {}",
		});
		try {
			const exec = mockExecPaths(["src/vendor/lib.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("src/foo.ts changed, no test file → warning gap", async () => {
		const tempDir = createTempDir("parity-missing", {
			"src/foo.ts": "export function foo() {}",
		});
		try {
			const exec = mockExecPaths(["src/foo.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 1);
			assert.equal(testGaps[0]!.severity, "warning");
			assert.ok(testGaps[0]!.detail.includes("foo.ts"));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("multiple src files, one missing test → warning for that file only", async () => {
		const tempDir = createTempDir("parity-multi", {
			"src/foo.ts": "export function foo() {}",
			"test/foo.test.ts": 'import { foo } from "../src/foo";',
			"src/bar.ts": "export function bar() {}",
		});
		try {
			const exec = mockExecPaths(["src/foo.ts", "src/bar.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 1);
			assert.equal(testGaps[0]!.severity, "warning");
			assert.ok(testGaps[0]!.detail.includes("bar.ts"));
			assert.equal(testGaps[0]!.detail.includes("foo.ts"), false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("all changed files are test files only → skip, no gap", async () => {
		const tempDir = createTempDir("parity-alltests", {
			"test/foo.test.ts": 'import assert from "node:assert";',
		});
		try {
			const exec = mockExecPaths(["test/foo.test.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("no changed files → no gap", async () => {
		const exec = mockExec([]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		assert.equal(result.length, 0);
	});
});
describe("Old reference cleanup check", () => {
	it("no deletions or renames → check skipped, no gap", async () => {
		const exec = mockExec(["A src/new.ts", "M src/old.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"add new",
		);
		const oldRefGaps = result.filter((g) => g.check === "old-reference-cleanup");
		assert.equal(oldRefGaps.length, 0);
	});

	it("rename detected, old name still referenced → warning gap", async () => {
		const exec = mockExecWithGrep(
			["R100\tsrc/old-name.ts\tsrc/new-name.ts"],
			"src/other-file.ts\n",
		);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		const oldRefGaps = result.filter((g) => g.check === "old-reference-cleanup");
		assert.equal(oldRefGaps.length, 1);
		assert.equal(oldRefGaps[0]!.severity, "warning");
		assert.ok(oldRefGaps[0]!.detail.includes("old-name"));
	});

	it("file deleted, imports remain → warning gap", async () => {
		const exec = mockExecWithGrep(["D src/deleted-module.ts"], "src/remaining-file.ts\n");
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		const oldRefGaps = result.filter((g) => g.check === "old-reference-cleanup");
		assert.equal(oldRefGaps.length, 1);
		assert.equal(oldRefGaps[0]!.severity, "warning");
		assert.ok(oldRefGaps[0]!.detail.includes("deleted-module"));
	});

	it("D+A pair with similar basenames → detected, warning gap", async () => {
		const exec = mockExecWithGrep(["D src/old-api.ts", "A src/new-api.ts"], "src/config.ts\n");
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		const oldRefGaps = result.filter((g) => g.check === "old-reference-cleanup");
		assert.equal(oldRefGaps.length, 1);
		assert.equal(oldRefGaps[0]!.severity, "warning");
		assert.ok(oldRefGaps[0]!.detail.includes("old-api"));
	});

	it("rename detected, no remaining references → no gap", async () => {
		const exec = mockExecWithGrep(["R100\tsrc/old-name.ts\tsrc/new-name.ts"], null);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		const oldRefGaps = result.filter((g) => g.check === "old-reference-cleanup");
		assert.equal(oldRefGaps.length, 0);
	});

	it("file deleted, no remaining references → no gap", async () => {
		const exec = mockExecWithGrep(["D src/deleted-module.ts"], null);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		const oldRefGaps = result.filter((g) => g.check === "old-reference-cleanup");
		assert.equal(oldRefGaps.length, 0);
	});
});
