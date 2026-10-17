// ─── Long-file refactor contract (issue #2035) ────────────────────
// CodeFlow's "Long File" anti-pattern flags every analyzed file whose raw
// newline-segment count exceeds 500:
//   longFiles = analyzed.filter(f => f.isCode !== false && f.lines && f.lines > 500)
//   lines = content.split("\n").length
// so a newline-terminated file of N `wc -l` lines counts N+1 segments and is
// flagged at N+1 > 500 (i.e. N >= 500).
//
// Issue #2035 was filed over 87 files. Unlike #2005, this set is dominated by
// `.mts` test suites: the embedded server rewrites the vendored analyzer's
// extension list (`cmd/cheasee-pi/embedded/docker/codeflow/server.py`,
// `_ts_rewrite(b"codeExts:['.js','.jsx','.ts','.tsx'")`) to also score `.mts`/
// `.cts`, so the test suites count toward the metric here.
//
// This test is the in-gate oracle for the split family below: every original
// this change touched — and every sibling it minted — must land `<= 500`
// segments, or the metric would not fall for that family. Rust sources (no
// toolchain in the pipeline image) and the embedded `server.py` (Dockerfile
// `COPY`-set boundary) are deliberately deferred; see
// `.pi/skills/audit-codeflow-analysis/references/long-file-2035.md`.
//
// Run: node --experimental-strip-types --test test/long-file-refactor-2035.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CEILING = 500;

/** Files this change split (the long original) → the siblings it produced. */
export const TOUCHED: Record<string, string[]> = {
	".pi/extensions/supervisor/test/workflow.test.mts": [
		".pi/extensions/supervisor/test/workflow-audit-headings.test.mts",
	],
	".pi/extensions/supervisor/test/config.test.mts": [
		".pi/extensions/supervisor/test/config-schema-skills.test.mts",
	],
	".pi/extensions/session-logger/test/session-logger-stats.test.mts": [
		".pi/extensions/session-logger/test/session-logger-stats-nested.test.mts",
	],
	".pi/extensions/session-logger/test/report.test.mts": [
		".pi/extensions/session-logger/test/report-user-journey.test.mts",
	],
	".pi/extensions/caveman/test/caveman-index.test.mts": [
		".pi/extensions/caveman/test/caveman-harness.mts",
		".pi/extensions/caveman/test/caveman-branch-restore.test.mts",
	],
	".pi/extensions/supervisor/test/duplicate-code.test.mts": [
		".pi/extensions/supervisor/test/duplicate-code-harness.mts",
		".pi/extensions/supervisor/test/duplicate-code-run.test.mts",
	],
	".pi/extensions/ask-user/test/question-handler.test.mts": [
		".pi/extensions/ask-user/test/question-handler-harness.mts",
		".pi/extensions/ask-user/test/question-handler-modes.test.mts",
	],
	".pi/extensions/supervisor/test/helpers/capture.test.mts": [
		".pi/extensions/supervisor/test/helpers/capture-mockctx-integration.test.mts",
	],
	".pi/extensions/lsp-auditor/test/lsp-auditor.test.mts": [
		".pi/extensions/lsp-auditor/test/lsp-auditor-grouping.test.mts",
	],
	".pi/extensions/session-logger/test/session-logger-renderer.test.mts": [
		".pi/extensions/session-logger/test/session-logger-renderer-stats.test.mts",
		".pi/extensions/session-logger/test/session-logger-renderer-subagent-stats.test.mts",
		".pi/extensions/session-logger/test/session-logger-renderer-filemods.test.mts",
		".pi/extensions/session-logger/test/session-logger-renderer-nested-rollup.test.mts",
		".pi/extensions/session-logger/test/session-logger-renderer-nested-table.test.mts",
	],
	".pi/extensions/ask-user/test/ask-user.test.mts": [
		".pi/extensions/ask-user/test/ask-user-query-ids.test.mts",
		".pi/extensions/ask-user/test/ask-user-migrate.test.mts",
		".pi/extensions/ask-user/test/ask-user-session-schema.test.mts",
		".pi/extensions/ask-user/test/ask-user-format-edge.test.mts",
		".pi/extensions/ask-user/test/ask-user-read.test.mts",
	],
	".pi/extensions/ripgrep-search/test/ripgrep-search.test.mts": [
		".pi/extensions/ripgrep-search/test/ripgrep-search-config-dirs.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-verify-cache.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-cache-count.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-summary-errors.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-integration-rg.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-mode-ctx.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-schema.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-execute-structured.test.mts",
		".pi/extensions/ripgrep-search/test/ripgrep-search-cache-invalidation.test.mts",
	],
	".pi/extensions/session-logger/test/session-logger-pipeline.test.mts": [
		".pi/extensions/session-logger/test/session-logger-pipeline-part2.test.mts",
	],
	".pi/extensions/session-logger/test/session-logger.test.mts": [
		".pi/extensions/session-logger/test/session-logger-part2.test.mts",
		".pi/extensions/session-logger/test/session-logger-part3.test.mts",
	],
	".pi/extensions/supervisor/test/agent-output.test.mts": [
		".pi/extensions/supervisor/test/agent-output-part2.test.mts",
		".pi/extensions/supervisor/test/agent-output-part3.test.mts",
		".pi/extensions/supervisor/test/agent-output-part4.test.mts",
	],
	".pi/extensions/supervisor/test/agent-stream.test.mts": [
		".pi/extensions/supervisor/test/agent-stream-part2.test.mts",
	],
	".pi/extensions/supervisor/test/dead-code.test.mts": [
		".pi/extensions/supervisor/test/dead-code-part2.test.mts",
		".pi/extensions/supervisor/test/dead-code-part3.test.mts",
	],
	".pi/extensions/supervisor/test/event-adapter.test.mts": [
		".pi/extensions/supervisor/test/event-adapter-part2.test.mts",
		".pi/extensions/supervisor/test/event-adapter-part3.test.mts",
	],
	".pi/extensions/supervisor/test/github/git.test.mts": [
		".pi/extensions/supervisor/test/github/git-part2.test.mts",
		".pi/extensions/supervisor/test/github/git-part3.test.mts",
	],
	".pi/extensions/supervisor/test/output.test.mts": [
		".pi/extensions/supervisor/test/output-part2.test.mts",
		".pi/extensions/supervisor/test/output-part3.test.mts",
	],
	".pi/extensions/supervisor/test/pipeline/crash-cleanup.test.mts": [
		".pi/extensions/supervisor/test/pipeline/crash-cleanup-part2.test.mts",
		".pi/extensions/supervisor/test/pipeline/crash-cleanup-part3.test.mts",
	],
	".pi/extensions/supervisor/test/pipeline/notifications.test.mts": [
		".pi/extensions/supervisor/test/pipeline/notifications-part2.test.mts",
	],
	".pi/extensions/supervisor/test/pipeline/worktree.test.mts": [
		".pi/extensions/supervisor/test/pipeline/worktree-part2.test.mts",
	],
	".pi/extensions/supervisor/test/requirements-modules.test.mts": [
		".pi/extensions/supervisor/test/requirements-modules-part2.test.mts",
	],
	".pi/skills/audit-codeflow-analysis/test/dry-run.test.mts": [
		".pi/skills/audit-codeflow-analysis/test/dry-run-part2.test.mts",
	],
};

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const lineCount = (s: string): number => s.split("\n").length;
const isFlagged = (rel: string): boolean => lineCount(read(rel)) > CEILING;

const ALL_FILES = [...Object.keys(TOUCHED), ...Object.values(TOUCHED).flat()];

describe("long-file refactor #2035 — the ceiling is the pinned detector's", () => {
	it("has teeth at the exact boundary (strictly more than 500 segments)", () => {
		const mk = (segments: number): string => "x\n".repeat(segments - 1) + "x";
		assert.equal(lineCount(mk(500)), 500);
		assert.equal(lineCount(mk(500)) > CEILING, false, "500 segments must not be flagged");
		assert.equal(lineCount(mk(501)) > CEILING, true, "501 segments must be flagged");
	});

	it("counts a trailing newline — 500 wc-l lines is 501 segments", () => {
		assert.equal(lineCount("export const x = 1;\n".repeat(500)), 501);
	});

	it("scores `.mts` (the embedded shim extends codeExts)", () => {
		const long = "x;\n".repeat(600);
		assert.equal(lineCount(long), 601);
		assert.equal(lineCount(long) > CEILING, true, ".mts is scored in this analysis");
	});
});

describe("long-file refactor #2035 — manifest", () => {
	it("clears a substantial family count", () => {
		assert.ok(Object.keys(TOUCHED).length >= 25, `expected >=25 families`);
		for (const [rel, sibs] of Object.entries(TOUCHED)) {
			assert.ok(sibs.length >= 1, `${rel} lists no sibling`);
		}
	});

	it("every listed file exists and is listed exactly once", () => {
		for (const rel of ALL_FILES) {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing manifest file: ${rel}`);
		}
		assert.equal(new Set(ALL_FILES).size, ALL_FILES.length, "a file is listed twice");
	});
});

describe("long-file refactor #2035 — every touched file is under the ceiling", () => {
	for (const rel of ALL_FILES) {
		it(`${rel} counts <= 500 segments`, () => {
			const segments = lineCount(read(rel));
			assert.ok(segments <= CEILING, `${rel} counts ${segments} segments (ceiling 500)`);
			assert.equal(isFlagged(rel), false, `${rel} is still flagged`);
		});
	}
});
