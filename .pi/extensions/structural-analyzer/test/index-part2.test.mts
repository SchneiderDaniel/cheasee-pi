import assert from "node:assert";

import { describe, it, beforeEach } from "node:test";

import structuralAnalyzer from "../index.ts";

import { clearResultCache } from "../cache.ts";

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

async function executeTool(
	pi: any,
	params: { pattern: string; language?: string; directory?: string },
	options?: { signal?: AbortSignal; cwd?: string; onUpdate?: any },
): Promise<any> {
	const tool = pi.__getRegisteredTool();
	if (!tool) throw new Error("No tool registered");
	return tool.execute("test-call-id", params, options?.signal, options?.onUpdate, {
		cwd: options?.cwd ?? "/tmp",
	});
}

async function dispatchToolResult(pi: any, event: Record<string, unknown>): Promise<void> {
	const handler = pi.__getOnCalls().find((c: any) => c.event === "tool_result")?.handler;
	if (!handler) throw new Error("no tool_result handler registered");
	await handler(event, { cwd: "/tmp" });
}

async function dispatchSessionStart(pi: any): Promise<void> {
	const handler = pi.__getOnCalls().find((c: any) => c.event === "session_start")?.handler;
	if (!handler) throw new Error("no session_start handler registered");
	await handler();
}

function scanPi(onScan?: () => Promise<void> | void): { pi: any; scans: () => number } {
	let scans = 0;
	const pi = makePi({
		execOverride: async (cmd: string, args: string[]) => {
			if (args.includes("--version"))
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			if (args[0] === "run") {
				scans++;
				if (onScan) await onScan();
				return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 1, killed: false };
		},
	});
	return { pi, scans: () => scans };
}

describe("structuralAnalyzer extension wiring", () => {
	beforeEach(() => {
		clearResultCache();
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
				if (args[0] === "run") {
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
				if (args[0] === "run") return { stdout: manyMatches, stderr: "", code: 0, killed: false };
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
				if (args[0] === "run") return { stdout: fiveMatches, stderr: "", code: 0, killed: false };
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
				if (args[0] === "run")
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
				if (args[0] === "run") return { stdout: matches, stderr: "", code: 0, killed: false };
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
				// Unknown commands fail so npm config get prefix doesn't trigger unintended probes
				return { stdout: "", stderr: "", code: 127, killed: false };
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
		assert.strictEqual(versionCallCount, 3, "3 --version probes in one resolution chain");
	});
	it("failed promise resets — next sequential call retries version check", async () => {
		let versionCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version")) {
					versionCallCount++;
					// First resolution attempt: all 3 --version probes fail (code 127)
					// Second resolution attempt: first probe succeeds (code 0)
					if (versionCallCount <= 3) {
						return { stdout: "", stderr: "command not found", code: 127, killed: false };
					}
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				}
				if (cmd === "npm") return { stdout: "", stderr: "", code: 127, killed: false };
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
		assert.strictEqual(versionCallCount, 4, "version check should run twice (3 + 1 probes)");
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
	it("exit code 1 + stderr → resolves isError with typed stderr", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
					return { stdout: "", stderr: "unknown language", code: 1, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "console.log($A)", language: "badlang" });
		assert.strictEqual(result.isError, true);
		const sc = result.structuredContent as Record<string, unknown>;
		assert.strictEqual(sc.stderr, "unknown language");
		assert.strictEqual(sc.exitCode, 1);
		assert.strictEqual(sc.language, "badlang");
		assert.strictEqual(sc.pattern, "console.log($A)");
		assert.strictEqual(sc.matches, 0);
		assert.deepStrictEqual(sc.results, []);
		assert.strictEqual((result.details as Record<string, unknown>).success, false);
	});
	it("exit code 126 → resolves isError with exitCode 126", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
					return { stdout: "", stderr: "Permission denied", code: 126, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(result.isError, true);
		assert.strictEqual((result.structuredContent as { exitCode?: number }).exitCode, 126);
	});
	it("exit code 2 → resolves isError", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
					return { stdout: "", stderr: "some error", code: 2, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(result.isError, true);
	});
	it("exit code 1 + empty stderr → success: 'No matches found'", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
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
				if (args[0] === "run") {
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
				if (args[0] === "run") {
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
});
