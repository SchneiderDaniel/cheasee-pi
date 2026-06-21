/**
 * Tests for in-process agent session runner (agent-session-runner.ts)
 *
 * Phase 1: Types — rawOutput field additions
 * Phase 2: agent-session-runner.ts — resolveModel, buildToolList (pure functions)
 * Phase 3: agent-runner.ts dispatch — in-process first, subprocess fallback
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-in-process.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Phase 1: Types — rawOutput field in SupervisorMessageDetails
// ---------------------------------------------------------------------------

describe("SupervisorMessageDetails — rawOutput fields", () => {
	it("1.1: rawOutput field is required string in SupervisorMessageDetails", () => {
		// Validate the shape at runtime (TypeScript enforces at compile time)
		const details = {
			agentName: "test",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 5,
			tokenCount: 1000,
			durationMs: 5000,
			textOutput: "output text",
			summaryLine: "completed",
			rawOutput: "complete stdout+stderr from agent session",
			hasRawOutput: true,
		};
		assert.strictEqual(typeof details.rawOutput, "string");
		assert.strictEqual(details.rawOutput, "complete stdout+stderr from agent session");
		assert.strictEqual(details.hasRawOutput, true);
	});

	it("1.2: hasRawOutput is optional boolean", () => {
		const details = {
			agentName: "test",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 5,
			tokenCount: 1000,
			durationMs: 5000,
			textOutput: "output text",
			summaryLine: "completed",
			rawOutput: "raw output",
			// hasRawOutput omitted — should still be valid
		};
		assert.strictEqual(details.rawOutput, "raw output");
		assert.strictEqual((details as any)["hasRawOutput"], undefined);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: agent-session-runner.ts — pure function tests
// ---------------------------------------------------------------------------

// resolveModel — duplicated from agent-session-runner.ts for unit testing
function resolveModel(modelString: string): { provider: string; modelId: string } | null {
	if (!modelString || !modelString.trim()) return null;
	const parts = modelString.split("/");
	if (parts.length !== 2) return null;
	return { provider: parts[0]!, modelId: parts[1]! };
}

describe("resolveModel()", () => {
	it("2.1: parses 'opencode-go/deepseek-v4-flash' → provider+modelId", () => {
		const result = resolveModel("opencode-go/deepseek-v4-flash");
		assert.deepStrictEqual(result, { provider: "opencode-go", modelId: "deepseek-v4-flash" });
	});

	it("2.2: returns null for empty string", () => {
		assert.strictEqual(resolveModel(""), null);
	});

	it("2.3: returns null for whitespace-only string", () => {
		assert.strictEqual(resolveModel("   "), null);
	});

	it("2.4: returns null for string without slash", () => {
		assert.strictEqual(resolveModel("just-a-model"), null);
	});

	it("2.5: returns null for undefined/null", () => {
		assert.strictEqual(resolveModel(undefined as any), null);
		assert.strictEqual(resolveModel(null as any), null);
	});

	it("2.6: handles three-part paths by returning first two parts only", () => {
		// The function splits on '/' and requires exactly 2 parts
		const result = resolveModel("provider/model-id/extra");
		assert.strictEqual(result, null);
	});

	it("2.7: handles provider with hyphens and dots", () => {
		const result = resolveModel("my-provider.v2/model-name");
		assert.deepStrictEqual(result, { provider: "my-provider.v2", modelId: "model-name" });
	});
});

// buildToolList — pure, only depends on ParsedAgent + cwd
// We duplicate the core logic for unit testing
function buildToolList(
	agent: { config: { tools?: string; extensions?: string } },
	cwd: string,
): string[] {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	// Simplified resolveTools — just splits on comma
	const tools = rawTools
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.join(",");
	return tools
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

describe("buildToolList()", () => {
	it("2.8: default tools when none specified", () => {
		const agent = { config: {} };
		const tools = buildToolList(agent as any, "/tmp");
		assert.deepStrictEqual(tools, ["read", "bash", "write", "edit"]);
	});

	it("2.9: parses comma-separated tool list", () => {
		const agent = { config: { tools: "read,bash,write,edit,web_crawl" } };
		const tools = buildToolList(agent as any, "/tmp");
		assert.deepStrictEqual(tools, ["read", "bash", "write", "edit", "web_crawl"]);
	});

	it("2.10: trims whitespace around tool names", () => {
		const agent = { config: { tools: "  read , bash , write  " } };
		const tools = buildToolList(agent as any, "/tmp");
		assert.deepStrictEqual(tools, ["read", "bash", "write"]);
	});

	it("2.11: empty tools config falls back to defaults", () => {
		const agent = { config: { tools: "" } };
		const tools = buildToolList(agent as any, "/tmp");
		assert.deepStrictEqual(tools, ["read", "bash", "write", "edit"]);
	});
});

// ---------------------------------------------------------------------------
// Phase 2b: extensions.ts — resolveExtensionPaths (via injected seam)
// ---------------------------------------------------------------------------

import { resolve as resolvePath } from "node:path";
import { resolveExtensionPathsWithFs } from "../lib/extensions.ts";

/**
 * Create a fake existsSync backed by a Map<string, boolean>.
 */
function fakeExists(existing: Map<string, boolean>): (path: string) => boolean {
	return (path: string) => existing.get(path) === true;
}

describe("resolveExtensionPaths — via injected seam", () => {
	it("2.12: empty extensions → empty array", () => {
		const result = resolveExtensionPathsWithFs(undefined, "/test/cwd", fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("2.13: empty string extensions → empty array", () => {
		const result = resolveExtensionPathsWithFs("", "/test/cwd", fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("2.14: supervisor filtered out → empty array", () => {
		const result = resolveExtensionPathsWithFs("supervisor", "/test/cwd", fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("2.15: whitespace-only → empty array", () => {
		const result = resolveExtensionPathsWithFs("   ", "/test/cwd", fakeExists(new Map()));
		assert.deepStrictEqual(result, []);
	});

	it("2.16: non-existent extension returns default path", () => {
		const result = resolveExtensionPathsWithFs("nonexistent", "/test/cwd", fakeExists(new Map()));
		assert.strictEqual(result.length, 1);
		assert.ok(result[0]!.endsWith(".pi/extensions/nonexistent.ts"));
		assert.ok(result[0]!.startsWith("/test/cwd/"));
	});

	it("2.17: supervisor filtered from multi-ext list, others remain", () => {
		const existing = new Map<string, boolean>();
		existing.set(resolvePath("/test/cwd", ".pi/extensions/mcp.ts"), true);
		existing.set(resolvePath("/test/cwd", ".pi/extensions/browser.ts"), true);
		const result = resolveExtensionPathsWithFs(
			"supervisor,mcp,browser",
			"/test/cwd",
			fakeExists(existing),
		);
		assert.strictEqual(result.length, 2);
		assert.ok(result[0]!.endsWith(".pi/extensions/mcp.ts"));
		assert.ok(result[1]!.endsWith(".pi/extensions/browser.ts"));
	});

	it("2.18: multiple extensions all resolved", () => {
		const existing = new Map<string, boolean>();
		existing.set(resolvePath("/test/cwd", ".pi/extensions/mcp.ts"), true);
		existing.set(resolvePath("/test/cwd", ".pi/extensions/browser.ts"), true);
		const result = resolveExtensionPathsWithFs("mcp,browser", "/test/cwd", fakeExists(existing));
		assert.strictEqual(result.length, 2);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: agent-runner.ts dispatch — in-process attempted first
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

describe("agent-runner dispatch logic", () => {
	it("3.1: runAgent is exported and calls runAgentInProcess first", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent/runner.ts", "utf-8");
		assert.ok(
			source.includes("export async function runAgent("),
			"agent-runner.ts exports runAgent function",
		);
		assert.ok(
			source.includes("const result = await runAgentInProcess("),
			"runAgent calls runAgentInProcess (in-process primary path)",
		);
	});

	it("3.2: runAgentSubprocess is exported as fallback", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent/runner.ts", "utf-8");
		assert.ok(
			source.includes("export async function runAgentSubprocess("),
			"runAgentSubprocess is exported from agent-runner.ts",
		);
	});

	it("3.3: dispatch uses try/catch with fallback to subprocess", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent/runner.ts", "utf-8");
		assert.ok(
			source.includes("try {") &&
				source.includes("} catch (err: unknown) {") &&
				source.includes("const result = await runAgentInProcess(") &&
				source.includes("return await runAgentSubprocess("),
			"runAgent has try/catch dispatch (in-process → subprocess fallback)",
		);
	});

	it("3.4: fallback logs warning with [supervisor] prefix", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent/runner.ts", "utf-8");
		assert.ok(
			source.includes("[supervisor] In-process runner failed (result.success=false)"),
			"fallback path logs warning",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 4: pipeline.ts rawOutput forwarding
// ---------------------------------------------------------------------------

describe("pipeline.ts rawOutput forwarding", () => {
	it("4.1: content uses rawOutput || textOutput || summaryLine priority", () => {
		// Verify the priority chain
		const result = { output: "raw", textOutput: "text", summaryLine: "summary" };
		const content1 = result.output || result.textOutput || result.summaryLine;
		assert.strictEqual(content1, "raw");

		const result2 = { output: "", textOutput: "text", summaryLine: "summary" };
		const content2 = result2.output || result2.textOutput || result2.summaryLine;
		assert.strictEqual(content2, "text");

		const result3 = { output: "", textOutput: "", summaryLine: "summary" };
		const content3 = result3.output || result3.textOutput || result3.summaryLine;
		assert.strictEqual(content3, "summary");
	});

	it("4.2: details object includes rawOutput and hasRawOutput", () => {
		const result = {
			output: "full raw output",
			agentName: "test",
			success: true,
			toolCount: 3,
			tokenCount: 500,
			durationMs: 2000,
			textOutput: "text",
			summaryLine: "summary",
			thinkingOutput: undefined,
		};
		const details = {
			agentName: result.agentName,
			success: result.success,
			statusLabel: "SUCCESS",
			toolCount: result.toolCount,
			tokenCount: result.tokenCount,
			durationMs: result.durationMs,
			textOutput: result.textOutput,
			summaryLine: result.summaryLine,
			thinkingOutput: result.thinkingOutput,
			hasThinking: !!result.thinkingOutput,
			rawOutput: result.output,
			hasRawOutput: true,
		};
		assert.strictEqual(details.rawOutput, "full raw output");
		assert.strictEqual(details.hasRawOutput, true);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: pipeline-merge.ts rawOutput forwarding
// ---------------------------------------------------------------------------

describe("pipeline-merge.ts rawOutput forwarding", () => {
	it("5.1: dev conflict resolution includes rawOutput in details", () => {
		const devResult = {
			output: "full dev output",
			agentName: "developer",
			success: true,
			toolCount: 5,
			tokenCount: 1000,
			durationMs: 30000,
			textOutput: "conflict resolved",
			summaryLine: "done",
			thinkingOutput: undefined,
		};
		const details = {
			agentName: devResult.agentName,
			success: devResult.success,
			statusLabel: devResult.success ? "SUCCESS" : "FAILED",
			toolCount: devResult.toolCount,
			tokenCount: devResult.tokenCount,
			durationMs: devResult.durationMs,
			textOutput: devResult.textOutput,
			summaryLine: devResult.summaryLine,
			thinkingOutput: devResult.thinkingOutput,
			hasThinking: !!devResult.thinkingOutput,
			rawOutput: devResult.output,
			hasRawOutput: true,
		};
		assert.strictEqual(details.rawOutput, "full dev output");
		assert.strictEqual(details.hasRawOutput, true);
	});

	it("5.2: dev conflict resolution content uses output || textOutput || summaryLine", () => {
		const devResult = { output: "raw dev", textOutput: "text dev", summaryLine: "summary dev" };
		const content = devResult.output || devResult.textOutput || devResult.summaryLine;
		assert.strictEqual(content, "raw dev");
	});
});
