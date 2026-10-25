import assert from "node:assert";

import { describe, it, beforeEach } from "node:test";

import { resolve } from "node:path";

import { Value } from "typebox/value";

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
	it("AbortSignal forwarded to pi.exec as signal property", async () => {
		let passedSignal: any = undefined;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[], opts?: any) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
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
				if (args[0] === "run") {
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
	it("equivalent directory spellings share one resolved cache key (one scan)", async () => {
		let scanCallCount = 0;
		const capturedArgs: string[][] = [];
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
					scanCallCount++;
					capturedArgs.push(args);
					return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		for (const spelling of ["sub", "./sub", "sub/"]) {
			await executeTool(
				pi,
				{ pattern: "console.log($A)", language: "ts", directory: spelling },
				{ cwd: "/tmp" },
			);
		}

		assert.strictEqual(scanCallCount, 1, "equivalent spellings must resolve to one cache key");
		assert.ok(
			capturedArgs[0].includes(resolve("/tmp", "sub")),
			"resolved dir should be passed to ast-grep",
		);
	});
	it("in-root nonexistent directory keeps ast-grep error semantics (no traversal wording)", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (args[0] === "run")
					return { stdout: "", stderr: "error: unable to access path", code: 1, killed: false };
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(
			pi,
			{ pattern: "console.log($A)", language: "ts", directory: "nonexistent_subdir" },
			{ cwd: "/tmp" },
		);
		assert.strictEqual(result.isError, true);
		const text = result.content[0].text as string;
		assert.doesNotMatch(text, /Directory traversal detected/);
		assert.doesNotMatch(text, /not found in project root/);
		assert.match(text, /unable to access path/);
	});
});
describe("structural_search structured contract", () => {
	beforeEach(() => {
		clearResultCache();
	});

	it("annotations declare readOnlyHint and idempotentHint (openWorldHint false)", () => {
		const pi = makePi();
		structuralAnalyzer(pi);
		const tool = pi.__getRegisteredTool();
		assert.deepStrictEqual(tool.annotations, {
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
		assert.strictEqual(tool.annotations.readOnlyHint, true);
		assert.strictEqual(tool.annotations.idempotentHint, true);
	});

	it("outputSchema describes both emitted shapes", () => {
		const pi = makePi();
		structuralAnalyzer(pi);
		const tool = pi.__getRegisteredTool();
		assert.ok(tool.outputSchema, "outputSchema should be declared");
		assert.ok(
			Value.Check(tool.outputSchema, {
				matches: 2,
				results: [{ file: "a.ts", lines: "1", snippet: "x" }],
				language: "ts",
			}),
		);
		assert.ok(
			Value.Check(tool.outputSchema, {
				matches: 0,
				results: [],
				language: "badlang",
				error: "unknown language",
				stderr: "unknown language",
				exitCode: 1,
				pattern: "console.log($A)",
			}),
		);
	});

	it("happy path returns structuredContent matching outputSchema", async () => {
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "run") return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		const tool = pi.__getRegisteredTool();
		assert.ok(Value.Check(tool.outputSchema, result.structuredContent));
		assert.deepStrictEqual(result.structuredContent, {
			matches: 2,
			results: (result.details as { results: unknown[] }).results,
			language: "ts",
		});
	});

	it("cache hit returns the identical structuredContent envelope", async () => {
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

		const first = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		const second = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scanCallCount, 1, "second call should be a cache hit");
		assert.deepStrictEqual(second.structuredContent, first.structuredContent);
		assert.deepStrictEqual(second.details, first.details);
	});

	it("truncated result preserves truncation signal on cache hit", async () => {
		const manyMatches = Array.from({ length: 150 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match number ${i}`),
		).join("\n");
		let scanCallCount = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (cmd === "test") return { code: 1, stdout: "" };
				if (cmd === "cat") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
					scanCallCount++;
					return { stdout: manyMatches, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const first = await executeTool(pi, { pattern: "match($A)", language: "ts" });
		const second = await executeTool(pi, { pattern: "match($A)", language: "ts" });
		assert.strictEqual(scanCallCount, 1);
		const sc = second.structuredContent as {
			truncated?: boolean;
			totalMatches?: number;
			results: unknown[];
		};
		assert.strictEqual(sc.truncated, true);
		assert.strictEqual(sc.totalMatches, 150);
		assert.strictEqual(sc.results.length, 100);
		assert.deepStrictEqual(second.structuredContent, first.structuredContent);
	});
});
