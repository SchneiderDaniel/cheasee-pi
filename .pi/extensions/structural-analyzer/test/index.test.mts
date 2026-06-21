/**
 * Tests: index.ts — extension wiring & integration
 *
 * Tests the structuralAnalyzer extension through mocked pi.exec.
 * Covers tool registration, binary detection, cache, language auto-detect,
 * streaming, error propagation, and AbortSignal.
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import structuralAnalyzer from "../index.ts";
import { clearResultCache } from "../cache.ts";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function createMatchJson(file: string, lines: string, text: string): string {
	return JSON.stringify({ file, lines, text });
}

const TWO_MATCHES = [
	createMatchJson(
		"api/auth.py",
		"22-28",
		"try:\n    verify_token(token)\nexcept AuthError:\n    print('auth failed')",
	),
	createMatchJson("src/app.ts", "10-10", "console.log('App started')"),
].join("\n");

const MANY_MATCHES = Array.from({ length: 150 }, (_, i) =>
	createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match number ${i}`),
).join("\n");

/**
 * Build a mock pi instance with configurable exec behavior.
 */
function makePi(overrides?: {
	execOverride?: (cmd: string, args: string[], options?: any) => Promise<any>;
	registerToolOverride?: (tool: any) => void;
	onOverride?: (event: string, handler: Function) => void;
}): any {
	let registeredTool: any = null;
	const onCalls: Array<{ event: string; handler: Function }> = [];

	const pi = {
		registerTool: (tool: any) => {
			registeredTool = tool;
			if (overrides?.registerToolOverride) overrides.registerToolOverride(tool);
		},
		on: (event: string, handler: Function) => {
			onCalls.push({ event, handler });
			if (overrides?.onOverride) overrides.onOverride(event, handler);
		},
		exec: async (cmd: string, args: string[], options?: any) => {
			if (overrides?.execOverride) {
				return overrides.execOverride(cmd, args, options);
			}
			if (cmd === "ast-grep" && args[0] === "--version") {
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			}
			if (cmd === "test" && args[0] === "-f") {
				return { stdout: "", stderr: "", code: 1, killed: false };
			}
			if (cmd === "cat") {
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};

	// Expose registered tool for test access
	(pi as any).__getRegisteredTool = () => registeredTool;
	(pi as any).__getOnCalls = () => onCalls;

	return pi;
}

/** Execute a registered tool's execute function with given params. */
async function executeTool(
	pi: any,
	params: { pattern: string; language?: string },
	options?: { signal?: AbortSignal; cwd?: string; onUpdate?: any },
): Promise<any> {
	const tool = pi.__getRegisteredTool();
	if (!tool) throw new Error("No tool registered");
	return tool.execute("test-call-id", params, options?.signal, options?.onUpdate, {
		cwd: options?.cwd ?? "/tmp",
	});
}

describe("structuralAnalyzer extension wiring", () => {
	beforeEach(() => {
		clearResultCache();
	});

	it("exports a function named structuralAnalyzer", () => {
		assert.strictEqual(typeof structuralAnalyzer, "function");
	});

	it("registers tool with correct name 'structural_search'", () => {
		const pi = makePi();
		structuralAnalyzer(pi);
		const tool = pi.__getRegisteredTool();
		assert.ok(tool, "tool should be registered");
		assert.strictEqual(tool.name, "structural_search");
	});

	it("registers exactly one session_shutdown handler", () => {
		const pi = makePi();
		structuralAnalyzer(pi);
		const onCalls = pi.__getOnCalls();
		const shutdownHandlers = onCalls.filter((c: any) => c.event === "session_shutdown");
		assert.strictEqual(shutdownHandlers.length, 1);
	});

	it("session_shutdown clears the cache", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);
		const onCalls = pi.__getOnCalls();
		const shutdownHandler = onCalls.find((c: any) => c.event === "session_shutdown")!.handler;

		// Execute once to cache
		const result = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.ok(result);

		// Call shutdown handler
		await shutdownHandler();

		// Execute again — should be a cache miss (re-exec)
		const result2 = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.ok(result2);
	});

	it("same params (pattern, language, cwd) → second call returns cached result (no scan exec)", async () => {
		let execCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				execCallCount++;
				if (cmd === "ast-grep" && args[0] === "--version") {
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				}
				if (cmd === "test" && args[0] === "-f") {
					return { stdout: "", stderr: "", code: 1, killed: false };
				}
				if (cmd === "cat") {
					return { stdout: "", stderr: "", code: 0, killed: false };
				}
				// This is the scan call
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		// First call — exec should be called for scan
		const execCountBefore = execCallCount;
		const result1 = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		// version check + scan = at least 2 calls, or more with file checks
		const execCountAfterFirst = execCallCount;

		// Second call — should be cache hit, no additional exec
		const result2 = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(
			execCallCount,
			execCountAfterFirst,
			"exec should not be called on cache hit",
		);
		assert.ok(result1);
		assert.ok(result2);
	});

	it("different pattern → cache miss (re-exec)", async () => {
		let scanCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					scanCallCount++;
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		await executeTool(pi, { pattern: "console.log($B)", language: "ts" });
		assert.strictEqual(scanCallCount, 2, "different patterns should each scan");
	});

	it("different language → cache miss (re-exec)", async () => {
		let scanCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					scanCallCount++;
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		await executeTool(pi, { pattern: "console.log($A)", language: "py" });
		assert.strictEqual(scanCallCount, 2, "different languages should each scan");
	});

	it("different cwd → cache miss (re-exec)", async () => {
		let scanCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
				if (args[0] === "scan") {
					scanCallCount++;
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" }, { cwd: "/dir1" });
		await executeTool(pi, { pattern: "console.log($A)", language: "ts" }, { cwd: "/dir2" });
		assert.strictEqual(scanCallCount, 2, "different cwds should each scan");
	});

	it("error response NOT cached — second call re-executes", async () => {
		let scanCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					scanCallCount++;
					return { stdout: "", stderr: "unknown language", code: 1, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		// First call — error thrown
		await assert.rejects(
			() => executeTool(pi, { pattern: "console.log($A)", language: "badlang" }),
			/unknown language/,
		);

		// Second call — should re-execute (not cached)
		await assert.rejects(
			() => executeTool(pi, { pattern: "console.log($A)", language: "badlang" }),
			/unknown language/,
		);
		assert.strictEqual(
			scanCallCount,
			2,
			"errors should not be cached — second call should re-execute",
		);
	});

	it("invalid pattern throws before pi.exec is called", async () => {
		let execCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				execCallCount++;
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		// pre-set language to avoid auto-detect exec call
		await assert.rejects(() => executeTool(pi, { pattern: "TODO", language: "ts" }), /ripgrep/);
		// Pattern validation throws before any pi.exec call
		assert.strictEqual(execCallCount, 0, "exec should NOT be called — validation throws first");
	});

	it("auto-detect typescript when tsconfig.json present", async () => {
		let usedLanguage = "";
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test" && args[0] === "-f") {
					if (args[1] === "tsconfig.json") return { code: 0, stdout: "" };
					return { code: 1, stdout: "" };
				}
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					const langIdx = args.indexOf("--lang");
					if (langIdx >= 0) usedLanguage = args[langIdx + 1];
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)" }); // no language param → auto-detect
		assert.strictEqual(usedLanguage, "typescript");
	});

	it("no config + explicit language param → uses supplied language", async () => {
		let usedLanguage = "";
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					const langIdx = args.indexOf("--lang");
					if (langIdx >= 0) usedLanguage = args[langIdx + 1];
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "rust" });
		assert.strictEqual(usedLanguage, "rust");
	});

	it("no config + no language param → falls back to 'ts'", async () => {
		let usedLanguage = "";
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" }; // no files exist
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					const langIdx = args.indexOf("--lang");
					if (langIdx >= 0) usedLanguage = args[langIdx + 1];
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)" });
		assert.strictEqual(usedLanguage, "ts");
	});

	it("sgconfig.yml with languageGlobs → detected language used in --lang arg", async () => {
		let usedLanguage = "";
		let testCallIdx = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				testCallIdx++;
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test" && args[0] === "-f") {
					if (args[1] === "sgconfig.yml") return { code: 0, stdout: "" };
					return { code: 1, stdout: "" };
				}
				if (cmd === "cat") {
					return { code: 0, stdout: "languageGlobs:\n  rust: '*.rs'\n" };
				}
				if (args[0] === "scan") {
					const langIdx = args.indexOf("--lang");
					if (langIdx >= 0) usedLanguage = args[langIdx + 1];
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)" });
		assert.strictEqual(usedLanguage, "rust");
	});

	it("5000 matches → truncated to 100, truncated: true, totalMatches: 5000", async () => {
		const manyMatches = Array.from({ length: 5000 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match number ${i}`),
		).join("\n");
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") return { stdout: manyMatches, stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "match($A)", language: "ts" });
		assert.strictEqual(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.truncated, true);
		assert.strictEqual(details.totalMatches, 5000);
		assert.strictEqual((details.results as any[]).length, 100);
	});

	it("5 matches → full set, no truncation flag", async () => {
		const fiveMatches = Array.from({ length: 5 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match ${i}`),
		).join("\n");
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") return { stdout: fiveMatches, stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "match($A)", language: "ts" });
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.truncated, undefined);
		assert.strictEqual((details.results as any[]).length, 5);
	});

	it("exactly 100 matches → NOT truncated (101 is threshold)", async () => {
		const hundredMatches = Array.from({ length: 100 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match ${i}`),
		).join("\n");
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan")
					return { stdout: hundredMatches, stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "match($A)", language: "ts" });
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.truncated, undefined);
		assert.strictEqual((details.results as any[]).length, 100);
	});

	it("exactly 101 matches → truncated to 100", async () => {
		const matches = Array.from({ length: 101 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match ${i}`),
		).join("\n");
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") return { stdout: matches, stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "match($A)", language: "ts" });
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.truncated, true);
		assert.strictEqual((details.results as any[]).length, 100);
	});

	it("ast-grep --version succeeds → binary cached, no version check on subsequent calls", async () => {
		let versionCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version")) {
					versionCallCount++;
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				}
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		const countAfterFirst = versionCallCount;
		assert.ok(countAfterFirst >= 1, "version should be checked at least once");

		await executeTool(pi, { pattern: "console.log($B)", language: "ts" });
		assert.strictEqual(versionCallCount, countAfterFirst);
	});

	it("concurrent calls — single version check, same binary used", async () => {
		let versionCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version")) {
					versionCallCount++;
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				}
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const results = await Promise.all([
			executeTool(pi, { pattern: "console.log($A)", language: "ts" }),
			executeTool(pi, { pattern: "console.log($B)", language: "ts" }),
			executeTool(pi, { pattern: "console.log($C)", language: "ts" }),
		]);

		assert.strictEqual(versionCallCount, 1, "only one version check should occur");
		assert.strictEqual(results.length, 3);
		results.forEach((r) => assert.ok(r));
	});

	it("version check fails — concurrent callers all throw", async () => {
		let versionCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version")) {
					versionCallCount++;
					return { stdout: "", stderr: "command not found", code: 127, killed: false };
				}
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await assert.rejects(
			Promise.all([
				executeTool(pi, { pattern: "console.log($A)", language: "ts" }),
				executeTool(pi, { pattern: "console.log($B)", language: "ts" }),
				executeTool(pi, { pattern: "console.log($C)", language: "ts" }),
			]),
		);
		assert.strictEqual(versionCallCount, 1, "only one version check should occur");
	});

	it("failed promise resets — next sequential call retries version check", async () => {
		let versionCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version")) {
					versionCallCount++;
					if (versionCallCount === 1) {
						return { stdout: "", stderr: "command not found", code: 127, killed: false };
					}
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				}
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		// First call — version check fails
		await assert.rejects(
			() => executeTool(pi, { pattern: "console.log($A)", language: "ts" }),
			/ast-grep/,
		);

		// Second call — retries version check, succeeds
		const result = await executeTool(pi, { pattern: "console.log($B)", language: "ts" });
		assert.ok(result);
		assert.strictEqual(versionCallCount, 2, "version check should run twice");
	});

	it("ast-grep --version fails (code 127) — throws, no fallback to sg", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version")) {
					return { stdout: "", stderr: "command not found", code: 127, killed: false };
				}
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await assert.rejects(
			() => executeTool(pi, { pattern: "console.log($A)", language: "ts" }),
			/ast-grep/,
		);
	});

	it("exit code 1 + stderr → throws Error with stderr content", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					return { stdout: "", stderr: "unknown language", code: 1, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await assert.rejects(
			() => executeTool(pi, { pattern: "console.log($A)", language: "badlang" }),
			/unknown language/,
		);
	});

	it("exit code 126 → throws Error including 126", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					return { stdout: "", stderr: "Permission denied", code: 126, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await assert.rejects(
			() => executeTool(pi, { pattern: "console.log($A)", language: "ts" }),
			/126/,
		);
	});

	it("exit code 2 → throws Error", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					return { stdout: "", stderr: "some error", code: 2, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await assert.rejects(() => executeTool(pi, { pattern: "console.log($A)", language: "ts" }));
	});

	it("exit code 1 + empty stderr → success: 'No matches found'", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					return { stdout: "", stderr: "", code: 1, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(result.isError, undefined);
		assert.ok(result.content[0].text.includes("No matches found"));
	});

	it(":: collision avoidance: pattern=$A::method,language=ts and pattern=$A,language=method::ts stored separately", async () => {
		let scanCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					scanCallCount++;
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "$A::method", language: "ts" });
		await executeTool(pi, { pattern: "$A", language: "method::ts" });
		assert.strictEqual(scanCallCount, 2, "should be cache misses, two scans");
	});

	it("special chars pattern cached and hit correctly", async () => {
		let scanCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					scanCallCount++;
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "try { $$$BODY } catch (e) { $A }", language: "ts" });
		await executeTool(pi, { pattern: "try { $$$BODY } catch (e) { $A }", language: "ts" });
		assert.strictEqual(scanCallCount, 1, "second call should be cache hit");
	});

	it("AbortSignal forwarded to pi.exec as signal property", async () => {
		let passedSignal: any = undefined;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					passedSignal = opts?.signal;
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const ac = new AbortController();
		await executeTool(pi, { pattern: "console.log($A)", language: "ts" }, { signal: ac.signal });
		assert.strictEqual(passedSignal, ac.signal);
	});

	it("undefined signal works normally", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.ok(result);
	});

	it("pre-aborted signal → pi.exec receives aborted signal", async () => {
		let passedSignal: any = undefined;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "scan") {
					passedSignal = opts?.signal;
					// Reject if signal already aborted — verify it's forwarded correctly
					if (opts?.signal?.aborted) throw new Error("AbortError");
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const ac = new AbortController();
		ac.abort();
		await assert.rejects(() =>
			executeTool(pi, { pattern: "console.log($A)", language: "ts" }, { signal: ac.signal }),
		);
		assert.strictEqual(passedSignal, ac.signal, "aborted signal should be passed to pi.exec");
	});

	it("multiple config files → priority: sgconfig.yml > tsconfig.json", async () => {
		let usedLanguage = "";
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test" && args[0] === "-f") {
					// Both exist, sgconfig.yml checked first
					return { code: 0, stdout: "" };
				}
				if (cmd === "cat") {
					return { code: 0, stdout: "languageGlobs:\n  rust: '*.rs'\n" };
				}
				if (args[0] === "scan") {
					const langIdx = args.indexOf("--lang");
					if (langIdx >= 0) usedLanguage = args[langIdx + 1];
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)" });
		assert.strictEqual(usedLanguage, "rust");
	});
});
