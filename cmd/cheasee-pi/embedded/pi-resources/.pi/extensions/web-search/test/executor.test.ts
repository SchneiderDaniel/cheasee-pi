/**
 * Tests for executor.ts — shSingleQuote, runSearchScript, parseSearchOutput, parseSearchResults
 *
 * Layer: (D) Domain/Unit — mock pi.exec, temp fs via fs.mkdtempSync.
 * No real Python, no network.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { ExecResult, ExecFn } from "../types.ts";
import { SEARCH_SCRIPT } from "../python-script.ts";
import {
	shSingleQuote,
	runSearchScript,
	parseSearchOutput,
	parseSearchResults,
	cleanupStaleTempDirs,
} from "../executor.ts";

type ExecHandler = ExecFn;

function makeMockExec(): ReturnType<typeof mock.fn<ExecHandler>> {
	return mock.fn<ExecHandler>();
}

describe("shSingleQuote — domain tests", () => {
	it("(D) empty string returns '' (two single quotes)", () => {
		assert.equal(shSingleQuote(""), "''", "empty string should produce two single quotes");
	});

	it("(D) plain string hello returns 'hello'", () => {
		assert.equal(
			shSingleQuote("hello"),
			"'hello'",
			"plain string should be wrapped in single quotes",
		);
	});

	it("(D) string with embedded single quote it's returns 'it'\\''s'", () => {
		const result = shSingleQuote("it's");
		assert.equal(result, "'it'\\''s'", "embedded single quote should be escaped");
	});

	it("(D) string with dollar sign returns '$PATH' (literal dollar)", () => {
		assert.equal(
			shSingleQuote("$PATH"),
			"'$PATH'",
			"dollar sign should be preserved literally inside quotes",
		);
	});

	it("(D) string with space '/my path' returns '/my path'", () => {
		assert.equal(shSingleQuote("/my path"), "'/my path'", "spaces should be safely quoted");
	});

	it("(D) string with newline returns $'...' type handling — newline should not break quoting", () => {
		const result = shSingleQuote("line1\nline2");
		assert.ok(result.startsWith("'"), "should start with single quote");
		assert.ok(result.endsWith("'"), "should end with single quote");
		// Newline inside single quotes is literal in bash
		assert.ok(result.includes("line1"), "should include first line");
		assert.ok(result.includes("line2"), "should include second line");
	});

	it("(D) string with backslash returns literal backslash", () => {
		const result = shSingleQuote("C:\\path\\to\\file");
		assert.equal(
			result,
			"'C:\\path\\to\\file'",
			"backslash should be literal inside single quotes",
		);
	});
});

describe("runSearchScript — executor", () => {
	it("(D) writes script and config under isolated temp directory, then calls exec with bash -c", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({
			code: 0,
			stdout: "SEARCH_OK\n{}\nSEARCH_DONE",
			stderr: "",
		}));

		await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test query", max_results: 5 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		const calls = exec.mock.calls;
		assert.ok(calls.length > 0, "exec should be called");
		const bashArgs = calls[0].arguments;
		assert.equal(bashArgs[0], "bash", "should run via bash");
		const fullCmd = bashArgs[1].join(" ");
		assert.ok(
			/search-[^/]+\/search\.py/.test(fullCmd),
			"command should reference search.py under isolated directory",
		);
		assert.ok(
			/search-[^/]+\/config\.json/.test(fullCmd),
			"command should reference config.json under isolated directory",
		);
		assert.ok(fullCmd.includes("/usr/bin/python3"), "command should reference python path");
	});

	it("(D) config is valid JSON with query, max_results keys", async () => {
		const exec = makeMockExec();
		let capturedConfig: Record<string, unknown> | null = null;
		exec.mock.mockImplementation(async (_cmd, args, _opts) => {
			const bashCmd = args.join(" ");
			const configMatch = bashCmd.match(/'([^']*config\.json)'/);
			if (configMatch) {
				const configPath = configMatch[1].replace(/\\'/g, "'");
				const configContent = fs.readFileSync(configPath, "utf-8");
				capturedConfig = JSON.parse(configContent);
			}
			return { code: 0, stdout: "SEARCH_OK\n{}\nSEARCH_DONE", stderr: "" };
		});

		await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "typescript best practices", max_results: 7 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		assert.ok(capturedConfig !== null, "config should have been captured");
		const config = capturedConfig as Record<string, unknown>;
		assert.equal(config.query, "typescript best practices");
		assert.equal(config.max_results, 7);
	});

	it("(D) includes optional proxy and timeout in config when provided", async () => {
		const exec = makeMockExec();
		let capturedConfig: Record<string, unknown> | null = null;
		exec.mock.mockImplementation(async (_cmd, args, _opts) => {
			const bashCmd = args.join(" ");
			const configMatch = bashCmd.match(/'([^']*config\.json)'/);
			if (configMatch) {
				const configPath = configMatch[1].replace(/\\'/g, "'");
				const configContent = fs.readFileSync(configPath, "utf-8");
				capturedConfig = JSON.parse(configContent);
			}
			return { code: 0, stdout: "SEARCH_OK\n{}\nSEARCH_DONE", stderr: "" };
		});

		await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 3, proxy: "http://proxy:8080", timeout: 10 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		assert.ok(capturedConfig !== null, "config should have been captured");
		const config = capturedConfig as Record<string, unknown>;
		assert.equal(config.proxy, "http://proxy:8080");
		assert.equal(config.timeout, 10);
	});

	it("(D) returns exec error when exec function fails", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({
			code: 1,
			stdout: "",
			stderr: "python3: not found",
		}));

		const result = await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 5 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("not found"));
	});

	it("(D) returns error when no exec function provided", async () => {
		const result = await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 5 },
			30_000,
		);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("no exec function provided"));
	});

	it("(D) no base64 dependency in command", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));

		await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 5 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		const calls = exec.mock.calls;
		const fullCmd = calls[0].arguments.join(" ");
		assert.ok(!fullCmd.includes("base64"), "command should not use base64");
		assert.ok(!fullCmd.includes("Buffer"), "command should not use Buffer");
	});

	describe("temp directory isolation and cleanup", () => {
		const TEST_RUN_DIR = path.join(process.cwd(), "ignore", "web-search");

		it("(D) temp directory cleaned up after execution", async () => {
			let capturedDirPath: string | null = null;
			const exec = makeMockExec();
			exec.mock.mockImplementation(async (cmd, args, opts) => {
				const bashCmd = args.join(" ");
				const dirMatch = bashCmd.match(/'([^']*search-[^/]+)\//);
				if (dirMatch) {
					capturedDirPath = dirMatch[1].replace(/\\'/g, "'");
				}
				return { code: 0, stdout: "SEARCH_OK\n{}\nSEARCH_DONE", stderr: "" };
			});

			await runSearchScript(
				"/usr/bin/python3",
				SEARCH_SCRIPT,
				{ query: "test", max_results: 5 },
				30_000,
				undefined,
				exec as unknown as ExecHandler,
			);

			assert.ok(capturedDirPath !== null, "should have captured dir path");
			assert.ok(!fs.existsSync(capturedDirPath!), "temp dir should be removed after execution");
		});

		it("(D) cleanup removes entire directory even if extra unknown files present", async () => {
			let capturedDirPath: string | null = null;
			const exec = makeMockExec();
			exec.mock.mockImplementation(async (cmd, args, opts) => {
				const bashCmd = args.join(" ");
				const dirMatch = bashCmd.match(/'([^']*search-[^/]+)\//);
				if (dirMatch) {
					capturedDirPath = dirMatch[1].replace(/\\'/g, "'");
					// Write an extra unknown file inside the temp dir
					fs.writeFileSync(path.join(capturedDirPath!, "extra.tmp"), "extra content", "utf-8");
				}
				return { code: 0, stdout: "SEARCH_OK\n{}\nSEARCH_DONE", stderr: "" };
			});

			await runSearchScript(
				"/usr/bin/python3",
				SEARCH_SCRIPT,
				{ query: "test", max_results: 5 },
				30_000,
				undefined,
				exec as unknown as ExecHandler,
			);

			assert.ok(capturedDirPath !== null, "should have captured dir path");
			assert.ok(!fs.existsSync(capturedDirPath!), "temp dir and extra files should be removed");
		});

		it("(D) cleanup never throws even when exec fails", async () => {
			let capturedDirPath: string | null = null;
			const exec = makeMockExec();
			exec.mock.mockImplementation(async (cmd, args, opts) => {
				const bashCmd = args.join(" ");
				const dirMatch = bashCmd.match(/'([^']*search-[^/]+)\//);
				if (dirMatch) {
					capturedDirPath = dirMatch[1].replace(/\\'/g, "'");
				}
				throw new Error("exec failed");
			});

			await assert.rejects(
				async () => {
					await runSearchScript(
						"/usr/bin/python3",
						SEARCH_SCRIPT,
						{ query: "test", max_results: 5 },
						30_000,
						undefined,
						exec as unknown as ExecHandler,
					);
				},
				{ message: "exec failed" },
			);

			// Cleanup should have happened despite the error
			if (capturedDirPath) {
				assert.ok(
					!fs.existsSync(capturedDirPath),
					"temp dir should be cleaned up even after exec error",
				);
			}
		});

		it("(D) per-call directory uniqueness — sequential calls produce different dirs", async () => {
			const dirs: string[] = [];
			const exec = makeMockExec();
			exec.mock.mockImplementation(async (cmd, args, opts) => {
				const bashCmd = args.join(" ");
				const dirMatch = bashCmd.match(/'([^']*search-[^/]+)\//);
				if (dirMatch) {
					dirs.push(dirMatch[1].replace(/\\'/g, "'"));
				}
				return { code: 0, stdout: "SEARCH_OK\n{}\nSEARCH_DONE", stderr: "" };
			});

			await runSearchScript(
				"/usr/bin/python3",
				SEARCH_SCRIPT,
				{ query: "a", max_results: 5 },
				30_000,
				undefined,
				exec as unknown as ExecHandler,
			);
			await runSearchScript(
				"/usr/bin/python3",
				SEARCH_SCRIPT,
				{ query: "b", max_results: 5 },
				30_000,
				undefined,
				exec as unknown as ExecHandler,
			);

			assert.equal(dirs.length, 2);
			assert.notEqual(dirs[0], dirs[1], "sequential calls should produce different temp dirs");
		});

		it("(D) per-call directory uniqueness — concurrent calls produce different dirs", async () => {
			const dirs: string[] = [];
			const exec = makeMockExec();
			exec.mock.mockImplementation(async (cmd, args, opts) => {
				const bashCmd = args.join(" ");
				const dirMatch = bashCmd.match(/'([^']*search-[^/]+)\//);
				if (dirMatch) {
					dirs.push(dirMatch[1].replace(/\\'/g, "'"));
				}
				return { code: 0, stdout: "SEARCH_OK\n{}\nSEARCH_DONE", stderr: "" };
			});

			await Promise.all([
				runSearchScript(
					"/usr/bin/python3",
					SEARCH_SCRIPT,
					{ query: "a", max_results: 5 },
					30_000,
					undefined,
					exec as unknown as ExecHandler,
				),
				runSearchScript(
					"/usr/bin/python3",
					SEARCH_SCRIPT,
					{ query: "b", max_results: 5 },
					30_000,
					undefined,
					exec as unknown as ExecHandler,
				),
			]);

			assert.equal(dirs.length, 2);
			assert.notEqual(dirs[0], dirs[1], "concurrent calls should produce different temp dirs");
		});

		describe("startup stale cleanup", () => {
			it("(D) startup stale cleanup removes orphaned temp dirs older than 1 hour", async () => {
				// Create a stale temp dir (mtime 2 hours ago)
				const staleDir = fs.mkdtempSync(path.join(TEST_RUN_DIR, "search-"));
				const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
				fs.utimesSync(staleDir, twoHoursAgo, twoHoursAgo);
				assert.ok(fs.existsSync(staleDir), "stale dir should exist before cleanup");

				cleanupStaleTempDirs();

				assert.ok(!fs.existsSync(staleDir), "stale temp dir should be removed");
			});

			it("(D) startup stale cleanup preserves recent temp dirs", async () => {
				// Create a recent temp dir
				const recentDir = fs.mkdtempSync(path.join(TEST_RUN_DIR, "search-"));
				assert.ok(fs.existsSync(recentDir), "recent dir should exist before cleanup");

				cleanupStaleTempDirs();

				assert.ok(fs.existsSync(recentDir), "recent temp dir should be preserved");

				// Clean up after test
				fs.rmSync(recentDir, { recursive: true, force: true });
			});

			it("(D) startup stale cleanup preserves non-temp files", async () => {
				// Create a non-temp file at the root of RUN_DIR
				const nonTempFile = path.join(TEST_RUN_DIR, ".gitkeep");
				if (!fs.existsSync(TEST_RUN_DIR)) {
					fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
				}
				fs.writeFileSync(nonTempFile, "", "utf-8");
				assert.ok(fs.existsSync(nonTempFile), ".gitkeep should exist before cleanup");

				cleanupStaleTempDirs();

				assert.ok(fs.existsSync(nonTempFile), "non-temp files should be preserved");

				// Clean up after test
				fs.rmSync(nonTempFile, { force: true });
			});
		});
	});
});

describe("parseSearchOutput — delimiter parsing", () => {
	it("(D) extracts JSON between delimiters", () => {
		const stdout = 'SEARCH_OK\n{"ok":true,"results":[]}\nSEARCH_DONE';
		const json = parseSearchOutput(stdout);
		assert.equal(json, '{"ok":true,"results":[]}', "should extract JSON between delimiters");
	});

	it("(D) extracts JSON with trailing garbage after SEARCH_DONE", () => {
		const stdout = 'SEARCH_OK\n{"ok":true}\nSEARCH_DONE\nsome trailing garbage that got truncated';
		const json = parseSearchOutput(stdout);
		assert.equal(json, '{"ok":true}', "should extract JSON even with trailing garbage");
	});

	it("(D) extracts JSON with logger noise before delimiters", () => {
		const stdout = '{bad log line}\nSEARCH_OK\n{"ok":true}\nSEARCH_DONE';
		const json = parseSearchOutput(stdout);
		assert.equal(json, '{"ok":true}', "should extract JSON despite log lines with braces");
	});

	it("(D) empty delimiter region returns null", () => {
		const stdout = "SEARCH_OK\nSEARCH_DONE";
		const json = parseSearchOutput(stdout);
		assert.equal(json, null, "should return null when no JSON between delimiters");
	});

	it("(D) no delimiters at all returns null", () => {
		const stdout = "some random output";
		const json = parseSearchOutput(stdout);
		assert.equal(json, null, "should return null when no delimiters");
	});

	it("(D) multi-line JSON between delimiters", () => {
		const stdout = 'SEARCH_OK\n{\n  "ok": true,\n  "results": []\n}\nSEARCH_DONE';
		const json = parseSearchOutput(stdout);
		assert.ok(json !== null, "should extract multi-line JSON");
		assert.ok(json.includes('"ok"'), "extracted text should contain JSON content");
	});

	it("(D) returns null when SEARCH_OK appears after SEARCH_DONE", () => {
		const stdout = 'SEARCH_DONE\n{"ok":true}\nSEARCH_OK';
		const json = parseSearchOutput(stdout);
		assert.equal(json, null, "should return null when delimiters are reversed");
	});
});

describe("parseSearchResults — result parsing", () => {
	it("(D) parses successful results correctly", () => {
		const stdout =
			'SEARCH_OK\n{"ok":true,"results":[{"title":"Test","url":"https://example.com","snippet":"A test result"}]}\nSEARCH_DONE';
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0].title, "Test");
			assert.equal(result.results[0].url, "https://example.com");
			assert.equal(result.results[0].snippet, "A test result");
		}
	});

	it("(D) handles error response from script", () => {
		const stdout = 'SEARCH_OK\n{"ok":false,"error":"ddgs not installed"}\nSEARCH_DONE';
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("ddgs not installed"));
		}
	});

	it("(D) handles no delimited output", () => {
		const stdout = "some random output";
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("No delimited output found"));
		}
	});

	it("(D) handles malformed JSON", () => {
		const stdout = "SEARCH_OK\n{broken json\nSEARCH_DONE";
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("Failed to parse"));
		}
	});

	it("(D) handles empty results array", () => {
		const stdout = 'SEARCH_OK\n{"ok":true,"results":[]}\nSEARCH_DONE';
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 0);
		}
	});
});
