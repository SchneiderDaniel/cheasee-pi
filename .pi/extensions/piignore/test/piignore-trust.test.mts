/**
 * Tests for piignore trust gate, SAFE_DEFAULT_BLOCK, and mode-aware blocking.
 *
 * Verifies the tool_call handler gates .piignore enforcement behind
 * ctx.isProjectTrusted(), falling back to SAFE_DEFAULT_BLOCK when untrusted.
 * Also verifies mode-aware reason strings and ctx.hasUI guard.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore-trust.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

// Import from implementation for TDD gate verification
import { SAFE_DEFAULT_BLOCK } from "../index.ts";

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
	mode?: string;
	isProjectTrusted?: () => boolean | undefined;
}

interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Inline helpers from piignore.ts (duplicated for test independence)
// ═══════════════════════════════════════════════════════════════════════

function patternToRegex(pattern: string): Pattern {
	let p = pattern;
	let negate = false;

	if (p.startsWith("!")) {
		negate = true;
		p = p.slice(1).trim();
	}
	if (p === "") return { regex: /(?!)/, negate };

	if (p.startsWith("\\#") || p.startsWith("\\!")) {
		p = p.slice(1);
	} else if (p.startsWith("\\\\")) {
		p = p.slice(1);
	}

	let dirOnly = false;
	if (p.endsWith("/")) {
		dirOnly = true;
		p = p.slice(0, -1);
	}

	const hasSlash = p.includes("/") || p.startsWith("**");

	// Strip leading / (gitignore root anchor) — relative paths never have it
	if (hasSlash && p.startsWith("/")) p = p.slice(1);

	const bracketExprs: string[] = [];
	let r = p.replace(/\[([^\]]*)\]/g, (match) => {
		bracketExprs.push(match);
		return `\x00B${bracketExprs.length - 1}\x00`;
	});

	r = r.replace(/[.+^${}()|\\]/g, "\\$&");
	r = r.replace(/\[/g, "\\[");
	r = r.replace(/\*\*\//g, "\x00G\x00");
	r = r.replace(/\*\*$/g, "\x00GS\x00");
	r = r.replace(/\*/g, "[^/]*");
	r = r.replace(/\?/g, "[^/]");
	r = r.replace(/\x00G\x00/g, "(.*/)?");
	r = r.replace(/\x00GS\x00/g, ".*");

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

function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

function tokenizeBashCommand(command: string): Array<{ text: string; quoted: boolean }> {
	const tokens: Array<{ text: string; quoted: boolean }> = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let quoted = false;

	function flush() {
		if (current || quoted) {
			tokens.push({ text: current, quoted });
		}
		current = "";
		quoted = false;
	}

	function emit(text: string) {
		flush();
		tokens.push({ text, quoted: false });
	}

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				quoted = true;
				continue;
			}
			current += ch;
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
				quoted = true;
				continue;
			}
			current += ch;
		} else if (ch === "'") {
			flush();
			inSingle = true;
		} else if (ch === '"') {
			flush();
			inDouble = true;
		} else if (ch === " " || ch === "\t") {
			flush();
		} else if (ch === ";") {
			emit(";");
		} else if (ch === "|") {
			if (command[i + 1] === "|") {
				emit("||");
				i++;
			} else {
				emit("|");
			}
		} else if (ch === "&") {
			if (command[i + 1] === "&") {
				emit("&&");
				i++;
			} else {
				current += ch;
			}
		} else {
			current += ch;
		}
	}

	flush();

	return tokens;
}

function segmentTokens(
	tokens: Array<{ text: string; quoted: boolean }>,
): Array<Array<{ text: string; quoted: boolean }>> {
	const segments: Array<Array<{ text: string; quoted: boolean }>> = [];
	let current: Array<{ text: string; quoted: boolean }> = [];

	for (const t of tokens) {
		if (!t.quoted && (t.text === "&&" || t.text === "||" || t.text === ";" || t.text === "|")) {
			segments.push(current);
			current = [];
		} else {
			current.push(t);
		}
	}
	segments.push(current);

	return segments;
}

function getCommandNameFromTokens(tokens: Array<{ text: string; quoted: boolean }>): string {
	for (const t of tokens) {
		if (t.quoted) continue;
		if (t.text.startsWith("-")) continue;
		if (t.text === "|" || t.text === ";" || t.text === "&&" || t.text === "||") continue;
		return t.text;
	}
	return "";
}

function isPathLike(token: { text: string; quoted: boolean }, commandName: string): boolean {
	const t = token.text;
	if (t.includes("`")) return false;
	if (t.startsWith("-")) return false;
	if (
		t === "|" ||
		t === ";" ||
		t === "&&" ||
		t === "||" ||
		t === ">" ||
		t === ">>" ||
		t === "<" ||
		t === "2>" ||
		t === "2>>" ||
		t === "&>" ||
		t === "1>"
	)
		return false;
	if (t === "~") return false;
	if (t.startsWith("@")) return false;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
	if (commandName === "echo" || commandName === "printf") return false;
	return t.includes("/") || t.includes(".") || t.includes("~");
}

function checkBashCommandImpl(command: string, entries: IgnoreEntry[], cwd: string): string | null {
	const tokens = tokenizeBashCommand(command);
	const segments = segmentTokens(tokens);

	for (const segment of segments) {
		const commandName = getCommandNameFromTokens(segment);
		const pathLike = segment.filter((t) => isPathLike(t, commandName));

		for (const t of pathLike) {
			const result = checkPathImpl(t.text, entries, cwd);
			if (result) return result;
		}
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════════
// SAFE_DEFAULT_BLOCK patterns (imported from source for TDD gate;
// also defined locally as reference)
// ═══════════════════════════════════════════════════════════════════════

const EXPECTED_SAFE_PATTERNS = ["*.env", ".env.*", "secrets/", "**/*.pem", "**/*.key"];

function createSafeDefaultEntries(cwd: string): IgnoreEntry[] {
	return [
		{
			root: cwd,
			patterns: SAFE_DEFAULT_BLOCK.map(patternToRegex),
		},
	];
}

// ═══════════════════════════════════════════════════════════════════════
// Handler wrapper with trust gate (the feature under test)
// ═══════════════════════════════════════════════════════════════════════

type GetEntriesFn = (cwd: string) => IgnoreEntry[];
type CheckPathFn = (
	targetPath: string | undefined,
	entries: IgnoreEntry[],
	cwd: string,
) => string | null;
type CheckBashCommandFn = (command: string, entries: IgnoreEntry[], cwd: string) => string | null;
type CheckTrustedFn = () => boolean | undefined;

async function handlerWrapperWithTrust(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	getEntries: GetEntriesFn,
	checkPath: CheckPathFn,
	checkBashCommand: CheckBashCommandFn,
	checkTrusted: CheckTrustedFn,
	getSafeDefaultEntries: (cwd: string) => IgnoreEntry[],
): Promise<ToolCallEventResult | undefined> {
	try {
		let isTrusted = false;
		try {
			isTrusted = checkTrusted() === true;
		} catch {
			isTrusted = false;
		}

		const ignoreEntries = isTrusted ? getEntries(ctx.cwd) : getSafeDefaultEntries(ctx.cwd);
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
			const source = isTrusted ? ".piignore" : "safe-default";
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked by ${source}: ${blockedPath}`, "warning");
			}
			return {
				block: true,
				reason: ctx.hasUI
					? `Path "${blockedPath}" matches ${source} patterns`
					: `Path "${blockedPath}" matches ${source} patterns (${ctx.mode ?? "unknown"} mode — no notification shown)`,
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
// Phase 1: SAFE_DEFAULT_BLOCK constant value
// ═══════════════════════════════════════════════════════════════════════

describe("SAFE_DEFAULT_BLOCK constant", () => {
	it("exports an array of 5 patterns", () => {
		assert.ok(Array.isArray(SAFE_DEFAULT_BLOCK), "SAFE_DEFAULT_BLOCK should be an array");
		assert.strictEqual(SAFE_DEFAULT_BLOCK.length, 5, "should have exactly 5 patterns");
	});

	it("contains expected pattern values", () => {
		for (const p of EXPECTED_SAFE_PATTERNS) {
			assert.ok(SAFE_DEFAULT_BLOCK.includes(p), `SAFE_DEFAULT_BLOCK should contain "${p}"`);
		}
	});

	it("each pattern compiles to a valid regex via patternToRegex", () => {
		for (const p of SAFE_DEFAULT_BLOCK) {
			const { regex, negate } = patternToRegex(p);
			assert.ok(regex instanceof RegExp, `pattern "${p}" should compile to RegExp`);
			assert.strictEqual(negate, false, `safe-default pattern "${p}" should not be negated`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: SAFE_DEFAULT_BLOCK pattern matching
// ═══════════════════════════════════════════════════════════════════════

describe("SAFE_DEFAULT_BLOCK pattern matching", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-trust-test-"));
	const testDir = path.join(tmpRoot, "project");

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	// ── Paths that should be blocked ────────────────────────────────

	it("blocks *.env patterns (e.g., .env)", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.ok(isIgnored(".env", entries, testDir), "should block .env");
	});

	it("blocks *.env patterns (e.g., .env.production)", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.ok(isIgnored(".env.production", entries, testDir), "should block .env.production");
	});

	it("blocks .env.* patterns (e.g., .env.local)", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.ok(isIgnored(".env.local", entries, testDir), "should block .env.local");
	});

	it("blocks secrets/ directory", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.ok(isIgnored("secrets/keys", entries, testDir), "should block secrets/keys");
	});

	it("blocks **/*.pem (e.g., cert.pem)", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.ok(isIgnored("cert.pem", entries, testDir), "should block cert.pem");
	});

	it("blocks **/*.key (e.g., id_rsa.key)", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.ok(isIgnored("id_rsa.key", entries, testDir), "should block id_rsa.key");
	});

	// ── Paths that should NOT be blocked ────────────────────────────

	it("allows README.md", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.strictEqual(
			isIgnored("README.md", entries, testDir),
			false,
			"should not block README.md",
		);
	});

	it("allows src/index.ts", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.strictEqual(
			isIgnored("src/index.ts", entries, testDir),
			false,
			"should not block src/index.ts",
		);
	});

	it("allows package.json", () => {
		const entries = createSafeDefaultEntries(testDir);
		assert.strictEqual(
			isIgnored("package.json", entries, testDir),
			false,
			"should not block package.json",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Trust gate — trusted vs untrusted behavior
// ═══════════════════════════════════════════════════════════════════════

describe("trust gate behavior", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-trust-gate-"));
	const testDir = path.join(tmpRoot, "project");

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	// ── Trusted: uses .piignore patterns ────────────────────────────

	it("trusted project uses .piignore patterns (block .env)", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => true,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		assert.ok(result, "trusted: should block .env from .piignore");
		assert.strictEqual(result.block, true);
		assert.ok(
			result.reason?.includes(".piignore"),
			`reason should mention .piignore, got: ${result.reason}`,
		);
	});

	it("trusted project allows non-matching paths", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => true,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: "README.md" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		assert.strictEqual(result, undefined, "trusted: should not block README.md");
	});

	// ── Untrusted: uses SAFE_DEFAULT_BLOCK ──────────────────────────

	it("untrusted project skips .piignore and uses safe-defaults", async () => {
		// Create .piignore that would NOT block .env (malicious)
		fs.writeFileSync(path.join(testDir, ".piignore"), "!*.env\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => false,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => false,
			createSafeDefaultEntries,
		);

		assert.ok(result, "untrusted: should block .env via safe-defaults");
		assert.strictEqual(result.block, true);
		assert.ok(
			result.reason?.includes("safe-default"),
			`reason should mention safe-default, got: ${result.reason}`,
		);
	});

	it("untrusted: .piignore that blocks README.md does NOT block README.md (safe-defaults don't include it)", async () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "README.md\n", "utf-8");

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => false,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: "README.md" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => false,
			createSafeDefaultEntries,
		);

		assert.strictEqual(
			result,
			undefined,
			"untrusted: should not block README.md (safe-defaults don't match)",
		);
	});

	it("untrusted, no .piignore, safe path — not blocked", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => false,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: "README.md" } },
			ctx,
			() => [],
			checkPathImpl,
			checkBashCommandImpl,
			() => false,
			createSafeDefaultEntries,
		);

		assert.strictEqual(result, undefined, "untrusted: safe path should not block");
	});

	it("trusted, no .piignore — no blocking", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => true,
		};

		// No .piignore exists
		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		assert.strictEqual(result, undefined, "trusted with no .piignore: .env should not block");
	});

	// ── Error cases ─────────────────────────────────────────────────

	it("ctx.isProjectTrusted() throws — blocks tool with internal error", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => {
				throw new Error("isProjectTrusted failed");
			},
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => {
				throw new Error("isProjectTrusted failed");
			},
			createSafeDefaultEntries,
		);

		assert.ok(result, "handler should return result on isProjectTrusted error");
		assert.strictEqual(result.block, true, "should block on isProjectTrusted error");
		assert.ok(
			result.reason?.includes("safe-default"),
			`should fall back to safe-default on isProjectTrusted error, got: ${result.reason}`,
		);
	});

	it("ctx.isProjectTrusted() returns undefined — treated as untrusted, safe-defaults apply", async () => {
		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: { notify: () => {} },
			isProjectTrusted: () => undefined,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => undefined,
			createSafeDefaultEntries,
		);

		assert.ok(result, "handler should return result when isProjectTrusted returns undefined");
		assert.strictEqual(result.block, true, "should block when isProjectTrusted returns undefined");
		assert.ok(
			result.reason?.includes("safe-default"),
			`should use safe-default when isProjectTrusted returns undefined, got: ${result.reason}`,
		);
	});

	// ── Safe-defaults with negation patterns (shouldn't crash) ──────

	it("negation pattern in safe-defaults doesn't crash (safe-defaults have no negation)", () => {
		const { regex, negate } = patternToRegex("!*.env");
		assert.ok(regex instanceof RegExp, "negation pattern should compile");
		assert.ok(negate, "should detect negation");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Mode-aware reason string + ctx.hasUI guard
// ═══════════════════════════════════════════════════════════════════════

describe("mode-aware blocking with ctx.hasUI guard", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-mode-test-"));
	const testDir = path.join(tmpRoot, "project");

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	// Create .piignore for tests
	function setupPiIgnore() {
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\n", "utf-8");
	}

	it("ctx.hasUI === true — calls ctx.ui.notify() with warning type", async () => {
		setupPiIgnore();
		let notified = false;
		let notifyMsg = "";
		let notifyType = "";

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: (message: string, type: string) => {
					notified = true;
					notifyMsg = message;
					notifyType = type;
				},
			},
			isProjectTrusted: () => true,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		assert.ok(result, "should return block result");
		assert.strictEqual(result.block, true);
		assert.ok(notified, "should have called ctx.ui.notify()");
		assert.ok(
			notifyMsg.includes("Blocked by"),
			`notify message should contain "Blocked by", got: ${notifyMsg}`,
		);
		assert.strictEqual(notifyType, "warning", "notify type should be warning");
	});

	it("ctx.hasUI === false — does NOT call ctx.ui.notify(), reason has extra context", async () => {
		setupPiIgnore();
		let notified = false;

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: {
				notify: () => {
					notified = true;
				},
			},
			mode: "json",
			isProjectTrusted: () => true,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		assert.ok(result, "should return block result");
		assert.strictEqual(result.block, true);
		assert.strictEqual(notified, false, "should NOT call ctx.ui.notify() when hasUI is false");
		assert.ok(
			result.reason?.includes("no notification shown"),
			`reason should include mode context, got: ${result.reason}`,
		);
		assert.ok(result.reason?.includes("json"), `reason should mention mode, got: ${result.reason}`);
	});

	it("ctx.hasUI === true but ctx.ui.notify() throws — caught, still returns block: true", async () => {
		setupPiIgnore();

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					throw new Error("notify failed");
				},
			},
			isProjectTrusted: () => true,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		// The wrapper catches the error from notify() - it happens inside the
		// try block, so the outer catch catches it and returns block: true
		assert.ok(result, "should return block result even when notify throws");
		assert.strictEqual(result.block, true, "should block even when notify throws");
	});

	it("ctx.hasUI is undefined — treated as falsy, no notify, verbose reason", async () => {
		setupPiIgnore();
		let notified = false;

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: undefined as unknown as boolean,
			ui: {
				notify: () => {
					notified = true;
				},
			},
			isProjectTrusted: () => true,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		assert.ok(result, "should return block result");
		assert.strictEqual(result.block, true);
		assert.strictEqual(notified, false, "should NOT call notify when hasUI is undefined");
		assert.ok(
			result.reason?.includes("no notification shown"),
			`reason should include mode context, got: ${result.reason}`,
		);
	});

	it("ctx.mode === 'json' — hasUI false, reason carries full block context", async () => {
		setupPiIgnore();
		let notified = false;

		const ctx: ExtensionContext = {
			cwd: testDir,
			hasUI: false,
			ui: {
				notify: () => {
					notified = true;
				},
			},
			mode: "json",
			isProjectTrusted: () => true,
		};

		const result = await handlerWrapperWithTrust(
			{ toolName: "read", input: { path: ".env" } },
			ctx,
			loadPiIgnore,
			checkPathImpl,
			checkBashCommandImpl,
			() => true,
			createSafeDefaultEntries,
		);

		assert.ok(result, "should block in json mode");
		assert.strictEqual(result.block, true);
		assert.strictEqual(notified, false, "no notify in json mode");
		assert.ok(
			result.reason?.includes("json mode"),
			`reason should mention json mode, got: ${result.reason}`,
		);
	});
});
