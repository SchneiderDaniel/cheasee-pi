/**
 * Tests for agent-session-runner.ts — type errors + cleanup path verification.
 *
 * Phase 2: resolveModelString boundary conditions (duplicated, same pattern as existing tests)
 * Phase 3-4: Source structure verification (readFileSync, no module imports)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-session-runner.test.mts
 *   tsc --noEmit -p .pi/tsconfig.json
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// ─── Source code structure tests ───────────────────────────────────
// These verify the source file has the expected fix patterns.
// Use readFileSync — no module imports needed.

describe("agent-session-runner.ts — fix verification", () => {
	const source = readFileSync(".pi/extensions/supervisor/agent/session-runner.ts", "utf-8");

	// ── Type check (Phase A) ──

	it("A.1: no first.model fallback in resolveModel", () => {
		// Find lines containing first.id in resolveModel
		const lines = source.split("\n");
		const firstIdLines = lines.filter((l) => l.includes("first.id") && !l.trim().startsWith("//"));
		const hasModelFallback = firstIdLines.some((l) => l.includes("first.model"));
		assert.ok(
			!hasModelFallback,
			`Line with "first.id" must NOT contain "first.model". Found: [${firstIdLines.join(" | ")}]`,
		);
	});

	it("A.2: getModel call uses type assertion for provider arg", () => {
		const lines = source.split("\n");
		const getModelIndices = lines
			.map((l, i) => (l.includes("getModel(") && !l.trim().startsWith("//") ? i : -1))
			.filter((i) => i >= 0);
		// Check the getModel line AND the next few lines for type assertion
		const hasTypeAssertion = getModelIndices.some((idx) => {
			// Look at up to 5 lines starting from the getModel call
			for (let i = idx; i < Math.min(idx + 5, lines.length); i++) {
				if (
					lines[i]!.includes("as any") ||
					lines[i]!.includes("as KnownProvider") ||
					lines[i]!.includes("as Parameters<typeof getModel>")
				) {
					return true;
				}
			}
			return false;
		});
		assert.ok(hasTypeAssertion, "getModel call must use type assertion for provider arg");
	});

	it("A.3: no signal property in prompt options arg", () => {
		// Before fix: has `signal: abortController.signal,` — after fix: line removed
		const lines = source.split("\n");
		const signalLines = lines.filter((l) => l.includes("signal:") && l.includes("abortController"));
		assert.strictEqual(
			signalLines.length,
			0,
			`No signal: abortController in prompt options. Found: [${signalLines.join(" | ")}]`,
		);
	});

	it("A.4: no AbortController variable declaration", () => {
		const lines = source.split("\n");
		const abortDecl = lines.filter(
			(l) =>
				(l.includes("let ") || l.includes("const ") || l.includes("var ")) &&
				l.includes("abortController"),
		);
		assert.strictEqual(
			abortDecl.length,
			0,
			`No abortController variable declaration. Found: [${abortDecl.join(" | ")}]`,
		);
	});

	it("A.5: no AbortController import statement", () => {
		const lines = source.split("\n");
		const abortImport = lines.filter(
			(l) => l.includes("AbortController") && l.trim().startsWith("import"),
		);
		assert.strictEqual(
			abortImport.length,
			0,
			`No AbortController import. Found: [${abortImport.join(" | ")}]`,
		);
	});

	// ── Variable hoisting (Phase 4) ──

	it("4.1: flushTimer hoisted before outer try block", () => {
		// Find the section after `const startedAt = Date.now();` and before `try {`
		const afterStartedAt = source.split("const startedAt = Date.now();")[1] || "";
		const beforeOuterTry = afterStartedAt.split("try {")[0] || "";
		assert.ok(
			beforeOuterTry.includes("let flushTimer"),
			"flushTimer must be declared with let BEFORE the outer try block. " +
				`Section found: [${beforeOuterTry.slice(0, 200)}]`,
		);
	});

	it("4.2: heartbeat declared with let before outer try block", () => {
		const afterStartedAt = source.split("const startedAt = Date.now();")[1] || "";
		const beforeOuterTry = afterStartedAt.split("try {")[0] || "";
		assert.ok(
			beforeOuterTry.includes("let heartbeat"),
			"heartbeat must be declared with let BEFORE the outer try block. " +
				`Section found: [${beforeOuterTry.slice(0, 200)}]`,
		);
	});

	it("4.3: no 'const heartbeat' declaration in file (hoisted to function scope)", () => {
		// After fix: heartbeat is declared with let at function scope, assigned inside try
		// Before fix: declared with const inside try
		const lines = source.split("\n");
		const constHeartbeat = lines.filter(
			(l) => l.includes("const heartbeat") && !l.trim().startsWith("//"),
		);
		assert.strictEqual(
			constHeartbeat.length,
			0,
			`No "const heartbeat" declaration. Found: [${constHeartbeat.join(" | ")}]`,
		);
	});

	it("4.4: timeout calls session!.abort()", () => {
		const lines = source.split("\n");
		const abortLines = lines.filter((l) => l.includes(".abort()") && !l.trim().startsWith("//"));
		const hasSessionAbort = abortLines.some((l) => l.includes("session!.abort()"));
		const hasAbortControllerAbort = abortLines.some((l) => l.includes("abortController"));
		assert.ok(
			hasSessionAbort,
			`Timeout must call session!.abort(). Abort lines: [${abortLines.join(" | ")}]`,
		);
		assert.ok(
			!hasAbortControllerAbort,
			`Must NOT call abortController.abort(). Abort lines: [${abortLines.join(" | ")}]`,
		);
	});
});
