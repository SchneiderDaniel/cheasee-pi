// ─── Tests: issue #2027 — duplicate function names consolidated ───
// CodeFlow's "duplicate function names" signal (execFn, info, error,
// unique_dir, apply, ingest_frame) is resolved when each name has a single
// home. This is the in-gate text-level acceptance proxy for the Rust side
// (no cargo in the pipeline image) plus the TS structural contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

const UI = "cmd/cheasee-pi/embedded/docker/ui/src";

// ─── Canonical single homes ──────────────────────────────────────

describe("canonical single homes exist", () => {
	it("toExecFn is the only pi.exec → ExecFn binding (lib/port-adapters.ts)", () => {
		assert.match(read(".pi/extensions/lib/port-adapters.ts"), /export function toExecFn\b/);
	});

	it("nullNotify / toNotifyFn live in pipeline/helpers.ts", () => {
		const src = read(".pi/extensions/supervisor/pipeline/helpers.ts");
		assert.match(src, /export function nullNotify\b/);
		assert.match(src, /export function toNotifyFn\b/);
	});

	it("unique_temp_dir is the single Rust temp-dir fixture (test_support.rs)", () => {
		assert.match(read(`${UI}/test_support.rs`), /pub fn unique_temp_dir\b/);
	});

	it("UiSlice / ingest_frame / decode_server_frame live in frame.rs", () => {
		const src = read(`${UI}/frame.rs`);
		assert.match(src, /pub enum UiSlice\b/);
		assert.match(src, /pub fn ingest_frame\b/);
		assert.match(src, /pub fn decode_server_frame\b/);
	});

	it("frame.rs is registered in lib.rs", () => {
		assert.match(read(`${UI}/lib.rs`), /pub mod frame;/);
	});

	it("the four reduce_* reducers exist and Assembler::apply is reduce_event", () => {
		assert.match(read(`${UI}/stream.rs`), /pub fn reduce_transcript\b/);
		assert.match(read(`${UI}/stream.rs`), /pub fn reduce_event\b/);
		assert.match(read(`${UI}/controls.rs`), /pub fn reduce_controls\b/);
		assert.match(read(`${UI}/extension_ui.rs`), /pub fn reduce_chrome\b/);
		assert.match(read(`${UI}/components/session_list.rs`), /pub fn reduce_sessions\b/);
	});
});

// ─── Old defining names are gone from the cited files ────────────

describe("old defining names are gone", () => {
	it("no `const execFn` binding remains in the three supervisor files", () => {
		for (const rel of [
			".pi/extensions/supervisor/index.ts",
			".pi/extensions/supervisor/pipeline/audit/index.ts",
			".pi/extensions/supervisor/pipeline/stages/empty-worktree.ts",
		]) {
			assert.ok(!read(rel).includes("const execFn"), `${rel} must not define const execFn`);
		}
	});

	it("no `fn unique_dir` / `fn temp_dir` fixtures remain", () => {
		for (const rel of ["auth.rs", "pi_process.rs", "rpc/client.rs"]) {
			assert.ok(
				!/fn\s+unique_dir\s*\(/.test(read(`${UI}/${rel}`)),
				`${rel} must not define unique_dir`,
			);
		}
		assert.ok(!/fn\s+temp_dir\s*\(/.test(read(`${UI}/sessions_store.rs`)));
	});

	it("no reducer `fn apply(` / `fn ingest_frame(` definitions remain", () => {
		for (const rel of ["stream.rs", "controls.rs", "extension_ui.rs", "components/session_list.rs"]) {
			const src = read(`${UI}/${rel}`);
			assert.ok(!/fn\s+apply\s*\(/.test(src), `${rel} must not define fn apply`);
			assert.ok(!/fn\s+ingest_frame\s*\(/.test(src), `${rel} must not define fn ingest_frame`);
		}
	});

	it("no `{ info, error }` NotifyFn literals remain in the cited handler/stage files", () => {
		for (const rel of [
			".pi/extensions/supervisor/pipeline/handler/preflight.ts",
			".pi/extensions/supervisor/pipeline/handler/post-pipeline.ts",
			".pi/extensions/supervisor/pipeline/stages/git-ops.ts",
		]) {
			const src = read(rel);
			assert.ok(
				!/info\s*:\s*\(\s*msg/.test(src),
				`${rel} must not inline an info NotifyFn literal`,
			);
		}
	});
});

// ─── Analyzer predicate: each flagged name defined in < 3 files ──

const CITES: Record<string, string[]> = {
	execFn: [
		".pi/extensions/supervisor/index.ts",
		".pi/extensions/supervisor/pipeline/audit/index.ts",
		".pi/extensions/supervisor/pipeline/stages/empty-worktree.ts",
	],
	info: [
		".pi/extensions/supervisor/lib/debug.ts",
		".pi/extensions/supervisor/pipeline/handler/post-pipeline.ts",
		".pi/extensions/supervisor/pipeline/handler/preflight.ts",
		".pi/extensions/supervisor/pipeline/stages/git-ops.ts",
		".pi/extensions/supervisor/pipeline/helpers.ts",
	],
	error: [
		".pi/extensions/supervisor/lib/debug.ts",
		".pi/extensions/supervisor/pipeline/handler/post-pipeline.ts",
		".pi/extensions/supervisor/pipeline/handler/preflight.ts",
		".pi/extensions/supervisor/pipeline/stages/git-ops.ts",
		".pi/extensions/supervisor/pipeline/helpers.ts",
	],
	unique_dir: [`${UI}/auth.rs`, `${UI}/pi_process.rs`, `${UI}/rpc/client.rs`],
	apply: [
		`${UI}/components/session_list.rs`,
		`${UI}/controls.rs`,
		`${UI}/extension_ui.rs`,
		`${UI}/stream.rs`,
	],
	ingest_frame: [
		`${UI}/components/session_list.rs`,
		`${UI}/controls.rs`,
		`${UI}/extension_ui.rs`,
		`${UI}/stream.rs`,
	],
};

const DEFINES: Record<string, RegExp> = {
	execFn: /^\s*const\s+execFn\b/m,
	info: /^\s*info\s*(?:\(|:\s*\()/m,
	error: /^\s*error\s*(?:\(|:\s*\()/m,
	unique_dir: /fn\s+unique_dir\s*\(/,
	apply: /fn\s+apply\s*\(/,
	ingest_frame: /fn\s+ingest_frame\s*\(/,
};

describe("duplicate-name predicate", () => {
	for (const [name, files] of Object.entries(CITES)) {
		it(`"${name}" is defined in fewer than 3 files`, () => {
			const defining = files.filter((rel) => DEFINES[name].test(read(rel)));
			assert.ok(
				defining.length < 3,
				`${name} still defined in ${defining.length} files: ${defining.join(", ")}`,
			);
		});
	}
});

// ─── Transport fans out through the single dispatcher ───────────

describe("ws.rs fans out through UiSlice", () => {
	it("uses decode_server_frame once and loops over the slices", () => {
		const src = read(`${UI}/ws.rs`);
		assert.match(src, /decode_server_frame/);
		assert.match(src, /UiSlice::Transcript/);
		assert.ok(!/\.ingest_frame\(/.test(src), "ws.rs must not call per-slice ingest_frame");
	});
});

describe("no bare .apply( call sites remain in the UI crate", () => {
	const files = [
		`${UI}/stream.rs`,
		`${UI}/controls.rs`,
		`${UI}/extension_ui.rs`,
		`${UI}/components/session_list.rs`,
		"cmd/cheasee-pi/embedded/docker/ui/tests/stream_assembly.rs",
		"cmd/cheasee-pi/embedded/docker/ui/tests/event_widgets.rs",
		"cmd/cheasee-pi/embedded/docker/ui/tests/extension_ui.rs",
		"cmd/cheasee-pi/embedded/docker/ui/tests/session_controls.rs",
	];
	for (const rel of files) {
		it(`${rel} has no .apply(`, () => {
			assert.ok(!/\.apply\(/.test(read(rel)), `${rel} still has a .apply( call site`);
		});
	}
});
