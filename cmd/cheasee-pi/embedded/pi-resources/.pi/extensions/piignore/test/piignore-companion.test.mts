/**
 * Tests for piignore-trust-check global companion extension.
 *
 * Verifies the companion registers a project_trust handler that scans
 * .piignore for restrictive patterns and warns the user, always returning
 * { trusted: "undecided" }.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore-companion.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

// Import from implementation for TDD gate verification
import {
	default as createCompanion,
	isUnanchoredDirPattern,
	isBroadFileGlob,
	isNameHeuristicPattern,
	detectOverbroadPatterns,
	buildWarningMessage,
} from "../global-companion.ts";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

interface ProjectTrustEvent {
	projectPath: string;
}

interface ProjectTrustContext {
	cwd?: string;
	hasUI: boolean;
	mode?: string;
	ui: {
		notify: (message: string, type: string) => void;
	};
}

interface ProjectTrustResult {
	trusted: "yes" | "no" | "undecided";
}

interface MockExtensionAPI {
	on(event: string, handler: Function): void;
	getProjectTrustHandler():
		| ((event: ProjectTrustEvent, ctx: ProjectTrustContext) => ProjectTrustResult)
		| undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// Helper: create mock API
// ═══════════════════════════════════════════════════════════════════════

function createMockAPI(): MockExtensionAPI {
	let projectTrustHandler:
		| ((event: ProjectTrustEvent, ctx: ProjectTrustContext) => ProjectTrustResult)
		| undefined;

	return {
		on(event: string, handler: Function) {
			if (event === "project_trust") {
				projectTrustHandler = handler as (
					event: ProjectTrustEvent,
					ctx: ProjectTrustContext,
				) => ProjectTrustResult;
			}
		},
		getProjectTrustHandler() {
			return projectTrustHandler;
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Detection function units
// ═══════════════════════════════════════════════════════════════════════

describe("isUnanchoredDirPattern", () => {
	it("returns true for unanchored generic dir (build/)", () => {
		assert.strictEqual(isUnanchoredDirPattern("build/"), true);
	});

	it("returns true for unanchored generic dir (dist/)", () => {
		assert.strictEqual(isUnanchoredDirPattern("dist/"), true);
	});

	it("returns true for unanchored generic dir (tmp/)", () => {
		assert.strictEqual(isUnanchoredDirPattern("tmp/"), true);
	});

	it("returns true for unanchored generic dir (cache/)", () => {
		assert.strictEqual(isUnanchoredDirPattern("cache/"), true);
	});

	it("returns true for unanchored generic dir (logs/)", () => {
		assert.strictEqual(isUnanchoredDirPattern("logs/"), true);
	});

	it("returns true for unanchored generic dir (old/)", () => {
		assert.strictEqual(isUnanchoredDirPattern("old/"), true);
	});

	it("returns true for unanchored generic dir (node_modules/)", () => {
		assert.strictEqual(isUnanchoredDirPattern("node_modules/"), true);
	});

	it("returns false for secrets/ (safe-default, not generic)", () => {
		assert.strictEqual(isUnanchoredDirPattern("secrets/"), false);
	});

	it("returns false for docs/ (not generic)", () => {
		assert.strictEqual(isUnanchoredDirPattern("docs/"), false);
	});

	it("returns false for src/ (not generic)", () => {
		assert.strictEqual(isUnanchoredDirPattern("src/"), false);
	});

	it("returns false for /build/ (leading / anchors to root)", () => {
		assert.strictEqual(isUnanchoredDirPattern("/build/"), false);
	});

	it("returns false for src/build/ (internal / anchors scope)", () => {
		assert.strictEqual(isUnanchoredDirPattern("src/build/"), false);
	});

	it("returns false for build (no trailing /)", () => {
		assert.strictEqual(isUnanchoredDirPattern("build"), false);
	});

	it("returns false for build.log (not a dir pattern)", () => {
		assert.strictEqual(isUnanchoredDirPattern("build.log"), false);
	});

	it("returns false for .env (literal, no trailing /)", () => {
		assert.strictEqual(isUnanchoredDirPattern(".env"), false);
	});

	it("returns false for empty string", () => {
		assert.strictEqual(isUnanchoredDirPattern(""), false);
	});

	it("returns true for whitespace-padded build/ (trimmed)", () => {
		assert.strictEqual(isUnanchoredDirPattern("  build/  "), true);
	});
});

describe("isBroadFileGlob", () => {
	it("returns true for *.log", () => {
		assert.strictEqual(isBroadFileGlob("*.log"), true);
	});

	it("returns true for *.db", () => {
		assert.strictEqual(isBroadFileGlob("*.db"), true);
	});

	it("returns true for *.sqlite", () => {
		assert.strictEqual(isBroadFileGlob("*.sqlite"), true);
	});

	it("returns true for *.tar", () => {
		assert.strictEqual(isBroadFileGlob("*.tar"), true);
	});

	it("returns true for *.zip", () => {
		assert.strictEqual(isBroadFileGlob("*.zip"), true);
	});

	it("returns true for *.gz", () => {
		assert.strictEqual(isBroadFileGlob("*.gz"), true);
	});

	it("returns true for *.bak", () => {
		assert.strictEqual(isBroadFileGlob("*.bak"), true);
	});

	it("returns true for *.tmp", () => {
		assert.strictEqual(isBroadFileGlob("*.tmp"), true);
	});

	it("returns true for *.cache", () => {
		assert.strictEqual(isBroadFileGlob("*.cache"), true);
	});

	it("returns true for *.pid", () => {
		assert.strictEqual(isBroadFileGlob("*.pid"), true);
	});

	it("returns true for *.lock", () => {
		assert.strictEqual(isBroadFileGlob("*.lock"), true);
	});

	it("returns true for **/*.log (double-star variant)", () => {
		assert.strictEqual(isBroadFileGlob("**/*.log"), true);
	});

	it("returns false for *.env (safe-default, not in curated set)", () => {
		assert.strictEqual(isBroadFileGlob("*.env"), false);
	});

	it("returns false for .env (literal, no wildcard)", () => {
		assert.strictEqual(isBroadFileGlob(".env"), false);
	});

	it("returns false for .env.* (no leading * glob)", () => {
		assert.strictEqual(isBroadFileGlob(".env.*"), false);
	});

	it("returns false for **/*.pem (safe-default, not in curated set)", () => {
		assert.strictEqual(isBroadFileGlob("**/*.pem"), false);
	});

	it("returns false for **/*.key (safe-default, not in curated set)", () => {
		assert.strictEqual(isBroadFileGlob("**/*.key"), false);
	});

	it("returns false for *.md (not in curated set)", () => {
		assert.strictEqual(isBroadFileGlob("*.md"), false);
	});

	it("returns false for *.js (not in curated set)", () => {
		assert.strictEqual(isBroadFileGlob("*.js"), false);
	});

	it("returns false for secrets/ (not a file glob)", () => {
		assert.strictEqual(isBroadFileGlob("secrets/"), false);
	});

	it("returns false for build/ (not a file glob)", () => {
		assert.strictEqual(isBroadFileGlob("build/"), false);
	});

	it("returns false for * (not an ext pattern)", () => {
		assert.strictEqual(isBroadFileGlob("*"), false);
	});

	it("returns false for ** (not an ext pattern)", () => {
		assert.strictEqual(isBroadFileGlob("**"), false);
	});

	it("returns false for empty string", () => {
		assert.strictEqual(isBroadFileGlob(""), false);
	});
});

describe("isNameHeuristicPattern", () => {
	it("returns true for **/*secret*", () => {
		assert.strictEqual(isNameHeuristicPattern("**/*secret*"), true);
	});

	it("returns true for **/*token*", () => {
		assert.strictEqual(isNameHeuristicPattern("**/*token*"), true);
	});

	it("returns true for **/*password*", () => {
		assert.strictEqual(isNameHeuristicPattern("**/*password*"), true);
	});

	it("returns true for **/*credential*", () => {
		assert.strictEqual(isNameHeuristicPattern("**/*credential*"), true);
	});

	it("returns true for **/*cert*", () => {
		assert.strictEqual(isNameHeuristicPattern("**/*cert*"), true);
	});

	it("returns true for **/*private*", () => {
		assert.strictEqual(isNameHeuristicPattern("**/*private*"), true);
	});

	it("returns true for *secret*", () => {
		assert.strictEqual(isNameHeuristicPattern("*secret*"), true);
	});

	it("returns true for secret*", () => {
		assert.strictEqual(isNameHeuristicPattern("secret*"), true);
	});

	it("returns true for *secret", () => {
		assert.strictEqual(isNameHeuristicPattern("*secret"), true);
	});

	it("returns false for secrets/ (literal dir, no star adjacency)", () => {
		assert.strictEqual(isNameHeuristicPattern("secrets/"), false);
	});

	it("returns false for secret.txt (literal file, no star)", () => {
		assert.strictEqual(isNameHeuristicPattern("secret.txt"), false);
	});

	it("returns false for **/*.pem (no keyword match)", () => {
		assert.strictEqual(isNameHeuristicPattern("**/*.pem"), false);
	});

	it("returns false for *.env (no keyword match)", () => {
		assert.strictEqual(isNameHeuristicPattern("*.env"), false);
	});

	it("returns false for build/ (no keyword match)", () => {
		assert.strictEqual(isNameHeuristicPattern("build/"), false);
	});

	it("returns false for empty string", () => {
		assert.strictEqual(isNameHeuristicPattern(""), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Aggregation and formatting
// ═══════════════════════════════════════════════════════════════════════

describe("detectOverbroadPatterns", () => {
	it("returns [] for empty input", () => {
		const result = detectOverbroadPatterns([]);
		assert.strictEqual(result.length, 0);
	});

	it("returns [] for normal patterns (secrets/, .env)", () => {
		const result = detectOverbroadPatterns(["secrets/", ".env"]);
		assert.strictEqual(result.length, 0);
	});

	it("returns unanchored-dir warning for build/", () => {
		const result = detectOverbroadPatterns(["build/"]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].category, "unanchored-dir");
		assert.deepStrictEqual(result[0].patterns, ["build/"]);
	});

	it("returns broad-file-glob warning for *.log", () => {
		const result = detectOverbroadPatterns(["*.log"]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].category, "broad-file-glob");
		assert.deepStrictEqual(result[0].patterns, ["*.log"]);
	});

	it("returns name-heuristic warning for **/*secret*", () => {
		const result = detectOverbroadPatterns(["**/*secret*"]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].category, "name-heuristic");
		assert.deepStrictEqual(result[0].patterns, ["**/*secret*"]);
	});

	it("merges same-category patterns (build/, tmp/)", () => {
		const result = detectOverbroadPatterns(["build/", "tmp/"]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].category, "unanchored-dir");
		assert.deepStrictEqual(result[0].patterns, ["build/", "tmp/"]);
	});

	it("returns separate categories for different patterns", () => {
		const result = detectOverbroadPatterns(["build/", "*.log"]);
		assert.strictEqual(result.length, 2);
		const categories = result.map((w) => w.category).sort();
		assert.deepStrictEqual(categories, ["broad-file-glob", "unanchored-dir"]);
	});

	it("returns all three categories", () => {
		const result = detectOverbroadPatterns(["build/", "*.log", "**/*secret*"]);
		assert.strictEqual(result.length, 3);
		const categories = result.map((w) => w.category).sort();
		assert.deepStrictEqual(categories, ["broad-file-glob", "name-heuristic", "unanchored-dir"]);
	});

	it("skips restrictive patterns (*, **) — not overbroad", () => {
		const result = detectOverbroadPatterns(["*", "**"]);
		assert.strictEqual(result.length, 0);
	});

	it("ignores comments", () => {
		const result = detectOverbroadPatterns(["# comment", "build/"]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].category, "unanchored-dir");
		assert.deepStrictEqual(result[0].patterns, ["build/"]);
	});

	it("safe-default patterns produce no warnings", () => {
		const result = detectOverbroadPatterns(["*.env", "secrets/", ".env.*", "**/*.pem", "**/*.key"]);
		assert.strictEqual(result.length, 0);
	});
});

describe("buildWarningMessage", () => {
	it("returns empty string for empty warnings", () => {
		assert.strictEqual(buildWarningMessage([]), "");
	});

	it("includes category label and pattern for single warning", () => {
		const msg = buildWarningMessage([{ category: "unanchored-dir", patterns: ["build/"] }]);
		assert.ok(msg.includes("Unanchored generic directories"), msg);
		assert.ok(msg.includes("build/"), msg);
	});

	it("includes all patterns for single category with multiple patterns", () => {
		const msg = buildWarningMessage([{ category: "unanchored-dir", patterns: ["build/", "tmp/"] }]);
		assert.ok(msg.includes("build/"), msg);
		assert.ok(msg.includes("tmp/"), msg);
	});

	it("includes all categories in output", () => {
		const msg = buildWarningMessage([
			{ category: "unanchored-dir", patterns: ["build/"] },
			{ category: "broad-file-glob", patterns: ["*.log"] },
			{ category: "name-heuristic", patterns: ["**/*secret*"] },
		]);
		assert.ok(msg.includes("Unanchored generic directories"), msg);
		assert.ok(msg.includes("Broad file-type globs"), msg);
		assert.ok(msg.includes("Name-heuristic patterns"), msg);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Global companion (piignore-trust-check)
// ═══════════════════════════════════════════════════════════════════════

describe("piignore-trust-check companion", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-companion-test-"));
	const testDir = path.join(tmpRoot, "project");

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	// ── Registration ─────────────────────────────────────────────────

	it("companion registers a project_trust handler on init", () => {
		const api = createMockAPI();
		assert.strictEqual(api.getProjectTrustHandler(), undefined, "no handler before init");

		createCompanion(api as any);

		const handler = api.getProjectTrustHandler();
		assert.ok(handler, "companion should register project_trust handler");
	});

	// ── No .piignore ─────────────────────────────────────────────────

	it("project has no .piignore — returns undecided, no warning", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided when no .piignore");
		assert.strictEqual(warned, false, "should not warn when no .piignore");
	});

	// ── Restrictive patterns ─────────────────────────────────────────

	it("project has .piignore with restrictive pattern (**) — warns user", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "**\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		let warnMsg = "";
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					warned = true;
					warnMsg = msg;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should still return undecided");
		assert.ok(warned, "should warn about restrictive pattern");
		assert.ok(
			warnMsg.includes("restrictive"),
			`warning should mention restrictive, got: ${warnMsg}`,
		);
	});

	it("project has .piignore with restrictive pattern (*) — warns user", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "*\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn about restrictive * pattern");
	});

	it("project has .piignore with restrictive pattern (/) — warns user", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn about restrictive / pattern");
	});

	it("project has .piignore with multiple restrictive patterns — warns once", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "**\n*\n/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warnCount = 0;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warnCount++;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warnCount >= 1, "should warn at least once");
	});

	// ── Normal patterns (no warning) ─────────────────────────────────

	it("project has .piignore with normal patterns (.env, secrets/) — no warning", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\nsecrets/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided");
		assert.strictEqual(warned, false, "should NOT warn about normal patterns");
	});

	// ── Error handling ───────────────────────────────────────────────

	it("readFileSync throws EACCES — caught, returns undecided", () => {
		// Create .piignore then make it unreadable
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\n", "utf-8");
		fs.chmodSync(path.join(testDir, ".piignore"), 0o000);

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided on EACCES");
		assert.strictEqual(warned, false, "should not warn on EACCES");
	});

	it(".piignore content is binary garbage — handled gracefully, returns undecided", () => {
		const binaryContent = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x82]);
		fs.writeFileSync(path.join(testDir, ".piignore"), binaryContent);

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		// Should not throw
		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided for binary content");
	});

	it("ctx.cwd is undefined — does not throw, returns undecided", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		const ctx: ProjectTrustContext = {
			cwd: undefined as unknown as string,
			hasUI: false,
			ui: {
				notify: () => {},
			},
		};

		// Should not throw
		const result = handler({ projectPath: "" }, ctx);
		assert.strictEqual(
			result.trusted,
			"undecided",
			"should return undecided when cwd is undefined",
		);
	});

	it("ctx.cwd is empty string — does not throw, returns undecided", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		const ctx: ProjectTrustContext = {
			cwd: "",
			hasUI: false,
			ui: {
				notify: () => {},
			},
		};

		const result = handler({ projectPath: "" }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided when cwd is empty");
	});

	// ── Invariants ───────────────────────────────────────────────────

	it("handler never returns 'yes' or 'no' — only 'undecided'", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		// Test with restrictive patterns (should still return undecided)
		fs.writeFileSync(path.join(testDir, ".piignore"), "**\n", "utf-8");

		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		// The handler must never return yes or no — it's read-only observation
		assert.ok(
			result.trusted === "undecided",
			`handler should always return undecided, got: ${result.trusted}`,
		);
	});

	it("handler does not throw — all errors caught internally", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		// Trigger various error scenarios
		const testCases: ProjectTrustContext[] = [
			{ cwd: "/nonexistent/path", hasUI: false, ui: { notify: () => {} } },
			{ cwd: testDir, hasUI: false, ui: { notify: () => {} } },
			{ cwd: "", hasUI: false, ui: { notify: () => {} } },
		];

		for (const ctx of testCases) {
			// Should never throw
			assert.doesNotThrow(() => {
				handler({ projectPath: ctx.cwd || "" }, ctx);
			}, `handler should not throw for cwd="${ctx.cwd}"`);
		}
	});

	// ── Over-broad pattern warnings ──────────────────────────────────

	it("project has .piignore with unanchored dir (build/) — warns", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "build/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		let warnMsg = "";
		let warnCount = 0;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					warned = true;
					warnCount++;
					warnMsg = msg;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn about unanchored dir");
		assert.ok(warnMsg.includes("build/"), `msg should mention build/, got: ${warnMsg}`);
		assert.ok(
			warnMsg.includes("Unanchored generic directories"),
			`msg should contain category label`,
		);
		assert.strictEqual(warnCount, 1, "should call ui.notify exactly once");
	});

	it("project has .piignore with broad file glob (*.log) — warns", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "*.log\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		let warnCount = 0;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
					warnCount++;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn about broad file glob");
		assert.strictEqual(warnCount, 1, "should call ui.notify exactly once");
	});

	it("project has .piignore with name-heuristic pattern (**/*secret*) — warns", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "**/*secret*\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		let warnCount = 0;
		let warnMsg = "";
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					warned = true;
					warnCount++;
					warnMsg = msg;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn about name-heuristic pattern");
		assert.ok(warnMsg.includes("secret"), `msg should mention secret, got: ${warnMsg}`);
		assert.strictEqual(warnCount, 1, "should call ui.notify exactly once");
	});

	it("multiple over-broad patterns — single notification", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "build/\n*.log\n**/*secret*\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		let warnCount = 0;
		let warnMsg = "";
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					warned = true;
					warnCount++;
					warnMsg = msg;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn");
		assert.strictEqual(warnCount, 1, "should be single notification");
		assert.ok(warnMsg.includes("build/"), `msg should mention build/, got: ${warnMsg}`);
		assert.ok(warnMsg.includes("*.log"), `msg should mention *.log`);
		assert.ok(warnMsg.includes("secret"), `msg should mention secret`);
	});

	it("restrictive + overbroad patterns — combined single notification", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "**\nbuild/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		let warnCount = 0;
		let warnMsg = "";
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					warned = true;
					warnCount++;
					warnMsg = msg;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn");
		assert.strictEqual(warnCount, 1, "should be single notification");
		assert.ok(warnMsg.includes("restrictive"), `msg should mention restrictive`);
		assert.ok(warnMsg.includes("build/"), `msg should mention build/`);
	});

	it("safe-default patterns (.env, secrets/) — no warning (backward compat)", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\nsecrets/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided");
		assert.strictEqual(warned, false, "should NOT warn about safe-default patterns");
	});

	it("all safe-default block patterns produce no warning", () => {
		fs.writeFileSync(
			path.join(testDir, ".piignore"),
			"*.env\n**/*.pem\n**/*.key\n.env.*\nsecrets/\n",
			"utf-8",
		);

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided");
		assert.strictEqual(warned, false, "should NOT warn about safe-default patterns");
	});

	it("empty .piignore — no warning", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided");
		assert.strictEqual(warned, false, "should NOT warn about empty .piignore");
	});

	it("comments-only .piignore — no warning", () => {
		fs.writeFileSync(
			path.join(testDir, ".piignore"),
			"# this is a comment\n# another comment\n",
			"utf-8",
		);

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.strictEqual(warned, false, "should NOT warn about comments-only .piignore");
	});

	it("hasUI: false — no notification even with overbroad patterns", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "build/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: false,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.strictEqual(warned, false, "should NOT notify when hasUI is false");
	});

	it("ui is undefined — no notification (graceful degradation)", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "build/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: undefined as unknown as { notify: (message: string, type: string) => void },
		};

		// Should not throw
		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
	});

	it("overbroad patterns with hasUI: true, ui undefined — no crash", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "build/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		const ctx = {
			cwd: testDir,
			hasUI: true,
			// no ui property
		};

		// Should not throw
		const result = handler({ projectPath: testDir }, ctx as any);
		assert.strictEqual(result.trusted, "undecided");
	});
});
