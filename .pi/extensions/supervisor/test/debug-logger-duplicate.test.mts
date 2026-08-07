// ─── Tests: DebugLogger duplicate interface removal (GH #540) ──────
// Verifies that DebugLogger interface is not redefined in config/types.ts
// and that the re-export from lib/debug.ts works correctly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..", "..", "..", "..");
const typesPath = resolve(__dirname, "..", "config/types.ts");

// ─── Source-level assertion — types.ts does NOT redefine DebugLogger ──

describe("DebugLogger — config/types.ts", () => {
	it("does NOT redefine DebugLogger interface (no export interface DebugLogger {)", () => {
		const source = readFileSync(typesPath, "utf-8");
		assert.ok(
			!source.includes("export interface DebugLogger {"),
			"config/types.ts must not redefine DebugLogger interface — use re-export from debug.ts",
		);
	});

	it("no longer re-exports DebugLogger from types.ts (dead re-export removed — GH #1473)", () => {
		const source = readFileSync(typesPath, "utf-8");
		assert.ok(
			!source.includes("export type { DebugLogger }"),
			"config/types.ts must not re-export DebugLogger — the canonical type lives in lib/debug.ts and consumers import it from there directly",
		);
		// Canonical definition stays in lib/debug.ts (unchanged by the removal)
		const debugSource = readFileSync(resolve(__dirname, "..", "lib", "debug.ts"), "utf-8");
		assert.ok(
			debugSource.includes("export interface DebugLogger {"),
			"lib/debug.ts owns the canonical DebugLogger definition",
		);
	});
});

// ─── TSC compilation check — re-export resolves correctly ──────────

describe("DebugLogger — tsc compilation", () => {
	it("project compiles with tsc --noEmit (re-export type resolution)", () => {
		// Run tsc against the supervisor extension's tsconfig
		const result = execSync("npx tsc --noEmit --project .pi/tsconfig.json 2>&1", {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 30_000,
		});
		// tsc returns empty stdout on success (warnings go to stderr)
		// We just verify it doesn't throw
		assert.ok(true, "tsc --noEmit passed — all type references including DebugLogger resolve");
	});
});

// ─── Consumer source verification ──────────────────────────────────

describe("DebugLogger — consumer imports", () => {
	it("pipeline/audit/index.ts imports SupervisorConfig from config/types.ts", () => {
		const auditPath = resolve(__dirname, "..", "pipeline", "audit", "index.ts");
		const auditSource = readFileSync(auditPath, "utf-8");
		// Issue #1407 split: index.ts consumes SupervisorConfig directly; the
		// DebugLogger type is only consumed via getDebugLogger() (lib/debug.ts),
		// so the trimmed import line is the one that must stay canonical.
		const hasImport = auditSource.includes(
			'import type { SupervisorConfig } from "../../config/types.ts"',
		);
		assert.ok(hasImport, "audit/index.ts must import SupervisorConfig from config/types.ts");
	});

	it("pipeline/handler package does not redefine DebugLogger (issue #1395 split)", () => {
		// Issue #1395 split: the handler megahandler moved to the
		// handler/{index,preflight,agent-loop,post-pipeline,shared}.ts package.
		// None of the split files may redefine the DebugLogger interface —
		// they consume the canonical getDebugLogger from lib/debug.ts.
		const packageFiles = [
			"index.ts",
			"preflight.ts",
			"agent-loop.ts",
			"post-pipeline.ts",
			"shared.ts",
		];
		for (const file of packageFiles) {
			const src = readFileSync(resolve(__dirname, "..", "pipeline", "handler", file), "utf-8");
			assert.ok(
				!src.includes("interface DebugLogger"),
				`handler/${file} must not redefine the DebugLogger interface`,
			);
		}
		const loopSrc = readFileSync(
			resolve(__dirname, "..", "pipeline", "handler", "agent-loop.ts"),
			"utf-8",
		);
		assert.ok(
			loopSrc.includes('from "../../lib/debug.ts"'),
			"handler package imports getDebugLogger from lib/debug.ts",
		);
	});

	it("agent/runner package consumes DebugLogger via lib/debug.ts, not the types.ts barrel", () => {
		const runnerPath = resolve(__dirname, "..", "agent", "runner.ts");
		const runnerSource = readFileSync(runnerPath, "utf-8");
		// The runner.ts barrel re-exports the runner/ package; the orchestrator
		// (runner/index.ts) imports the canonical getDebugLogger from lib/debug.ts
		// and its types from config/types.ts (AgentRunResult etc.) — never a
		// DebugLogger re-export from types.ts (removed as dead code in #1473).
		const indexSource = readFileSync(
			resolve(__dirname, "..", "agent", "runner", "index.ts"),
			"utf-8",
		);
		assert.ok(runnerSource.includes("export * from \"./runner/index.ts\""), "runner.ts is a barrel");
		assert.ok(
			indexSource.includes('from "../../lib/debug.ts"'),
			"runner package imports getDebugLogger from lib/debug.ts",
		);
		assert.ok(
			!indexSource.includes("DebugLogger") || indexSource.includes('from "../../lib/debug.ts"'),
			"DebugLogger usage resolves through lib/debug.ts, never the types.ts re-export",
		);
	});
});
