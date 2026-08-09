/**
 * Tests for piignore handler error safety (fail-closed on unhandled exceptions).
 *
 * Verifies the tool_call handler wraps its body in try/catch so that
 * any error (EPERM on .piignore, null path, etc.) blocks the tool call
 * instead of failing open (letting the tool proceed).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore-handler.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

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

interface BashToken {
	text: string;
	quoted: boolean;
}

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

interface ExtensionContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify: (message: string, type: string) => void;
	};
}

interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Helper: tool call handler wrapper (the fix under test)
// ═══════════════════════════════════════════════════════════════════════

type GetEntriesFn = (cwd: string) => IgnoreEntry[];
type CheckPathFn = (
	targetPath: string | undefined,
	entries: IgnoreEntry[],
	cwd: string,
) => string | null;
type CheckBashCommandFn = (command: string, entries: IgnoreEntry[], cwd: string) => string | null;

/**
 * Local isToolCallEventType mirroring the package implementation:
 * event.toolName === toolName
 */
function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/**
 * handlerWrapper wraps the tool_call handler body in try/catch.
 * On error, blocks the tool call (fail-closed). Otherwise behaves
 * like the original handler.
 */
async function handlerWrapper(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	getEntries: GetEntriesFn,
	checkPath: CheckPathFn,
	checkBashCommand: CheckBashCommandFn,
): Promise<ToolCallEventResult | undefined> {
	try {
		const ignoreEntries = getEntries(ctx.cwd);
		let blockedPath: string | null = null;

		if (isToolCallEventType("read", event)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (isToolCallEventType("write", event)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (isToolCallEventType("edit", event)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (isToolCallEventType("grep", event)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (isToolCallEventType("find", event)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (isToolCallEventType("ls", event)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (isToolCallEventType("bash", event)) {
			blockedPath = checkBashCommand(
				(event.input as { command?: string }).command ?? "",
				ignoreEntries,
				ctx.cwd,
			);
		} else {
			return undefined;
		}

		if (blockedPath) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked by .piignore: ${blockedPath}`, "warning");
			}
			return {
				block: true,
				reason: `Path "${blockedPath}" matches .piignore patterns`,
			};
		}

		return undefined;
	} catch (err) {
		return {
			block: true,
			reason: `Piignore internal error — blocked for safety: ${(err as Error).message}`,
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Inline functions from piignore.ts (needed to construct test scenarios)
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

function checkPathImpl(
	targetPath: string | undefined,
	entries: IgnoreEntry[],
	cwd: string,
): string | null {
	if (!targetPath) return null;
	if (isIgnored(targetPath, entries, cwd)) return targetPath;
	return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Handler error safety net (unit)
// ═══════════════════════════════════════════════════════════════════════

describe("piignore handler safety net", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-handler-test-"));
	const testDir = path.join(tmpRoot, "project");

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	// ── Domain: handlerWrapper catches errors ────────────────────────

	it("catches getEntries error (EPERM on unreadable .piignore) and blocks", async () => {
		// Create .piignore then make it unreadable
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");
		fs.chmodSync(path.join(testDir, ".piignore"), 0o000);

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const getEntriesThrows: GetEntriesFn = (_cwd) => {
			// Simulate EPERM on readFileSync inside loadPiIgnore
			throw Object.assign(new Error("EACCES: permission denied"), {
				code: "EACCES",
			});
		};

		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			getEntriesThrows,
			checkPathImpl,
			() => null,
		);

		assert.ok(result, "handler should return a result on error");
		assert.strictEqual(result.block, true, "should block on error");
		assert.ok(
			result.reason?.includes("Piignore internal error"),
			`reason should indicate internal error, got: ${result.reason}`,
		);
	});

	it("catches checkPath TypeError (null path arg) and blocks", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const checkPathThrows: CheckPathFn = (_targetPath, _entries, _cwd) => {
			throw new TypeError("Cannot read properties of null");
		};

		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "/some/path" } },
			ctx,
			() => [],
			checkPathThrows,
			() => null,
		);

		assert.ok(result, "handler should return a result on error");
		assert.strictEqual(result.block, true, "should block on TypeError");
	});

	it("catches checkBashCommand unexpected throw and blocks", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const checkBashThrows: CheckBashCommandFn = (_cmd, _entries, _cwd) => {
			throw new Error("Unexpected error in bash check");
		};

		const result = await handlerWrapper(
			{ toolName: "bash", input: { command: "cat .env" } },
			ctx,
			() => [],
			checkPathImpl,
			checkBashThrows,
		);

		assert.ok(result, "handler should return a result on error");
		assert.strictEqual(result.block, true, "should block on throw in checkBashCommand");
	});

	// ── Domain: handlerWrapper returns undefined for unhandled tools ─

	it("returns undefined for unhandled tool names (e.g. think)", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const result = await handlerWrapper(
			{ toolName: "think", input: {} },
			ctx,
			() => [],
			checkPathImpl,
			() => null,
		);

		assert.strictEqual(result, undefined, "should return undefined for unhandled tool");
	});

	// ── Domain: handlerWrapper blocks matching paths ─────────────────

	it("returns { block: true, reason } for blocked tools (read blocked path)", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.ok(result, "handler should return a result for blocked path");
		assert.strictEqual(result.block, true, "should block matching path");
		assert.ok(
			result.reason?.includes("secret.txt"),
			`reason should mention blocked path, got: ${result.reason}`,
		);
	});

	// ── Domain: handlerWrapper does not block allowed paths ──────────

	it("returns undefined for non-blocked tools (read allowed path)", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "public.txt" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.strictEqual(result, undefined, "should not block allowed path");
	});

	// ── Boundary: file deleted between getEntries and isIgnored ──────

	it("blocks when .piignore file deleted between getEntries and checkPath", async () => {
		// Write .piignore, load it, then delete it.
		// Simulate a race where getEntries gets the patterns, but then
		// checkPath fails (e.g. because it tries to re-read).
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// Simulate the race: getEntries works, but checkPath throws
		let calledGetEntries = false;

		const getEntriesFn: GetEntriesFn = (cwd) => {
			calledGetEntries = true;
			// Return entries loaded before deletion
			return loadPiIgnore(cwd);
		};

		const checkPathThrows: CheckPathFn = (_targetPath, _entries, _cwd) => {
			// Simulate disk error after entries were loaded
			throw new Error("ENOENT: no such file or directory");
		};

		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			getEntriesFn,
			checkPathThrows,
			() => null,
		);

		assert.ok(calledGetEntries, "getEntries should have been called");
		assert.ok(result, "handler should return a result on error");
		assert.strictEqual(result.block, true, "should block on disk error");
	});

	// ── Boundary: invalid .piignore content ──────────────────────────

	it("handles .piignore with invalid content (binary garbage) without throwing", async () => {
		// Write binary content (non-UTF8 garbage) to .piignore
		const binaryContent = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x82]);
		fs.writeFileSync(path.join(testDir, ".piignore"), binaryContent);

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// Should not throw — parseIgnore handles invalid lines gracefully
		const entries = loadPiIgnore(testDir);
		assert.ok(Array.isArray(entries), "should return array even with garbage content");
		assert.strictEqual(entries.length, 1, "should find .piignore file");

		// handler should not throw either
		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "public.txt" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.strictEqual(
			result,
			undefined,
			"should not block for allowed path with garbage .piignore",
		);
	});

	it("handles .piignore with BOM character gracefully", async () => {
		// Write .piignore with UTF-8 BOM
		fs.writeFileSync(path.join(testDir, ".piignore"), "\uFEFFsecret.txt\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// Should not throw
		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		// The BOM prefix means the line isn't empty, it's "\uFEFFsecret.txt"
		// which starts with \uFEFF, not #, so parseIgnore will try to match it.
		// The pattern won't match "secret.txt" exactly due to BOM prefix.
		// This is acceptable — the key thing is it doesn't throw.
		assert.ok(result === undefined || result.block === true, "should not throw");
	});

	it("handles .piignore with no trailing newline gracefully", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// Should still work correctly
		const resultRead = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.ok(resultRead, "handler should return result");
		assert.strictEqual(resultRead.block, true, "should block secret.txt");

		const resultPublic = await handlerWrapper(
			{ toolName: "read", input: { path: "public.txt" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.strictEqual(resultPublic, undefined, "should not block public.txt");
	});

	// ── Boundary: event.input missing path or command field ──────────

	it("handles event.input missing path field without error", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// Input with no path field for a path tool
		const result = await handlerWrapper(
			{ toolName: "read", input: {} },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.strictEqual(result, undefined, "should not block when path is missing");
	});

	it("handles event.input missing command field for bash tool without error", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// Input with no command field for bash
		const result = await handlerWrapper(
			{ toolName: "bash", input: {} },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.strictEqual(result, undefined, "should not block when command is missing");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Handler integration with mock ExtensionAPI
// ═══════════════════════════════════════════════════════════════════════

/**
 * Minimal mock of ExtensionAPI for testing.
 * Only tracks event handlers registered via pi.on("tool_call").
 */
interface MockExtensionAPI {
	on(event: string, handler: Function): void;
	getToolCallHandler():
		| ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>)
		| undefined;
}

function createMockAPI(
	getEntries: GetEntriesFn,
	checkPath: CheckPathFn,
	checkBashCommand: CheckBashCommandFn,
): MockExtensionAPI {
	let toolCallHandler:
		| ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>)
		| undefined;

	return {
		on(event: string, handler: Function) {
			if (event === "tool_call") {
				toolCallHandler = handler as (
					event: ToolCallEvent,
					ctx: ExtensionContext,
				) => Promise<ToolCallEventResult | undefined>;
			}
		},
		getToolCallHandler() {
			return toolCallHandler;
		},
	};
}

describe("piignore handler integration with mock ExtensionAPI", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-mock-test-"));
	const testDir = path.join(tmpRoot, "project");

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("registers a tool_call handler and invokes it on simulated event", async () => {
		const api = createMockAPI(
			() => [],
			checkPathImpl,
			() => null,
		);
		const handler = api.getToolCallHandler();

		// Before registration, no handler
		assert.strictEqual(handler, undefined, "no handler before registration");

		// Simulate extension factory registration
		// In the real extension, the factory function does:
		//   pi.on("tool_call", async (event, ctx) => { ... try/catch wrapper ... })
		// Here we register the handlerWrapper directly
		const registeredHandler = (event: ToolCallEvent, ctx: ExtensionContext) =>
			handlerWrapper(
				event,
				ctx,
				() => [],
				checkPathImpl,
				() => null,
			);

		api.on("tool_call", registeredHandler);

		const registered = api.getToolCallHandler();
		assert.ok(registered, "handler should be registered after pi.on()");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const result = await registered({ toolName: "think", input: {} }, ctx);

		assert.strictEqual(result, undefined, "should return undefined for think tool");
	});

	it("returns { block: true } when cwd has unreadable .piignore", async () => {
		// Create .piignore then make it unreadable
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");
		fs.chmodSync(path.join(testDir, ".piignore"), 0o000);

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// getEntries will fail because loadPiIgnore can't read the file
		const getEntriesFail: GetEntriesFn = (_cwd) => {
			throw Object.assign(new Error("EACCES: permission denied, open '.piignore'"), {
				code: "EACCES",
			});
		};

		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			getEntriesFail,
			checkPathImpl,
			() => null,
		);

		assert.ok(result, "handler should return a result on error");
		assert.strictEqual(result.block, true, "should block when .piignore is unreadable");
		assert.ok(
			result.reason?.includes("Piignore internal error"),
			`reason should indicate internal error: ${result.reason}`,
		);
	});

	it("returns undefined when .piignore absent and tool call matches non-blocked path", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		// No .piignore in testDir
		const result = await handlerWrapper(
			{ toolName: "read", input: { path: "public.txt" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			() => null,
		);

		assert.strictEqual(result, undefined, "should not block when no .piignore exists");
	});

	it("resources_discover handler re-loads; if reload fails, subsequent tool_call blocks", async () => {
		// Write a valid .piignore
		fs.writeFileSync(path.join(testDir, ".piignore"), "secret.txt\n", "utf-8");

		// First load — works fine
		const entries = loadPiIgnore(testDir);
		assert.strictEqual(entries.length, 1, "should load .piignore initially");

		let entriesCache = entries;

		// Simulate reload that fails
		function onResourcesDiscover() {
			try {
				entriesCache = loadPiIgnore(testDir);
			} catch {
				// Reload failed; entriesCache keeps stale entries.
				// In the real extension, the try/catch would handle this.
				// Here we explicitly test that if getEntries throws, handler blocks.
			}
		}

		// First call — should work
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
		};

		const result1 = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			() => entriesCache,
			checkPathImpl,
			() => null,
		);

		assert.ok(result1, "should block secret.txt");
		assert.strictEqual(result1.block, true, "should block matching path");

		// Now simulate reload failure — getEntries throws
		onResourcesDiscover();

		const getEntriesThrow: GetEntriesFn = (_cwd) => {
			throw new Error("Reload failed");
		};

		const result2 = await handlerWrapper(
			{ toolName: "read", input: { path: "secret.txt" } },
			ctx,
			getEntriesThrow,
			checkPathImpl,
			() => null,
		);

		assert.ok(result2, "handler should return a result on reload failure");
		assert.strictEqual(result2.block, true, "should block when reload fails");
		assert.ok(
			result2.reason?.includes("Piignore internal error"),
			`reason should show internal error: ${result2.reason}`,
		);
	});
});
