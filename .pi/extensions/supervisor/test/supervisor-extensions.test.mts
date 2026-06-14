/**
 * Tests for resolveExtensions() — per-agent extension resolution logic
 * from .pi/extensions/supervisor.ts
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-extensions.test.mts
 */

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseAgentFile } from "../agent/loader.ts";

// ---------------------------------------------------------------------------
// resolveExtensions — duplicated from supervisor.ts for pure-unit testing
// (supervisor.ts has unresolvable runtime imports in test context)
// ---------------------------------------------------------------------------

function resolveExtensions(extensionsRaw: string | undefined): string[] {
	const base: string[] = [];
	if (!extensionsRaw || !extensionsRaw.trim()) {
		base.push("--extension", ".pi/extensions/context-info.ts");
		return base;
	}

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	if (extensions.length === 0) {
		base.push("--extension", ".pi/extensions/context-info.ts");
		return base;
	}

	for (const ext of extensions) {
		// Try single-file extension first, then directory-based
		const filePath = `.pi/extensions/${ext}.ts`;
		const dirPath = `.pi/extensions/${ext}/index.ts`;
		if (existsSync(dirPath)) {
			base.push("--extension", dirPath);
		} else {
			base.push("--extension", filePath);
		}
	}

	if (!extensions.includes("context-info")) {
		base.push("--extension", ".pi/extensions/context-info.ts");
	}

	return base;
}

// ---------------------------------------------------------------------------
// Tests — AgentFrontmatter type (frontmatter key flows through)
// ---------------------------------------------------------------------------

describe("AgentFrontmatter extensions field", () => {
	it("1.1: parses extensions: 'mcp,browser' + context-info", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("1.2: undefined extensions → context-info auto-injected", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("1.3: empty string extensions → context-info auto-injected", () => {
		const result = resolveExtensions("");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — runAgent() Extension Resolution Logic
// ---------------------------------------------------------------------------

describe("runAgent() extension resolution", () => {
	it("2.1: agent has extensions 'mcp,browser' → --extension per flag + context-info", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("2.2: agent has extensions 'supervisor,mcp' → supervisor filtered out, context-info added", () => {
		const result = resolveExtensions("supervisor,mcp");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("2.3: only supervisor → context-info auto-injected", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.4: no extensions field (undefined) → context-info auto-injected", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.5: empty string → context-info auto-injected", () => {
		const result = resolveExtensions("");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.6: whitespace around names → trimmed + context-info added", () => {
		const result = resolveExtensions("  mcp  ,  browser  ");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("2.7: mixed case — passes original case to CLI, supervisor check is case-insensitive + context-info", () => {
		const result = resolveExtensions("MCP,Browser,Supervisor");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/MCP.ts",
			"--extension",
			".pi/extensions/Browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("2.8: supervisor in middle of list → filtered out, order preserved + context-info", () => {
		const result = resolveExtensions("mcp,supervisor,browser");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});
});

// ---------------------------------------------------------------------------
// Tests — Supervisor Auto-Exclusion (Case-Insensitive)
// ---------------------------------------------------------------------------

describe("supervisor auto-exclusion (case-insensitive)", () => {
	it("3.1: exclude lowercase 'supervisor' + context-info added", () => {
		const result = resolveExtensions("mcp,supervisor,browser");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("3.2: exclude uppercase 'SUPERVISOR' + context-info added", () => {
		const result = resolveExtensions("mcp,SUPERVISOR,browser");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("3.3: exclude mixed-case 'Supervisor' → context-info auto-injected", () => {
		const result = resolveExtensions("Supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("3.4: no supervisor in list → passes through + context-info added", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/browser.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("3.5: only supervisor in list → context-info auto-injected", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — Edge Cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("5.1: only commas → context-info auto-injected", () => {
		const result = resolveExtensions(",,,,");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("5.2: 50+ extensions → handles long lists + context-info", () => {
		const extensions = Array.from({ length: 55 }, (_, i) => `ext-${i}`).join(",");
		const result = resolveExtensions(extensions);
		assert.strictEqual(result[0], "--extension");
		assert.strictEqual(result.length, 112); // 55 pairs + context-info pair
	});

	it("5.3: extension names with hyphens or dots → pass through + context-info", () => {
		const result = resolveExtensions("my-custom-tool,my.tool");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/my-custom-tool.ts",
			"--extension",
			".pi/extensions/my.tool.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});

	it("5.4: whitespace-only string → context-info auto-injected", () => {
		const result = resolveExtensions("   ");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("caveman,scrapling (PS requirement) + context-info", () => {
		const result = resolveExtensions("caveman,scrapling");
		// Both caveman and scrapling are directory-based -> resolve to /index.ts
		assert.ok(result.some((r) => r.includes("caveman/index.ts")));
		assert.ok(result.some((r) => r.includes("scrapling/index.ts")));
		assert.ok(result.some((r) => r.includes("context-info.ts")));
	});

	it("supervisor with caveman → supervisor excluded, context-info added", () => {
		const result = resolveExtensions("supervisor,caveman,scrapling");
		assert.ok(result.some((r) => r.includes("caveman/index.ts")));
		assert.ok(result.some((r) => r.includes("scrapling/index.ts")));
		assert.ok(result.some((r) => r.includes("context-info.ts")));
	});

	it("single extension (not supervisor) + context-info", () => {
		const result = resolveExtensions("mcp");
		assert.deepStrictEqual(result, [
			"--extension",
			".pi/extensions/mcp.ts",
			"--extension",
			".pi/extensions/context-info.ts",
		]);
	});
});

// ---------------------------------------------------------------------------
// Integration test — verify existing agent .md files parse extensions field
// ---------------------------------------------------------------------------

describe("production agent files — extensions field", () => {
	const agents = [
		{
			name: "architect",
			expected: "agent-harness,caveman,piignore,ripgrep-search,scrapling,structural-analyzer",
		},
		{
			name: "test-designer",
			expected: "agent-harness,caveman,piignore,ripgrep-search,scrapling,structural-analyzer",
		},
		{
			name: "developer",
			expected:
				"agent-harness,caveman,format-on-save,piignore,ripgrep-search,scrapling,tsc-checkpoint,structural-analyzer,worktree-sandbox",
		},
		{
			name: "auditor",
			expected:
				"agent-harness,caveman,piignore,ripgrep-search,scrapling,structural-analyzer,worktree-sandbox",
		},
	];

	for (const agent of agents) {
		it(`${agent.name}.md has extensions field matching expected`, () => {
			const { config } = parseAgentFile(`.pi/extensions/supervisor/agents/${agent.name}.md`);
			assert.strictEqual(config.extensions, agent.expected);
		});
	}

	it("supervisor.md does NOT exist (supervisor never loads in subagents)", () => {
		let exists = false;
		try {
			readFileSync(".pi/extensions/supervisor/agents/supervisor.md");
			exists = true;
		} catch {
			/* expected */
		}
		assert.strictEqual(exists, false);
	});
});

describe("production agents resolve without supervisor in output", () => {
	for (const name of ["architect", "test-designer", "developer", "auditor"]) {
		it(`${name} extensions resolve without supervisor, with context-info`, () => {
			const { config } = parseAgentFile(`.pi/extensions/supervisor/agents/${name}.md`);
			const result = resolveExtensions(config.extensions);
			// Must not contain --no-extensions (should have --extension flags)
			assert.notStrictEqual(result[0], "--no-extensions");
			// Must not contain "supervisor" in any path
			assert.ok(!result.some((s) => s.toLowerCase().includes("supervisor")));
			// Must contain context-info
			assert.ok(result.some((s) => s.includes("context-info.ts")));
		});
	}
});

// ---------------------------------------------------------------------------
// Tests — context-info extension auto-injection (Phase 3a)
// ---------------------------------------------------------------------------

describe("context-info extension auto-injection", () => {
	it("P3.1: no extensions → includes context-info path", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("P3.2: other extensions → appends context-info (directory-based paths)", () => {
		const result = resolveExtensions("caveman,scrapling");
		// Both caveman and scrapling are directory-based -> resolve to /index.ts
		assert.ok(result.some((r) => r.includes("caveman/index.ts")));
		assert.ok(result.some((r) => r.includes("scrapling/index.ts")));
		assert.ok(result.some((r) => r.includes("context-info.ts")));
	});

	it("P3.3: context-info already in list → no duplication", () => {
		const result = resolveExtensions("caveman,context-info");
		const contextInfoCount = result.filter(
			(s) => s.includes("context-info") && !s.includes("--extension"),
		).length;
		assert.strictEqual(contextInfoCount, 1);
	});

	it("P3.4: supervisor filtered out, context-info auto-added", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});
});
