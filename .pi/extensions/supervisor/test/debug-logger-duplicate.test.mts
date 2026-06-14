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

	it("pipeline/handler.ts imports DebugLogger from config/types.ts", () => {
		const handlerPath = resolve(__dirname, "..", "pipeline", "handler.ts");
		const handlerSource = readFileSync(handlerPath, "utf-8");
		const hasImport =
			handlerSource.includes("DebugLogger") && handlerSource.includes('../config/types.ts"');
		assert.ok(hasImport, "handler.ts imports DebugLogger through types.ts barrel");
	});

	it("agent/runner.ts imports DebugLogger from config/types.ts", () => {
		const runnerPath = resolve(__dirname, "..", "agent", "runner.ts");
		const runnerSource = readFileSync(runnerPath, "utf-8");
		const hasImport =
			runnerSource.includes("DebugLogger") && runnerSource.includes('../config/types.ts"');
		assert.ok(hasImport, "runner.ts imports DebugLogger through types.ts barrel");
	});
});
