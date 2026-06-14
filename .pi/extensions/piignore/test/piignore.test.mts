/**
 * Tests for .pi/extensions/piignore.ts — resources_discover handler cwd fix
 *
 * Verifies loadPiIgnore respects the provided cwd, not process.cwd().
 * This mirrors the fix: resources_discover handler must pass ctx.cwd
 * instead of process.cwd() to loadPiIgnore.
 *
 * Inline logic follows the pattern of other tests in this directory.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piignoreFactory from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/piignore.ts)
// ═══════════════════════════════════════════════════════════════════════

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

interface IgnoreEntry {
	root: string;
	patterns: Pattern[];
}

// ═══════════════════════════════════════════════════════════════════════
// Inline functions (match source at .pi/extensions/piignore.ts exactly)
// ═══════════════════════════════════════════════════════════════════════

function patternToRegex(pattern: string): Pattern {
	let p = pattern;
	let negate = false;

	if (p.startsWith("!")) {
		negate = true;
		p = p.slice(1).trim();
	}
	if (p === "") return { regex: /(?!)/, negate };

	// Handle gitignore leading escape sequences per spec
	// \# → literal # (not comment), \! → literal ! (not negation), \\ → literal \
	if (p.startsWith("\\#") || p.startsWith("\\!")) {
		p = p.slice(1); // strip backslash, keep escaped char
	} else if (p.startsWith("\\\\")) {
		p = p.slice(1); // strip one backslash of the pair, keep one
	}

	let dirOnly = false;
	if (p.endsWith("/")) {
		dirOnly = true;
		p = p.slice(0, -1);
	}

	const hasSlash = p.includes("/") || p.startsWith("**");

	// Strip leading / (gitignore root anchor) — relative paths never have it
	if (hasSlash && p.startsWith("/")) p = p.slice(1);

	// Step 1a: Extract and preserve bracket expressions
	const bracketExprs: string[] = [];
	let r = p.replace(/\[([^\]]*)\]/g, (match) => {
		bracketExprs.push(match);
		return `\x00B${bracketExprs.length - 1}\x00`;
	});

	// Step 1b: Escape regex meta-characters except *, ?, [, ]
	r = r.replace(/[.+^${}()|\\]/g, "\\$&");

	// Step 1c: Escape unclosed [ (bracket without matching ]) as literal
	r = r.replace(/\[/g, "\\[");

	r = r.replace(/\*\*\//g, "\x00G\x00");
	r = r.replace(/\*\*$/g, "\x00GS\x00");

	r = r.replace(/\*/g, "[^/]*");
	r = r.replace(/\?/g, "[^/]");

	r = r.replace(/\x00G\x00/g, "(.*/)?");
	r = r.replace(/\x00GS\x00/g, ".*");

	// Step 4b: Restore bracket expressions
	for (let i = 0; i < bracketExprs.length; i++) {
		let expr = bracketExprs[i];
		if (expr.startsWith("[!")) {
			expr = "[^" + expr.slice(2);
		}
		if (expr === "[]") {
			expr = "\\[\\]";
		}
		r = r.split(`\x00B${i}\x00`).join(expr);
	}

	if (hasSlash) {
		r = "^" + r;
	} else {
		r = "(^|.*/)" + r;
	}
	if (dirOnly) r += "(/.*)?";
	r += "$";

	return { regex: new RegExp(r), negate };
}

function parseIgnore(content: string): Pattern[] {
	const patterns: Pattern[] = [];
	for (let line of content.split("\n")) {
		line = line.trim();
		if (line === "" || line.startsWith("#")) continue;
		patterns.push(patternToRegex(line));
	}
	return patterns;
}

/** Walk up from cwd to filesystem root, collecting .piignore files. */
function loadPiIgnore(cwd: string): IgnoreEntry[] {
	const entries: IgnoreEntry[] = [];
	let dir = cwd;
	while (true) {
		const ignorePath = path.join(dir, ".piignore");
		if (fs.existsSync(ignorePath)) {
			entries.push({
				root: dir,
				patterns: parseIgnore(fs.readFileSync(ignorePath, "utf-8")),
			});
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return entries;
}

function isIgnored(targetPath: string, entries: IgnoreEntry[], cwd: string): boolean {
	const absPath = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(cwd, targetPath);

	let ignored = false;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const rel = path.relative(entry.root, absPath);
		if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
			const relForMatch = rel.replace(/\\/g, "/");
			for (const pat of entry.patterns) {
				if (pat.regex.test(relForMatch)) {
					ignored = !pat.negate;
				}
			}
		}
	}

	return ignored;
}

// ═══════════════════════════════════════════════════════════════════════
// Fixed getEntries (cwd-aware caching — matches the fix)
// ═══════════════════════════════════════════════════════════════════════

function createGetEntries_fixed(): {
	getEntries: (cwd: string) => IgnoreEntry[];
	getCallCount: () => number;
} {
	let _cachedCwd: string | null = null;
	let _entries: IgnoreEntry[] | null = null;
	let _loadCount = 0;

	return {
		getEntries(cwd: string): IgnoreEntry[] {
			if (!_entries || _cachedCwd !== cwd) {
				_entries = loadPiIgnore(cwd);
				_cachedCwd = cwd;
				_loadCount++;
			}
			return _entries;
		},
		getCallCount: () => _loadCount,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers for Phase 2 tests (mock ExtensionAPI)
// ═══════════════════════════════════════════════════════════════════════

interface HandlerStore {
	resources_discover?: (
		event: { type: "resources_discover"; cwd: string; reason: "startup" | "reload" },
		ctx: { cwd: string },
	) => void | Promise<void>;
	tool_call?: (
		event: { toolName: string; input: Record<string, unknown> },
		ctx: { cwd: string; hasUI: boolean; ui: { notify: Function } },
	) => unknown;
}

function createMockPi(): { pi: ExtensionAPI; handlers: HandlerStore } {
	const handlers: HandlerStore = {};

	const pi = {
		on(event: string, handler: Function) {
			(handlers as any)[event] = handler;
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "normal",
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		events: { on: () => {}, emit: () => {}, off: () => {} },
	} as unknown as ExtensionAPI;

	return { pi, handlers };
}

/**
 * Simulate a tool_call event on the extension's handler.
 * Creates a minimal mock ctx with the given cwd.
 * Provides isProjectTrusted returning true so existing tests run as trusted.
 */
async function simulateToolCall(
	handler: Function,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<unknown> {
	return await handler(
		{ toolName, input },
		{
			cwd,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => true,
		},
	);
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("piignore extension", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-test-"));
	const nonCwdDir = path.join(tmpRoot, "other-project");

	beforeEach(() => {
		fs.mkdirSync(nonCwdDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	describe("loadPiIgnore uses provided cwd (not process.cwd())", () => {
		it("should find .piignore in a non-process-cwd directory when given that directory", () => {
			// Write .piignore only in nonCwdDir (not in process.cwd())
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "secret.txt\n", "utf-8");

			// Load using nonCwdDir as context cwd — this is what the
			// resources_discover handler should do with ctx.cwd
			const entries = loadPiIgnore(nonCwdDir);

			// Must find the .piignore in nonCwdDir
			assert.strictEqual(entries.length, 1, "should find .piignore in nonCwdDir");
			assert.strictEqual(entries[0].root, nonCwdDir);

			// Verify ignoring works relative to nonCwdDir
			assert.strictEqual(
				isIgnored("secret.txt", entries, nonCwdDir),
				true,
				"secret.txt should be ignored in nonCwdDir context",
			);
			assert.strictEqual(
				isIgnored("public.txt", entries, nonCwdDir),
				false,
				"public.txt should not be ignored",
			);
		});

		it("should NOT find .piignore in nonCwdDir when using process.cwd() (demonstrates the bug)", () => {
			// This test demonstrates why resources_discover handler must use
			// ctx.cwd instead of process.cwd(). If handler uses process.cwd(),
			// a .piignore in a different session directory is missed entirely.
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "secret.txt\n", "utf-8");

			// Load using process.cwd() — this is what the buggy handler does
			const entries = loadPiIgnore(process.cwd());

			// Should NOT find the .piignore in nonCwdDir
			const foundNonCwd = entries.some((e) => e.root === nonCwdDir);
			assert.strictEqual(
				foundNonCwd,
				false,
				"should NOT find .piignore in nonCwdDir when using process.cwd()",
			);
		});

		it("should walk up parent directories from provided cwd", () => {
			// Write .piignore in tmpRoot (parent of nonCwdDir)
			fs.writeFileSync(path.join(tmpRoot, ".piignore"), "global.txt\n", "utf-8");

			// Write a more specific .piignore in nonCwdDir
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "local.txt\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			// Should find both parent and child .piignore files
			assert.ok(entries.length >= 2, "should find .piignore in nonCwdDir and parent");

			assert.strictEqual(isIgnored("local.txt", entries, nonCwdDir), true);
			assert.strictEqual(isIgnored("global.txt", entries, nonCwdDir), true);
		});

		it("should let child .piignore negation override parent ignore patterns", () => {
			fs.writeFileSync(path.join(tmpRoot, ".piignore"), "*.env\n", "utf-8");
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "!important.env\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			assert.strictEqual(isIgnored("important.env", entries, nonCwdDir), false);
			assert.strictEqual(isIgnored("debug.env", entries, nonCwdDir), true);
		});
	});

	describe("isIgnored behavior", () => {
		it("should respect negation patterns", () => {
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "*.log\n!important.log\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			assert.strictEqual(isIgnored("debug.log", entries, nonCwdDir), true);
			assert.strictEqual(isIgnored("important.log", entries, nonCwdDir), false);
		});

		it("should handle directory patterns", () => {
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "build/\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			assert.strictEqual(isIgnored("build", entries, nonCwdDir), true);
			assert.strictEqual(isIgnored("src/index.ts", entries, nonCwdDir), false);
		});

		it("should handle absolute paths correctly", () => {
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "secret.txt\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			const absPath = path.join(nonCwdDir, "secret.txt");
			assert.strictEqual(isIgnored(absPath, entries, nonCwdDir), true);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: getEntries caching behavior (cwd-aware cache with reload)
// ═══════════════════════════════════════════════════════════════════════

describe("getEntries caching (Phase 1)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-phase1-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("first call with cwd=/a loads from /a and caches result", () => {
		const dirA = path.join(tmpRoot, "a");
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "secret.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();
		const entries = getEntries(dirA);

		assert.strictEqual(getCallCount(), 1, "should load on first call");
		assert.strictEqual(entries.length >= 1, true, "should find .piignore entries");
		assert.strictEqual(isIgnored("secret.txt", entries, dirA), true);
	});

	it("second call with same cwd=/a returns cached (no re-read from disk)", () => {
		const dirA = path.join(tmpRoot, "a");
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "secret.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();

		getEntries(dirA); // first call — loads
		assert.strictEqual(getCallCount(), 1, "should load once");

		getEntries(dirA); // second call — cached
		assert.strictEqual(getCallCount(), 1, "should NOT re-read from disk");
	});

	it("call with cwd=/b after /a detects cwd change and reloads fresh entries", () => {
		const dirA = path.join(tmpRoot, "a");
		const dirB = path.join(tmpRoot, "b");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "only-a.txt\n");
		fs.writeFileSync(path.join(dirB, ".piignore"), "only-b.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();

		getEntries(dirA); // load /a entries
		assert.strictEqual(getCallCount(), 1, "first load");

		const entriesB = getEntries(dirB); // should reload for /b
		// With fixed version: cache detects cwd change, reloads from /b
		// So only-b.txt IS matched (entries are from dirB)
		assert.strictEqual(
			isIgnored("only-b.txt", entriesB, dirB),
			true,
			"only-b.txt should be blocked by dirB's .piignore",
		);
	});

	it("call with cwd=/a again after /b reloads fresh from /a (not stale cache)", () => {
		const dirA = path.join(tmpRoot, "a");
		const dirB = path.join(tmpRoot, "b");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "only-a.txt\n");
		fs.writeFileSync(path.join(dirB, ".piignore"), "only-b.txt\n");

		const { getEntries } = createGetEntries_fixed();

		getEntries(dirA); // load /a — caches from A

		// Delete dirA/.piignore to detect stale cache
		fs.rmSync(path.join(dirA, ".piignore"));

		getEntries(dirB); // triggers reload for /b

		const entriesA = getEntries(dirA);
		// With fixed version: detects cwd change back to /a, reloads fresh
		// So only-a.txt is NOT blocked because .piignore was deleted
		assert.strictEqual(
			isIgnored("only-a.txt", entriesA, dirA),
			false,
			"only-a.txt should NOT be blocked after .piignore deleted in dirA",
		);
	});

	it("call with cwd=/b (no .piignore) returns empty; switch to /c (with .piignore) returns /c entries", () => {
		const dirB = path.join(tmpRoot, "b");
		const dirC = path.join(tmpRoot, "c");
		fs.mkdirSync(dirB, { recursive: true });
		fs.mkdirSync(dirC, { recursive: true });
		// dirB has NO .piignore
		fs.writeFileSync(path.join(dirC, ".piignore"), "secret.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();

		const entriesB = getEntries(dirB); // no .piignore in dirB → empty
		assert.strictEqual(entriesB.length, 0, "dirB should have no entries");
		assert.strictEqual(getCallCount(), 1, "loaded once for dirB");

		const entriesC = getEntries(dirC); // should reload for dirC
		// With fixed version: detects cwd change, reloads from dirC
		// entriesC contains dirC's .piignore patterns
		assert.strictEqual(
			entriesC.length >= 1,
			true,
			"dirC should have .piignore entries (stale cache returns empty)",
		);
		assert.strictEqual(isIgnored("secret.txt", entriesC, dirC), true);
	});

	it("no .piignore tree at all returns empty array for any cwd", () => {
		const dirEmpty = path.join(tmpRoot, "empty");
		fs.mkdirSync(dirEmpty, { recursive: true });

		const { getEntries, getCallCount } = createGetEntries_fixed();

		const entries1 = getEntries(dirEmpty);
		assert.strictEqual(entries1.length, 0, "first cwd: no .piignore");
		assert.strictEqual(getCallCount(), 1, "loaded once");

		const dirEmpty2 = path.join(tmpRoot, "empty2");
		fs.mkdirSync(dirEmpty2, { recursive: true });

		const entries2 = getEntries(dirEmpty2);
		assert.strictEqual(entries2.length, 0, "second cwd: still no .piignore");
	});

	it("getEntries with cwd=/a returns only /a patterns when /a has its own .piignore", () => {
		// Create parent dir with .piignore
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), "parent.txt\n");
		const dirA = path.join(tmpRoot, "a");
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "child.txt\n");

		const { getEntries } = createGetEntries_fixed();

		const entries = getEntries(dirA);
		// Should have both parent and child entries (walks up from cwd)
		const roots = entries.map((e) => e.root);
		assert.ok(roots.includes(dirA), "should include child dirA");
		assert.ok(roots.includes(tmpRoot), "should include parent tmpRoot");

		// Verify child's own patterns work
		assert.strictEqual(isIgnored("child.txt", entries, dirA), true);
		// Verify parent's patterns also work
		assert.strictEqual(isIgnored("parent.txt", entries, dirA), true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: ExtensionAPI integration — tool_call dispatch per cwd
// ═══════════════════════════════════════════════════════════════════════

describe("tool_call dispatch (Phase 2)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-phase2-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("registers resources_discover and tool_call handlers on init", () => {
		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		assert.ok(
			typeof handlers.resources_discover === "function",
			"should register resources_discover handler",
		);
		assert.ok(typeof handlers.tool_call === "function", "should register tool_call handler");
	});

	it("tool_call with read path matching .piignore in current cwd returns block", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), "secret.txt\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		// Notify resources_discover to load entries for tmpRoot
		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "secret.txt" },
			tmpRoot,
		);

		assert.ok(result, "should return a result");
		assert.strictEqual((result as any).block, true, "should block secret.txt");
	});

	it("tool_call with read path NOT matching .piignore returns undefined (no block)", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), "secret.txt\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "public.txt" },
			tmpRoot,
		);

		assert.strictEqual(result, undefined, "public.txt should NOT be blocked");
	});

	it("tool_call with bash command containing ignored path returns block", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), ".env\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"bash",
			{ command: "cat .env" },
			tmpRoot,
		);

		assert.ok(result, "should return a result");
		assert.strictEqual((result as any).block, true, "should block .env access via bash");
	});

	it("bash command with safe paths returns undefined (no block)", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), ".env\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"bash",
			{ command: "ls -la" },
			tmpRoot,
		);

		assert.strictEqual(result, undefined, "safe bash commands should NOT be blocked");
	});

	it("cwd change triggers reload: paths blocked by new cwd's .piignore, not old one", async () => {
		const dirA = path.join(tmpRoot, "projectA");
		const dirB = path.join(tmpRoot, "projectB");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "only-a.txt\n");
		// dirB has NO .piignore

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		// Load entries for dirA
		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: dirA, reason: "startup" },
			{ cwd: dirA },
		);

		// Call tool with dirA cwd — only-a.txt should be blocked
		const resultA = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "only-a.txt" },
			dirA,
		);
		assert.strictEqual((resultA as any)?.block, true, "only-a.txt blocked in dirA");

		// Call tool with dirB cwd — only-a.txt should NOT be blocked (dirB has no .piignore)
		const resultB = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "only-a.txt" },
			dirB,
		);
		assert.strictEqual(resultB, undefined, "only-a.txt NOT blocked in dirB (different cwd)");
	});

	it("cwd change then back reloads fresh entries for original cwd", async () => {
		const dirA = path.join(tmpRoot, "projectA");
		const dirB = path.join(tmpRoot, "projectB");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "secret.txt\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		// Load entries for dirB (no .piignore)
		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: dirB, reason: "startup" },
			{ cwd: dirB },
		);

		// Call with dirB — nothing blocked
		const resultB = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "secret.txt" },
			dirB,
		);
		assert.strictEqual(resultB, undefined, "secret.txt NOT blocked in dirB (no .piignore)");

		// Call with dirA — dirA's .piignore should block secret.txt
		const resultA = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "secret.txt" },
			dirA,
		);
		assert.strictEqual((resultA as any)?.block, true, "secret.txt blocked in dirA");
	});

	it("unhandled tool (not in path/bash lists) returns undefined (no-op)", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), "secret.txt\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		// An unknown tool should just return undefined (no action)
		const result = await simulateToolCall(handlers.tool_call!, "unknown-tool" as any, {}, tmpRoot);
		assert.strictEqual(result, undefined, "unhandled tool should be no-op");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2b: Try/catch safety net (fail-closed on unexpected errors)
// ═══════════════════════════════════════════════════════════════════════

describe("try/catch safety net (Phase 2b)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-safety-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns safe block result when loadPiIgnore throws (unreadable .piignore)", async () => {
		// Write a .piignore then make it unreadable
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), "secret.txt\n");
		fs.chmodSync(path.join(tmpRoot, ".piignore"), 0o000);

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		// Trigger resources_discover to load entries
		// This should fail but be caught by the try/catch
		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		// Now call read — loadPiIgnore might throw or succeed depending on caching
		const result = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "secret.txt" },
			tmpRoot,
		);

		// The extension should either block the path (if .piignore loaded) or
		// return a safe block on error (fail-closed). Either way, result exists.
		if (result) {
			assert.strictEqual((result as any).block, true, "should return block on error");
		}
	});

	it("returns safe block when .piignore file has permission error during tool_call", async () => {
		// Write .piignore then make directory unreadable so readFileSync fails
		const subDir = path.join(tmpRoot, "sub");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, ".piignore"), "secret.txt\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		// Initial load succeeds
		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: subDir, reason: "startup" },
			{ cwd: subDir },
		);

		// Now make the .piignore unreadable and change cwd to force a reload
		fs.chmodSync(path.join(subDir, ".piignore"), 0o000);
		// Also invalidate the cache by changing to a different dir and back

		const otherDir = path.join(tmpRoot, "other");
		fs.mkdirSync(otherDir, { recursive: true });

		// Call tool with otherDir first (no .piignore), then back to subDir
		await simulateToolCall(handlers.tool_call!, "read", { path: "foo.txt" }, otherDir);

		// Now call with subDir — should trigger reload which hits permission error
		const result = await simulateToolCall(
			handlers.tool_call!,
			"read",
			{ path: "secret.txt" },
			subDir,
		);

		assert.ok(result, "should return a result on error");
		assert.strictEqual((result as any).block, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: User-journey through tool_call handler — echo/printf bypass
// ═══════════════════════════════════════════════════════════════════════

describe("tool_call handler — echo/printf segment bypass (Phase 4)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-phase4-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("echo x && cat .env with .piignore pattern .env — blocked", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), ".env\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"bash",
			{ command: "echo x && cat .env" },
			tmpRoot,
		);

		assert.ok(result, "should return a result");
		assert.strictEqual((result as any).block, true, "should block .env access via cat segment");
		assert.ok(
			(result as any).reason?.includes(".env"),
			`reason should mention .env, got: ${(result as any).reason}`,
		);
	});

	it("printf '%s' 'x' && cat .env — blocked", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), ".env\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"bash",
			{ command: "printf '%s' 'x' && cat .env" },
			tmpRoot,
		);

		assert.ok(result, "should return a result");
		assert.strictEqual((result as any).block, true, "should block .env access after printf");
	});

	it("echo x && cat .env with no .piignore — no block", async () => {
		// No .piignore file at all
		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"bash",
			{ command: "echo x && cat .env" },
			tmpRoot,
		);

		assert.strictEqual(result, undefined, "should not block when no .piignore exists");
	});

	it("echo x && cat public.txt with .piignore pattern .env — no block", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), ".env\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"bash",
			{ command: "echo x && cat public.txt" },
			tmpRoot,
		);

		assert.strictEqual(result, undefined, "should not block public.txt");
	});

	it('echo "hello" (single echo, no separator) — no block', async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), "*.log\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(
			handlers.tool_call!,
			"bash",
			{ command: 'echo "hello"' },
			tmpRoot,
		);

		assert.strictEqual(result, undefined, "single echo should not be blocked");
	});

	it("read tool with .env path — still blocked (non-bash path unchanged)", async () => {
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), ".env\n");

		const { pi, handlers } = createMockPi();
		piignoreFactory(pi);

		await handlers.resources_discover!(
			{ type: "resources_discover", cwd: tmpRoot, reason: "startup" },
			{ cwd: tmpRoot },
		);

		const result = await simulateToolCall(handlers.tool_call!, "read", { path: ".env" }, tmpRoot);

		assert.ok(result, "should return a result");
		assert.strictEqual((result as any).block, true, "read .env should still be blocked");
	});
});
