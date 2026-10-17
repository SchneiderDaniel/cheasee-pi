/**
 * Golden characterization tests for session-logger/renderer.ts.
 *
 * Captures byte-for-byte .md render output AND parseSessionStats JSON
 * snapshots (the metadata.json consumer) for representative session
 * fixtures, so the 321-line renderSessionToMarkdown split can be proven
 * output-equivalent (Feathers characterization-test pattern).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-renderer-golden.test.mts
 * Regenerate goldens (only when the renderer intentionally changes):
 *   GOLDEN_UPDATE=1 node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-renderer-golden.test.mts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSessionToMarkdown, parseSessionStats } from "../renderer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "fixtures", "session-logger-renderer-goldens");
const UPDATE = process.env.GOLDEN_UPDATE === "1";

import { CASES, sessionHeader } from "./session-logger-renderer-golden-fixtures.mts";

// ─── Golden helpers ────────────────────────────────────────────────

function goldenPath(name: string, ext: string): string {
	return join(GOLDEN_DIR, `${name}.${ext}`);
}

describe("session-logger renderer golden characterization (byte-for-byte)", () => {
	for (const c of CASES) {
		it(`renders ${c.name} (md + stats)`, () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-logger-golden-"));
			try {
				const filepath = path.join(tmpDir, "test-session.jsonl");
				const lines = c.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
				writeFileSync(filepath, lines, "utf-8");

				const md = renderSessionToMarkdown(filepath, c.overrides);
				const stats = parseSessionStats(filepath);

				const mdFile = goldenPath(c.name, "md");
				const statsFile = goldenPath(c.name, "stats.json");
				if (UPDATE) {
					mkdirSync(GOLDEN_DIR, { recursive: true });
					writeFileSync(mdFile, md + "\n", "utf8");
					writeFileSync(statsFile, JSON.stringify(stats, null, 2) + "\n", "utf8");
					return;
				}
				assert.ok(
					existsSync(mdFile),
					`missing golden ${mdFile} — run with GOLDEN_UPDATE=1 to create`,
				);
				assert.equal(md + "\n", readFileSync(mdFile, "utf8"), `md golden mismatch for ${c.name}`);
				assert.ok(
					existsSync(statsFile),
					`missing golden ${statsFile} — run with GOLDEN_UPDATE=1 to create`,
				);
				assert.equal(
					JSON.stringify(stats, null, 2) + "\n",
					readFileSync(statsFile, "utf8"),
					`stats golden mismatch for ${c.name}`,
				);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	}
});

// ─── Version handling (fixture version is numeric) ─────────────────

function writeJsonlTo(dir: string, entries: Record<string, unknown>[]): string {
	const filepath = path.join(dir, "test-session.jsonl");
	const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(filepath, lines, "utf-8");
	return filepath;
}

describe("session-logger renderer version handling", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-logger-golden-ver-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("header-only fixture → stats.version is numeric 3", () => {
		const filepath = writeJsonlTo(tmpDir, [sessionHeader()]);
		const stats = parseSessionStats(filepath);
		assert.ok(stats, "expected stats");
		assert.equal(stats.version, 3);
		assert.equal(typeof stats.version, "number");
	});

	it("header missing version → stats.version === 0", () => {
		const filepath = writeJsonlTo(tmpDir, [
			{ type: "session", id: "no-ver", timestamp: "2025-06-01T10:00:00Z", cwd: "/tmp" },
		]);
		const stats = parseSessionStats(filepath);
		assert.ok(stats, "expected stats");
		assert.equal(stats.version, 0);
	});

	it("no stale string-version fixtures remain in golden corpus", () => {
		const files = readdirSync(GOLDEN_DIR).filter(
			(f) => f.endsWith(".md") || f.endsWith(".stats.json"),
		);
		assert.ok(files.length > 0, "expected golden fixtures present");
		for (const f of files) {
			const content = readFileSync(join(GOLDEN_DIR, f), "utf8");
			assert.ok(
				!content.includes('"version": "1.0"') && !content.includes("| **Version** | 1.0 |"),
				`stale string version in ${f}`,
			);
		}
	});
});

// ─── Boundary error paths ──────────────────────────────────────────

describe("session-logger renderer boundary error paths", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-logger-golden-edge-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("missing file → ENOENT propagates from renderSessionToMarkdown", () => {
		assert.throws(() => renderSessionToMarkdown(path.join(tmpDir, "missing.jsonl")), {
			code: "ENOENT",
		});
	});

	it("missing file → ENOENT propagates from parseSessionStats", () => {
		assert.throws(() => parseSessionStats(path.join(tmpDir, "missing.jsonl")), {
			code: "ENOENT",
		});
	});

	it("malformed JSON line → SyntaxError propagates from renderSessionToMarkdown", () => {
		const filepath = path.join(tmpDir, "bad.jsonl");
		fs.writeFileSync(filepath, '{"type":"session"}\n{not json\n', "utf-8");
		assert.throws(() => renderSessionToMarkdown(filepath), SyntaxError);
	});

	it("malformed JSON line → SyntaxError propagates from parseSessionStats", () => {
		const filepath = path.join(tmpDir, "bad.jsonl");
		fs.writeFileSync(filepath, '{"type":"session"}\n{not json\n', "utf-8");
		assert.throws(() => parseSessionStats(filepath), SyntaxError);
	});

	it("empty file → renderSessionToMarkdown returns '*Empty session*'", () => {
		const filepath = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(filepath, "", "utf-8");
		assert.equal(renderSessionToMarkdown(filepath), "*Empty session*");
	});

	it("whitespace-only file → renderSessionToMarkdown returns '*Empty session*'", () => {
		const filepath = path.join(tmpDir, "blank.jsonl");
		fs.writeFileSync(filepath, "  \n\n  ", "utf-8");
		assert.equal(renderSessionToMarkdown(filepath), "*Empty session*");
	});

	it("empty file → parseSessionStats returns null", () => {
		const filepath = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(filepath, "", "utf-8");
		assert.equal(parseSessionStats(filepath), null);
	});

	it("unknown entry type is skipped silently", () => {
		const filepath = writeJsonl([sessionHeader(), { type: "mystery-entry", data: { x: 1 } }]);
		const out = renderSessionToMarkdown(filepath);
		assert.ok(!out.includes("mystery-entry"));
	});

	it("message with unknown role renders nothing, no crash", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "weird", content: [{ type: "text", text: "x" }] } },
		]);
		const out = renderSessionToMarkdown(filepath);
		assert.ok(!out.includes("weird"));
	});
});

// ─── Structural guard (split integrity) ────────────────────────────
// Precedent: supervisor/test/message-renderers.test.mts — every renderer/*
// module imports standalone (no TDZ/cycle) and nothing imports back into
// the public renderer.ts entry.

describe("renderer/* import standalone (no ESM cycle)", () => {
	const dir = join(__dirname, "..", "renderer");
	const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

	for (const f of files) {
		it(`${f} dynamically imports without TDZ errors`, async () => {
			await import(`../renderer/${f}`);
		});
	}

	it("no renderer/* imports back from renderer.ts", () => {
		for (const f of files) {
			const source = readFileSync(join(dir, f), "utf8");
			assert.ok(
				!source.includes('from "../renderer.ts"'),
				`${f} must not import back from renderer.ts (ESM cycle risk)`,
			);
		}
	});

	it("parse.ts does not import host parseSessionEntries/migrateSessionEntries", () => {
		// Reinvention #1403 settled: the fail-closed manual parse stays. Any
		// import of the host package's parse/migrate helpers would violate the
		// docstring contract in parse.ts.
		const source = readFileSync(join(dir, "parse.ts"), "utf8");
		assert.ok(
			!source.includes('from "@earendil-works/pi-coding-agent"'),
			"parse.ts must not import host parse/migrate helpers (reinvention #1403)",
		);
	});
});
