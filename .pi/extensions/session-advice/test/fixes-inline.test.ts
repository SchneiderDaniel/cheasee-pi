/**
 * Tests for FIXES inlining — verifies that FixSuggestion, FIXES, and DEFAULT_FIX
 * are properly defined in advice-pipeline.ts (not imported from fixes.ts).
 *
 * Phase 1: Domain tests for FIXES data integrity
 * Phase 2: Smoke test — generateAdviceReport still works after inlining
 * Phase 3: Integration tests for createSignalIssues template references
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateAdviceReport, createSignalIssues, createGhIssue } from "../advice-pipeline.ts";
import type { SignalReview } from "../llm-advisor.ts";

// ── Phase 1: Domain tests ──

describe("FIXES inlining — domain tests", () => {
	it('FIXES["bash-grep"].effort === "Low"', async () => {
		const mod = await import("../advice-pipeline.ts");
		assert.equal(mod.FIXES["bash-grep"].effort, "Low");
	});

	it('FIXES["redundant-read"].effort === "Low"', async () => {
		const mod = await import("../advice-pipeline.ts");
		assert.equal(mod.FIXES["redundant-read"].effort, "Low");
	});

	it('FIXES["nonexistent-signal"] ?? DEFAULT_FIX returns default fallback', async () => {
		const mod = await import("../advice-pipeline.ts");
		const fallback = mod.FIXES["nonexistent-signal"] ?? mod.DEFAULT_FIX;
		assert.equal(fallback.effort, "Medium");
	});

	it('DEFAULT_FIX.effort === "Medium"', async () => {
		const mod = await import("../advice-pipeline.ts");
		assert.equal(mod.DEFAULT_FIX.effort, "Medium");
	});

	it("FIXES contains all 7 expected keys (structural-search-underuse removed)", async () => {
		const mod = await import("../advice-pipeline.ts");
		// structural-search-underuse removed — wrong premise (code reads ≠ waste).
		// See issue #1084.
		const expectedKeys = [
			"bash-cat",
			"bash-grep",
			"error-loop",
			"identical-args",
			"no-batch",
			"redundant-read",
			"turn-inefficiency",
		];
		const actualKeys = Object.keys(mod.FIXES).sort();
		assert.deepEqual(actualKeys, [...expectedKeys].sort());
		assert.equal(
			actualKeys.length,
			7,
			"FIXES should have 7 keys after structural-search-underuse removal",
		);
	});

	it("DEFAULT_FIX.idea is a non-empty string", async () => {
		const mod = await import("../advice-pipeline.ts");
		assert.ok(mod.DEFAULT_FIX.idea.length > 0);
	});

	it("All FIXES entries have valid effort values", async () => {
		const mod = await import("../advice-pipeline.ts");
		for (const [key, fix] of Object.entries(mod.FIXES)) {
			assert.ok(
				["Low", "Medium", "High"].includes(fix.effort),
				`${key} has invalid effort: ${fix.effort}`,
			);
			assert.ok(fix.idea.length > 0, `${key} has empty idea`);
		}
	});

	it("All FIXES entries have agent-first ideas", async () => {
		const mod = await import("../advice-pipeline.ts");
		for (const [key, fix] of Object.entries(mod.FIXES)) {
			assert.ok(
				fix.idea.startsWith("Agent should"),
				`${key} idea should start with "Agent should", got: ${fix.idea.slice(0, 50)}`,
			);
		}
	});

	it("All FIXES entries mention AGENTS.md (second priority layer)", async () => {
		const mod = await import("../advice-pipeline.ts");
		for (const [key, fix] of Object.entries(mod.FIXES)) {
			assert.ok(
				fix.idea.includes("AGENTS.md"),
				`${key} idea should mention AGENTS.md, got: ${fix.idea.slice(0, 80)}`,
			);
		}
	});

	it("All FIXES entries mention harness-level approach is not recommended", async () => {
		const mod = await import("../advice-pipeline.ts");
		for (const [key, fix] of Object.entries(mod.FIXES)) {
			assert.ok(
				fix.idea.includes("not recommended") || fix.idea.includes("only if"),
				`${key} idea should mention "not recommended" or "only if" for harness-level, got: ${fix.idea.slice(0, 80)}`,
			);
		}
	});

	it("module imports without error (no broken import from fixes.ts)", async () => {
		// This test just verifies the module loads without throwing
		const mod = await import("../advice-pipeline.ts");
		assert.ok(mod !== undefined, "module should load");
	});
});

// ── Phase 2: Smoke test — report generation still works ──

describe("FIXES inlining — report generation", () => {
	const tmpDirs: string[] = [];

	after(() => {
		for (const d of tmpDirs) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
	});

	function makeDir(): string {
		const dir = fs.mkdtempSync("/tmp/session-advice-test-fixes-");
		tmpDirs.push(dir);
		return dir;
	}

	function writeJsonl(
		dir: string,
		filename: string,
		headerId: string,
		bodyLines: string[] = [],
	): void {
		const lines = [JSON.stringify({ type: "session", id: headerId }), ...bodyLines];
		fs.writeFileSync(path.join(dir, filename), lines.join("\n") + "\n", "utf-8");
	}

	function makeSessionBody(): string[] {
		return [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "find something" }],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "bash",
							arguments: { command: "grep foo file.ts" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "line1\nline2" }],
					toolName: "bash",
					isError: false,
				},
			}),
		];
	}

	it("report generates and includes Fix Reference section with effort column", () => {
		const dir = makeDir();
		writeJsonl(dir, "session-a.jsonl", "uuid-tool-mismatch", makeSessionBody());

		const report = generateAdviceReport(dir);

		assert.ok(report.includes("Fix Reference"), "report should contain Fix Reference section");
		assert.ok(report.includes("Effort"), "report should contain Effort column");
		assert.ok(report.includes("Fix idea"), "report should contain Fix idea section in details");
	});

	it("report with no signals still generates (edge case)", () => {
		const dir = makeDir();
		// Session with no tool calls → no signals
		writeJsonl(dir, "clean.jsonl", "uuid-clean", [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hi!" }],
				},
			}),
		]);

		const report = generateAdviceReport(dir);
		assert.ok(report, "report should be generated");
		assert.ok(report.includes("Sessions analyzed"), "report should have session count");
	});

	it("report with 2 sessions produces same output structure as before inlining", () => {
		const dir = makeDir();
		writeJsonl(dir, "session-a.jsonl", "uuid-a", makeSessionBody());
		writeJsonl(dir, "session-b.jsonl", "uuid-b", makeSessionBody());

		const report = generateAdviceReport(dir);

		// Standard structure checks
		assert.ok(report.includes("Sessions analyzed | 2"), "should analyze 2 sessions");
		assert.ok(report.includes("Fix Reference"), "should have Fix Reference table");
		assert.ok(report.includes("Signal Details"), "should have Signal Details section");
	});
});

// ── Phase 3: createSignalIssues references ──

describe("FIXES inlining — createSignalIssues references", () => {
	const tmpDirs: string[] = [];
	const repo = "owner/test-repo";

	after(() => {
		for (const d of tmpDirs) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
	});

	function makeDir(): string {
		const dir = fs.mkdtempSync("/tmp/session-advice-test-fixes-");
		tmpDirs.push(dir);
		return dir;
	}

	/**
	 * Spy execFn that captures the body file content before cleanup.
	 */
	function makeBodyCapturer(): {
		fn: (file: string, args: string[], opts: Record<string, unknown>) => string;
		bodies: string[];
	} {
		const bodies: string[] = [];
		return {
			fn: (_file: string, args: string[], _opts: Record<string, unknown>) => {
				const bodyFileIdx = args.indexOf("--body-file");
				if (bodyFileIdx !== -1) {
					const bodyPath = args[bodyFileIdx + 1];
					try {
						bodies.push(fs.readFileSync(bodyPath, "utf-8"));
					} catch {
						/* may be cleaned up */
					}
				}
				return "https://github.com/owner/repo/issues/1";
			},
			bodies,
		};
	}

	function makeSignalReview(): SignalReview {
		return {
			verdicts: [
				{
					signal: "redundant-read",
					label: "test label",
					verdict: "remove",
					reason: "test",
					falsePositiveRisk: "low",
				},
			],
			newSignals: [
				{
					signal: "new-detector",
					label: "New detector",
					description: "test",
					reason: "test",
					estimatedValue: "medium",
					detectionApproach: "regex",
				},
			],
			summary: "Test review",
		};
	}

	it("remove verdict body references advice-pipeline.ts not fixes.ts", () => {
		const dir = makeDir();
		const capturer = makeBodyCapturer();
		const review = makeSignalReview();

		createSignalIssues(repo, review, 3, dir, capturer.fn);

		const removeBody = capturer.bodies.find((b) => b.includes("Detector Removal Request"));
		assert.ok(removeBody, "should have a removal body");
		// Should reference advice-pipeline.ts, not fixes.ts
		assert.ok(
			removeBody!.includes("advice-pipeline.ts"),
			"should reference advice-pipeline.ts for fix entry location",
		);
		assert.ok(!removeBody!.includes("fixes.ts"), "should NOT reference fixes.ts");
	});

	it("new detector body references advice-pipeline.ts not fixes.ts", () => {
		const dir = makeDir();
		const capturer = makeBodyCapturer();
		const review = makeSignalReview();

		createSignalIssues(repo, review, 3, dir, capturer.fn);

		const addBody = capturer.bodies.find((b) => b.includes("New Detector Proposal"));
		assert.ok(addBody, "should have a new detector body");
		// Should reference advice-pipeline.ts, not fixes.ts
		assert.ok(
			addBody!.includes("advice-pipeline.ts"),
			"should reference advice-pipeline.ts for fix entry location",
		);
		assert.ok(!addBody!.includes("fixes.ts"), "should NOT reference fixes.ts");
	});
});
