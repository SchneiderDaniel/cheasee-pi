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
	it("registers no standalone session_shutdown handler", () => {
		const pi = makePi();
		structuralAnalyzer(pi);
		const shutdownHandlers = pi.__getOnCalls().filter((c: any) => c.event === "session_shutdown");
		assert.strictEqual(shutdownHandlers.length, 0);
	});
	it("registers exactly one tool_result and one session_start handler", () => {
		const pi = makePi();
		structuralAnalyzer(pi);
		const onCalls = pi.__getOnCalls();
		assert.strictEqual(onCalls.filter((c: any) => c.event === "tool_result").length, 1);
		assert.strictEqual(onCalls.filter((c: any) => c.event === "session_start").length, 1);
	});
	it("session_start clears the cache (identical search re-executes)", async () => {
		const { pi, scans } = scanPi();
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scans(), 1);

		await dispatchSessionStart(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scans(), 2, "session_start must invalidate the cache");
	});
	for (const toolName of ["edit", "write"]) {
		it(`${toolName} success → identical search re-executes (scan count 2)`, async () => {
			const { pi, scans } = scanPi();
			structuralAnalyzer(pi);

			await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
			assert.strictEqual(scans(), 1);

			await dispatchToolResult(pi, { toolName, isError: false });

			await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
			assert.strictEqual(scans(), 2, `${toolName} must invalidate the cache`);
		});
	}
	it("after edit, identical search returns the fresh payload (not pre-edit)", async () => {
		let scans = 0;
		let payload = TWO_MATCHES;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
					scans++;
					return { stdout: payload, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const before = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual((before.structuredContent as any).matches, 2);

		// the edit removes one match
		payload = createMatchJson("src/app.ts", "10-10", "console.log('App started')");
		await dispatchToolResult(pi, { toolName: "edit", isError: false });

		const after = await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scans, 2);
		assert.strictEqual((after.structuredContent as any).matches, 1, "must reflect post-edit code");
	});
	it("failed mutation does NOT invalidate (cache hit preserved)", async () => {
		const { pi, scans } = scanPi();
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		await dispatchToolResult(pi, { toolName: "edit", isError: true });
		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scans(), 1, "failed edit must not invalidate");
	});
	it("non-mutating tool result does NOT invalidate (cache hit preserved)", async () => {
		const { pi, scans } = scanPi();
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		await dispatchToolResult(pi, { toolName: "read", isError: false });
		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scans(), 1, "read must not invalidate");
	});
	it("invalidation is coarse: a different pattern also re-execs after write", async () => {
		const { pi, scans } = scanPi();
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		await executeTool(pi, { pattern: "console.log($B)", language: "ts" });
		assert.strictEqual(scans(), 2);

		await dispatchToolResult(pi, { toolName: "write", isError: false });

		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		await executeTool(pi, { pattern: "console.log($B)", language: "ts" });
		assert.strictEqual(scans(), 4, "every cached pattern is invalidated by a write");
	});
	it("epoch captured at the request boundary: in-flight write-back after mutation is unreachable", async () => {
		let pi: any;
		const { pi: mockPi, scans } = scanPi(async () => {
			// mutation lands while this search is still in flight
			await dispatchToolResult(pi, { toolName: "edit", isError: false });
		});
		pi = mockPi;
		structuralAnalyzer(pi);

		// first search writes back under its pre-mutation epoch → unreachable
		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scans(), 1);

		// second identical search must re-exec (stale payload was not served)
		await executeTool(pi, { pattern: "console.log($A)", language: "ts" });
		assert.strictEqual(scans(), 2, "pre-mutation write-back must be unreachable");
	});
	it("ast-grep error responses stay uncached across an epoch change", async () => {
		let scans = 0;
		const pi = makePi({
			execOverride: async (cmd: string, args: string[]) => {
				if (args.includes("--version"))
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				if (args[0] === "run") {
					scans++;
					return { stdout: "", stderr: "unknown language", code: 1, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		const first = await executeTool(pi, { pattern: "console.log($A)", language: "badlang" });
		assert.strictEqual(first.isError, true);
		await dispatchToolResult(pi, { toolName: "edit", isError: false });
		const second = await executeTool(pi, { pattern: "console.log($A)", language: "badlang" });
		assert.strictEqual(second.isError, true);
		assert.strictEqual(scans, 2, "error responses must never be cached");
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
				if (args[0] === "run") {
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
				if (args[0] === "run") {
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
				if (args[0] === "run") {
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
				if (args[0] === "run") {
					scanCallCount++;
					return { stdout: "", stderr: "unknown language", code: 1, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		});
		structuralAnalyzer(pi);

		// First call — resolves with an isError result (no throw)
		const first = await executeTool(pi, { pattern: "console.log($A)", language: "badlang" });
		assert.strictEqual(first.isError, true);

		// Second call — should re-execute (not cached)
		const second = await executeTool(pi, { pattern: "console.log($A)", language: "badlang" });
		assert.strictEqual(second.isError, true);
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
				if (args[0] === "run") {
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
				if (args[0] === "run") {
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
		assert.strictEqual(usedLanguage, "ts");
	});
});
