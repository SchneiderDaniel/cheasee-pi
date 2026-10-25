// ─── Long-file refactor contract (issue #2035) ────────────────────
// CodeFlow's "Long File" anti-pattern flags every analyzed file whose raw
// newline-segment count exceeds 500:
//   longFiles = analyzed.filter(f => f.isCode !== false && f.lines && f.lines > 500)
//   lines = content.split("\n").length
// so a newline-terminated file of N `wc -l` lines counts N+1 segments and is
// flagged at N+1 > 500 (i.e. N >= 500).
//
// Issue #2035 was filed over 87 files (snapshot `analyzedAt 1791804971015`).
// Unlike #2005, this set is dominated by `.mts` test suites: the embedded
// server rewrites the vendored analyzer's extension list
// (`cmd/cheasee-pi/embedded/docker/codeflow/server.py`,
// `_ts_rewrite(b"codeExts:['.js','.jsx','.ts','.tsx'")`) to also score `.mts`/
// `.cts`, so the suites count toward this metric.
//
// This test is the in-gate oracle for the complete affected set. Every original
// in `AFFECTED` — and every sibling minted beside it (matched by stem prefix,
// e.g. `mode-dispatch.test.mts` → `mode-dispatch-part2.test.mts`) — must land
// `<= 500` segments, except the files pinned in `DEFERRED`, which are still
// over the ceiling for the documented reasons. A deferred file that drops under
// the ceiling fails so it gets unpinned.
//
// Siblings are discovered dynamically, so a new split that forgets a part file
// still gets checked without editing this manifest.
//
// Run: node --experimental-strip-types --test test/long-file-refactor-2035.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CEILING = 500;

/** Complete `Long File` set named by the issue (snapshot 1791804971015). */
const AFFECTED = [
	".pi/extensions/ask-user/test/ask-user.test.mts",
	".pi/extensions/ask-user/test/mode-dispatch.test.mts",
	".pi/extensions/ask-user/test/question-handler.test.mts",
	".pi/extensions/ask-user/test/structured-output.test.mts",
	".pi/extensions/ask-user/test/trust-gating.test.mts",
	".pi/extensions/caveman/test/caveman-index.test.mts",
	".pi/extensions/context-info/test/context-info.test.mts",
	".pi/extensions/context-info/test/context-status-bar.test.mts",
	".pi/extensions/context-info/test/footer-config.test.mts",
	".pi/extensions/format-on-save/test/format-on-save.test.mts",
	".pi/extensions/lsp-auditor/test/lsp-auditor.test.mts",
	".pi/extensions/lsp-auditor/test/lsp-client-split.test.mts",
	".pi/extensions/ripgrep-search/test/ripgrep-search.test.mts",
	".pi/extensions/session-logger/test/report.test.mts",
	".pi/extensions/session-logger/test/session-logger-files.test.mts",
	".pi/extensions/session-logger/test/session-logger-pipeline.test.mts",
	".pi/extensions/session-logger/test/session-logger-renderer-golden.test.mts",
	".pi/extensions/session-logger/test/session-logger-renderer.test.mts",
	".pi/extensions/session-logger/test/session-logger-stats.test.mts",
	".pi/extensions/session-logger/test/session-logger.test.mts",
	".pi/extensions/structural-analyzer/test/index.test.mts",
	".pi/extensions/supervisor/test/agent-output.test.mts",
	".pi/extensions/supervisor/test/agent-runner-in-process.test.mts",
	".pi/extensions/supervisor/test/agent-runner-subprocess.test.mts",
	".pi/extensions/supervisor/test/agent-stream.test.mts",
	".pi/extensions/supervisor/test/agent-task.test.mts",
	".pi/extensions/supervisor/test/chat-progress.test.mts",
	".pi/extensions/supervisor/test/checks/osv-scanner.test.mts",
	".pi/extensions/supervisor/test/config.test.mts",
	".pi/extensions/supervisor/test/dead-code.test.mts",
	".pi/extensions/supervisor/test/duplicate-code.test.mts",
	".pi/extensions/supervisor/test/event-adapter.test.mts",
	".pi/extensions/supervisor/test/github-comment.test.mts",
	".pi/extensions/supervisor/test/github/comment.test.mts",
	".pi/extensions/supervisor/test/github/git.test.mts",
	".pi/extensions/supervisor/test/helpers/capture.test.mts",
	".pi/extensions/supervisor/test/message-renderer-golden.test.mts",
	".pi/extensions/supervisor/test/message-renderer.test.mts",
	".pi/extensions/supervisor/test/output.test.mts",
	".pi/extensions/supervisor/test/package-safety-audit.test.mts",
	".pi/extensions/supervisor/test/pipeline/agent-loop-retry.test.mts",
	".pi/extensions/supervisor/test/pipeline/agent-loop-skeleton.test.mts",
	".pi/extensions/supervisor/test/pipeline/crash-cleanup.test.mts",
	".pi/extensions/supervisor/test/pipeline/handler-execute-agent.test.mts",
	".pi/extensions/supervisor/test/pipeline/handler.test.mts",
	".pi/extensions/supervisor/test/pipeline/merge.test.mts",
	".pi/extensions/supervisor/test/pipeline/notifications.test.mts",
	".pi/extensions/supervisor/test/pipeline/pr-creation.test.mts",
	".pi/extensions/supervisor/test/pipeline/rebase.test.mts",
	".pi/extensions/supervisor/test/pipeline/stages.test.mts",
	".pi/extensions/supervisor/test/pipeline/state-checkpoint.test.mts",
	".pi/extensions/supervisor/test/pipeline/worktree.test.mts",
	".pi/extensions/supervisor/test/requirements-modules.test.mts",
	".pi/extensions/supervisor/test/requirements-traceability.test.mts",
	".pi/extensions/supervisor/test/runner-split.test.mts",
	".pi/extensions/supervisor/test/supervisor-pipeline-git.test.mts",
	".pi/extensions/supervisor/test/workflow.test.mts",
	".pi/extensions/worktree-sandbox/test/find-unsafe-cd.test.mts",
	".pi/extensions/worktree-sandbox/test/worktree-sandbox-gates.test.mts",
	".pi/extensions/worktree-sandbox/test/worktree-sandbox.test.mts",
	".pi/skills/audit-codeflow-analysis/scripts/dry-run.mts",
	".pi/skills/audit-codeflow-analysis/test/bridge.test.mts",
	".pi/skills/audit-codeflow-analysis/test/codeflow-analysis.test.mts",
	".pi/skills/audit-codeflow-analysis/test/dry-run.test.mts",
	".pi/skills/audit-codeflow-analysis/test/report.test.mts",
	"cmd/cheasee-pi/embedded/docker/codeflow/server.py",
	"cmd/cheasee-pi/embedded/docker/ui/src/controls.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/main.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/pi_process.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/protocol.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/retry.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/rpc/client.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/session.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/stream.rs",
	"cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/extension_ui.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/reconnect.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/rpc_protocol.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/session_controls.rs",
	"cmd/cheasee-pi/embedded/docker/ui/tests/stream_assembly.rs",
	"docker/test/cli-install-smoke.test.mts",
	"docker/test/unbreak-worktrees.test.mts",
	"test/codeflow-fp-filter.test.mts",
	"test/codeflow-run-analysis.test.mts",
	"test/extensions-load.test.mts",
	"test/git-issue-create-external-skill.test.mts",
];

/**
 * Nothing is deferred any more: the Rust sources are split into `mod`-declared
 * siblings (`rpc/client.rs` additionally lost its live replay adapter to
 * `rpc/client/replay.rs`) and `server.py` re-exports its inline `_BRIDGE_JS`
 * asset from `bridge_js.py`. The map stays here so a future deferral must be
 * declared explicitly rather than silently dropping a file.
 */
const DEFERRED: Record<string, string> = {};

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const segments = (s: string): number => s.split("\n").length;
const isFlagged = (rel: string): boolean => segments(read(rel)) > CEILING;

/**
 * Sibling files minted by a split of `rel`, matched by stem prefix. TS test
 * parts are `<stem>-partN.test.mts`, Rust siblings are `<stem>_partN.rs` or a
 * `<stem>/` module directory, and Python parts are `<stem>_*.py`.
 */
function siblings(rel: string): string[] {
	const dir = resolve(ROOT, dirname(rel));
	const base = basename(rel);
	const stem = base.replace(/\.test\.(mts|ts)$/, "").replace(/\.(mts|ts|cts|rs|py)$/, "");
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const scan = (absDir: string, prefix: string): void => {
		if (!existsSync(absDir)) return;
		for (const n of readdirSync(absDir)) {
			const full = resolve(absDir, n);
			if (statSync(full).isDirectory()) {
				scan(full, join(prefix, n));
				continue;
			}
			if (n === base || !/\.(mts|ts|cts|rs|py)$/.test(n)) continue;
			if (n.startsWith(`${stem}-`) || n.startsWith(`${stem}_`)) {
				out.push(join(dirname(rel), prefix, n));
			}
		}
	};
	scan(dir, "");
	scan(resolve(dir, "parts"), "parts");
	// Module siblings: `<stem>/` is the `mod`-declared split Cargo expects.
	scan(resolve(dir, stem), stem);
	return out;
}

describe("long-file refactor #2035 — the ceiling is the pinned detector's", () => {
	it("has teeth at the exact boundary (strictly more than 500 segments)", () => {
		const mk = (n: number): string => "x\n".repeat(n - 1) + "x";
		assert.equal(segments(mk(500)), 500);
		assert.equal(segments(mk(500)) > CEILING, false, "500 segments must not be flagged");
		assert.equal(segments(mk(501)) > CEILING, true, "501 segments must be flagged");
	});

	it("counts a trailing newline — 500 wc-l lines is 501 segments", () => {
		assert.equal(segments("export const x = 1;\n".repeat(500)), 501);
	});

	it("scores `.mts` (the embedded shim extends codeExts)", () => {
		assert.equal(segments("x;\n".repeat(600)) > CEILING, true, ".mts is scored in this analysis");
	});
});

describe("long-file refactor #2035 — the complete affected set", () => {
	it("pins the full 87-file set with no duplicates", () => {
		assert.equal(AFFECTED.length, 87, "the issue named 87 files");
		assert.equal(new Set(AFFECTED).size, AFFECTED.length, "a file is listed twice");
	});

	it("every pinned deferred file exists and is still over the ceiling", () => {
		for (const rel of Object.keys(DEFERRED)) {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing deferred file: ${rel}`);
			assert.equal(isFlagged(rel), true, `${rel} is under the ceiling — unpin it from DEFERRED`);
		}
	});

	it("the deferred set is exactly the flagged remainder of the 87", () => {
		const stillFlagged = AFFECTED.filter(isFlagged).sort();
		assert.deepEqual(stillFlagged, Object.keys(DEFERRED).sort());
	});
});

describe("long-file refactor #2035 — every original and sibling is under the ceiling", () => {
	for (const rel of AFFECTED) {
		if (DEFERRED[rel]) continue;
		it(`${rel} (and its siblings) count <= 500 segments`, () => {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing: ${rel}`);
			const n = segments(read(rel));
			assert.ok(n <= CEILING, `${rel} counts ${n} segments (ceiling 500)`);
			for (const sib of siblings(rel)) {
				assert.ok(existsSync(resolve(ROOT, sib)), `missing sibling: ${sib}`);
				const m = segments(read(sib));
				assert.ok(m <= CEILING, `${sib} counts ${m} segments (ceiling 500)`);
			}
		});
	}
});
