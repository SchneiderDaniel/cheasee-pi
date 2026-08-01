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

	it("has a re-export of DebugLogger from ../lib/debug.ts", () => {
		const source = readFileSync(typesPath, "utf-8");
		const hasReExport =
			source.includes('export type { DebugLogger } from "../lib/debug.ts"') ||
			source.includes('export type { DebugLogger } from "../lib/debug.js"');
		assert.ok(hasReExport, "config/types.ts must re-export DebugLogger type from ../lib/debug.ts");
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
	it("pipeline/audit.ts imports DebugLogger from config/types.ts", () => {
		const auditPath = resolve(__dirname, "..", "pipeline", "audit.ts");
		const auditSource = readFileSync(auditPath, "utf-8");
		const hasImport = auditSource.includes(
			'import type { SupervisorConfig, DebugLogger } from "../config/types.ts"',
		);
		assert.ok(hasImport, "audit.ts must import DebugLogger from config/types.ts");
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

	it("agent/runner.ts imports DebugLogger from config/types.ts", () => {
		const runnerPath = resolve(__dirname, "..", "agent", "runner.ts");
		const runnerSource = readFileSync(runnerPath, "utf-8");
		const hasImport =
			runnerSource.includes("DebugLogger") && runnerSource.includes('../config/types.ts"');
		assert.ok(hasImport, "runner.ts imports DebugLogger through types.ts barrel");
	});
});
