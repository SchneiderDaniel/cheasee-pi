/**
 * Tests for Ripgrep Search (ripgrep literal text search)
 *
 * Pure function tests import from .pi/extensions/ripgrep-search/ modules
 * instead of maintaining inline copies (avoids divergence risk).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ripgrep-search/test/ripgrep-search.test.mts
 *
 * Integration test runs real rg against .pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/
 * (skipped if rg binary not installed).
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { parseVimgrepOutput, parseGrepOutput } from "../backends.ts";
import { getCachedResult, setCachedResult, clearCache, resultCache } from "../internal.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
describe("cache invalidation on tool_result (Issue 1900)", () => {
	let tmpCwd: string;
	let handlers: Map<string, Function>;
	let tool: any;
	let searchExecCount: number;
	let execStdout: string;

	function seed(query = "needle", directory = ".", maxCount = 10): void {
		setCachedResult(query, directory, maxCount, {
			result: { total_returned: 1, results: [{ file: "a.txt", line: 1, column: 1, text: query }] },
			rawStdout: `a.txt:1:${query}`,
		});
	}

	async function fireToolResult(event: unknown): Promise<void> {
		const handler = handlers.get("tool_result");
		assert.ok(handler, "tool_result handler must be registered");
		await handler!(event);
	}

	function makeMockPi() {
		handlers = new Map();
		searchExecCount = 0;
		const pi = {
			on: (e: string, h: Function) => handlers.set(e, h),
			registerTool: (t: any) => {
				tool = t;
			},
			exec: async (command: string, _args: string[]) => {
				if (command === "rg") return { code: 1, stdout: "", stderr: "" };
				searchExecCount++;
				return { code: execStdout ? 0 : 1, stdout: execStdout, stderr: "" };
			},
		};
		return pi;
	}

	async function call(query = "needle", directory = ".", maxCount?: number): Promise<any> {
		const params: Record<string, unknown> = { query, directory };
		if (maxCount !== undefined) params.max_count = maxCount;
		return tool.execute("tc", params, undefined, undefined, { cwd: tmpCwd });
	}

	beforeEach(async () => {
		clearCache();
		execStdout = "a.txt:1:needle";
		tmpCwd = mkdtempSync(join(tmpdir(), "pi-rg-inval-"));
		mkdirSync(join(tmpCwd, ".pi"));
		writeFileSync(
			join(tmpCwd, ".pi", "settings.json"),
			JSON.stringify({ search: { searchBackend: "grep" } }),
		);
		writeFileSync(join(tmpCwd, "a.txt"), "needle\n");
		const { default: ripgrepSearch } = await import("../index.ts");
		ripgrepSearch(makeMockPi() as any);
	});

	afterEach(() => {
		clearCache();
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	// ── Phase 2: handler wiring ──

	it("registers a tool_result handler alongside session_shutdown", () => {
		assert.ok(handlers.has("tool_result"), "tool_result handler should be registered");
		assert.ok(handlers.has("session_shutdown"), "session_shutdown handler should remain");
	});

	it('{toolName:"write"} empties resultCache', async () => {
		seed();
		assert.strictEqual(resultCache.size, 1);
		await fireToolResult({ toolName: "write" });
		assert.strictEqual(resultCache.size, 0);
	});

	it('{toolName:"edit"} empties resultCache', async () => {
		seed();
		await fireToolResult({ toolName: "edit" });
		assert.strictEqual(resultCache.size, 0);
	});

	it('{toolName:"bash"} empties resultCache', async () => {
		seed();
		await fireToolResult({ toolName: "bash", input: { command: "git status" } });
		assert.strictEqual(resultCache.size, 0);
	});

	it('{toolName:"unknown_new_tool"} empties resultCache (fail-closed)', async () => {
		seed();
		await fireToolResult({ toolName: "unknown_new_tool" });
		assert.strictEqual(resultCache.size, 0);
	});

	it("read-only tools leave seeded entries intact", async () => {
		seed("a", ".");
		seed("b", ".");
		await fireToolResult({ toolName: "read" });
		await fireToolResult({ toolName: "ripgrep_search" });
		assert.strictEqual(resultCache.size, 2);
	});

	it('{toolName:"write", isError:true} still empties (fail-closed)', async () => {
		seed();
		await fireToolResult({ toolName: "write", isError: true });
		assert.strictEqual(resultCache.size, 0);
	});

	it("malformed event {} does not throw and empties (unknown ⇒ invalidate)", async () => {
		seed();
		await fireToolResult({});
		assert.strictEqual(resultCache.size, 0);
	});

	it("event with input undefined does not throw", async () => {
		seed();
		await fireToolResult({ toolName: "write", input: undefined });
		assert.strictEqual(resultCache.size, 0);
	});

	it("invalidation is whole-cache across directories and widths", async () => {
		seed("a", "src", 10);
		seed("a", "src", 500);
		seed("b", "lib", 10);
		assert.strictEqual(resultCache.size, 3);
		await fireToolResult({ toolName: "edit", input: { path: "src/a.ts" } });
		assert.strictEqual(resultCache.size, 0);
	});

	it("regression: session_shutdown handler still empties resultCache", async () => {
		seed();
		const handler = handlers.get("session_shutdown");
		assert.ok(handler, "session_shutdown handler must remain registered");
		await handler!();
		assert.strictEqual(resultCache.size, 0);
	});

	// ── Phase 3: staleness reproduction + preserved dedup ──

	it("seed + write tool_result → getCachedResult returns undefined", async () => {
		seed();
		await fireToolResult({ toolName: "write" });
		assert.strictEqual(getCachedResult("needle", ".", 10), undefined);
	});

	it("two identical searches with no mutation → one exec (dedup preserved)", async () => {
		await call();
		await call();
		assert.strictEqual(searchExecCount, 1);
	});

	it("search → write tool_result → identical search re-execs and reflects new output", async () => {
		const r1 = await call();
		assert.strictEqual(r1.structuredContent.total_returned, 1);
		await fireToolResult({ toolName: "write", input: { path: "a.txt" } });
		execStdout = ""; // rg actually reports 0 after the edit
		const r2 = await call();
		assert.strictEqual(searchExecCount, 2, "post-edit search must re-run");
		assert.strictEqual(r2.structuredContent.total_returned, 0);
	});

	it("a mutation invalidates every cached key, not only the edited path", async () => {
		seed("a", "src", 10);
		seed("b", "lib", 500);
		await fireToolResult({ toolName: "bash" });
		assert.strictEqual(getCachedResult("a", "src", 10), undefined);
		assert.strictEqual(getCachedResult("b", "lib", 500), undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Cache invalidation — real rg staleness proof (Issue 1900)
// ═══════════════════════════════════════════════════════════════════

describe("cache invalidation — real rg staleness (Issue 1900)", () => {
	const hasRg = (() => {
		try {
			execSync("rg --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();
	const skipMsg = "rg binary not installed — skip integration test";

	it(
		"post-edit identical search reflects current on-disk content",
		{ skip: !hasRg ? skipMsg : false, timeout: 20_000 },
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-rg-real-"));
			try {
				mkdirSync(join(dir, ".pi"), { recursive: true });
				writeFileSync(
					join(dir, ".pi", "settings.json"),
					JSON.stringify({ search: { searchBackend: "auto" } }),
				);
				const file = join(dir, "a.txt");
				writeFileSync(file, "needle\n");

				const handlers = new Map<string, Function>();
				let tool: any;
				const exec = async (command: string, args: string[]) => {
					try {
						const stdout = execFileSync(command, args, {
							cwd: dir,
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "pipe"],
						});
						return { code: 0, stdout, stderr: "" };
					} catch (e: unknown) {
						const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
						return {
							code: typeof err.status === "number" ? err.status : 1,
							stdout: err.stdout != null ? String(err.stdout) : "",
							stderr: err.stderr != null ? String(err.stderr) : "",
						};
					}
				};
				const pi = {
					on: (e: string, h: Function) => handlers.set(e, h),
					registerTool: (t: any) => {
						tool = t;
					},
					exec,
				};
				clearCache();
				const { default: ripgrepSearch } = await import("../index.ts");
				ripgrepSearch(pi as any);

				const first = await tool.execute(
					"tc",
					{ query: "needle", directory: "." },
					undefined,
					undefined,
					{ cwd: dir },
				);
				assert.strictEqual(
					first.structuredContent.total_returned,
					1,
					"pre-edit search finds the needle",
				);

				writeFileSync(file, "nothing to see\n");
				await handlers.get("tool_result")!({ toolName: "edit", input: { path: "a.txt" } });

				const second = await tool.execute(
					"tc",
					{ query: "needle", directory: "." },
					undefined,
					undefined,
					{ cwd: dir },
				);
				assert.strictEqual(
					second.structuredContent.total_returned,
					0,
					"post-edit search must reflect on-disk state, not the cached pre-edit set",
				);
			} finally {
				clearCache();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

// ═══════════════════════════════════════════════════════════════════════
// Backend output parsers (Issue 1896)
//
// All probes go through the two public functions; the extracted shared
// loop is module-private and intentionally untested directly.
// ═══════════════════════════════════════════════════════════════════════

describe("backend output parsers", () => {
	const parsers = { vimgrep: parseVimgrepOutput, grep: parseGrepOutput } as const;

	// Semantically equivalent pairs: same file+line+text, vimgrep carries a
	// real column while grep's column is hard-coded to 1.
	const vim = (file: string, line: number, column: number, text: string) =>
		`${file}:${line}:${column}:${text}`;
	const grep = (file: string, line: number, text: string) => `${file}:${line}:${text}`;

	describe("empty guard", () => {
		for (const name of ["vimgrep", "grep"] as const) {
			it(`${name} — null/undefined/"" return empty shape without a truncated key`, () => {
				for (const raw of [null, undefined, ""]) {
					assert.deepStrictEqual(parsers[name](raw as any), {
						total_returned: 0,
						results: [],
					});
				}
			});
		}
	});

	describe("blank and malformed lines", () => {
		it("blank/whitespace-only lines are skipped, not counted", () => {
			const raw = "\n\t\na.ts:1:1:x\n   \nb.ts:2:1:y\n\n";
			const r = parseVimgrepOutput(raw);
			assert.strictEqual(r.total_returned, 2);
			assert.deepStrictEqual(
				r.results.map((m) => m.file),
				["a.ts", "b.ts"],
			);
		});

		it("malformed lines are skipped without counting", () => {
			const raw = "not a match line\na.ts:x:text\na.ts:5\na.ts:5:3:ok";
			const r = parseVimgrepOutput(raw);
			assert.strictEqual(r.total_returned, 1);
			assert.strictEqual(r.results[0].text, "ok");

			const g = parseGrepOutput("not a match line\na.ts:x:text\na.ts:5:ok");
			assert.strictEqual(g.total_returned, 1);
			assert.strictEqual(g.results[0].text, "ok");
		});
	});

	describe("capture semantics", () => {
		it("vimgrep preserves colons in text (capture group 4)", () => {
			const r = parseVimgrepOutput(vim("a.ts", 5, 3, "key: value: extra"));
			assert.deepStrictEqual(r.results[0], {
				file: "a.ts",
				line: 5,
				column: 3,
				text: "key: value: extra",
			});
		});

		it("grep preserves colons in text (capture group 3)", () => {
			const r = parseGrepOutput(grep("a.ts", 5, "key: value: extra"));
			assert.deepStrictEqual(r.results[0], {
				file: "a.ts",
				line: 5,
				column: 1,
				text: "key: value: extra",
			});
		});

		it("column semantics: vimgrep parses it, grep hard-codes 1", () => {
			assert.strictEqual(parseVimgrepOutput("a.ts:5:12:text").results[0].column, 12);
			assert.strictEqual(parseGrepOutput("a.ts:5:text").results[0].column, 1);
		});

		it("file path with a ./ prefix is preserved verbatim", () => {
			assert.strictEqual(parseVimgrepOutput("./src/a.ts:5:3:x").results[0].file, "./src/a.ts");
			assert.strictEqual(parseGrepOutput("./src/a.ts:5:x").results[0].file, "./src/a.ts");
		});
	});

	describe("truncation accounting", () => {
		const vimLines = (n: number) =>
			Array.from({ length: n }, (_, i) => vim("a.ts", i + 1, i + 2, `m${i}`)).join("\n");
		const grepLines = (n: number) =>
			Array.from({ length: n }, (_, i) => grep("a.ts", i + 1, `m${i}`)).join("\n");

		it("total_returned is uncapped while results respects the cap", () => {
			const r = parseVimgrepOutput(vimLines(5), 2);
			assert.strictEqual(r.total_returned, 5);
			assert.strictEqual(r.results.length, 2);
			assert.strictEqual(r.truncated, true);
		});

		it("truncated is true iff total matches exceed maxResults", () => {
			assert.strictEqual(parseGrepOutput(grepLines(3), 2).truncated, true);
			assert.strictEqual(parseGrepOutput(grepLines(3), 3).truncated, false);
			assert.strictEqual(parseGrepOutput(grepLines(3), 3).results.length, 3);
		});

		it("maxResults=0 yields no results but still counts matches", () => {
			const r = parseVimgrepOutput(vimLines(2), 0);
			assert.deepStrictEqual(r.results, []);
			assert.ok(r.total_returned > 0);
			assert.strictEqual(r.truncated, true);
		});

		it("default maxResults (Infinity) returns everything, truncated is strict false", () => {
			for (const name of ["vimgrep", "grep"] as const) {
				const raw = name === "vimgrep" ? vimLines(4) : grepLines(4);
				const r = parsers[name](raw);
				assert.strictEqual(r.results.length, 4);
				assert.strictEqual(r.total_returned, 4);
				assert.strictEqual(r.truncated, false);
			}
		});

		it("non-empty-path result has the exact RgMatch shape with numeric fields", () => {
			for (const name of ["vimgrep", "grep"] as const) {
				const raw = name === "vimgrep" ? vimLines(1) : grepLines(1);
				const entry = parsers[name](raw).results[0];
				assert.deepStrictEqual(Object.keys(entry).sort(), ["column", "file", "line", "text"]);
				assert.strictEqual(typeof entry.line, "number");
				assert.strictEqual(typeof entry.column, "number");
				assert.ok(!Number.isNaN(entry.line));
				assert.ok(!Number.isNaN(entry.column));
			}
		});
	});

	describe("drift guard — parity across both backends", () => {
		it("semantically equivalent input yields identical accounting and fields", () => {
			const table: Array<{ vim: string; grep: string }> = [
				{ vim: vim("a.ts", 1, 7, "alpha"), grep: grep("a.ts", 1, "alpha") },
				{ vim: vim("src/b.ts", 42, 3, "beta: x"), grep: grep("src/b.ts", 42, "beta: x") },
				{ vim: vim("./c.ts", 9, 1, ""), grep: grep("./c.ts", 9, "") },
			];
			for (const max of [Infinity, 2, 0]) {
				const lines = table.length;
				const v = parseVimgrepOutput(table.map((t) => t.vim).join("\n"), max);
				const g = parseGrepOutput(table.map((t) => t.grep).join("\n"), max);
				assert.strictEqual(v.total_returned, g.total_returned, `total @ max=${max}`);
				assert.strictEqual(v.total_returned, lines);
				assert.strictEqual(v.truncated, g.truncated, `truncated @ max=${max}`);
				assert.strictEqual(v.results.length, g.results.length, `len @ max=${max}`);
				for (let i = 0; i < v.results.length; i++) {
					assert.strictEqual(v.results[i].file, g.results[i].file);
					assert.strictEqual(v.results[i].line, g.results[i].line);
					assert.strictEqual(v.results[i].text, g.results[i].text);
				}
			}
		});
	});
});
