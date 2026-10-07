/**
 * Test-registration / discovery helper (issue #1859).
 *
 * `package.json#scripts.test` is the single source of truth for which test
 * files run: it holds quoted globs. This module parses those globs and expands
 * them, so wiring guards can ask "is this file registered?" without each
 * re-implementing glob semantics or pinning a hand-maintained roster.
 *
 * The pure core (`parseTokens`, `isGlobBased`, `expandGlobs`) is exported
 * separately so negative paths are testable without touching package.json; the
 * remaining exports are thin filesystem-backed wrappers.
 */

import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PACKAGE_JSON = resolve(REPO_ROOT, "package.json");

/** Strip a single layer of matching surrounding single/double quotes. */
function stripQuotes(token: string): string {
	return token.replace(/^(['"])(.*)\1$/, "$2");
}

/**
 * Pure: the glob tokens of a test script. Non-glob tokens (the runner command,
 * flags) are dropped; surrounding shell quotes are stripped.
 */
export function parseTokens(script: string): string[] {
	if (typeof script !== "string" || script.trim() === "") return [];
	return script
		.split(/\s+/)
		.filter(Boolean)
		.map(stripQuotes)
		.filter((token) => token.includes("*"));
}

/** Pure: does the script register test files via at least one glob? */
export function isGlobBased(script: string): boolean {
	return parseTokens(script).length > 0;
}

/**
 * Pure: expand globs relative to `cwd`. Missing patterns yield no matches and
 * never throw (a stale pattern must fail loud in the registry tests, not here).
 */
export function expandGlobs(globs: string[], cwd: string): string[] {
	const out: string[] = [];
	for (const pattern of globs) {
		if (typeof pattern !== "string" || pattern === "") continue;
		for (const match of globSync(pattern, { cwd })) out.push(match);
	}
	return out;
}

/** The raw `scripts.test` value from the repo's package.json ("" when absent). */
export function testScript(): string {
	const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as {
		scripts?: Record<string, string>;
	};
	return String(pkg.scripts?.test ?? "");
}

/** The glob tokens of the real test script. */
export function testGlobs(): string[] {
	return parseTokens(testScript());
}

let cachedFiles: string[] | undefined;

/** Every test file the globs register, relative to the repo root. */
export function discoverTestFiles(): string[] {
	cachedFiles ??= expandGlobs(testGlobs(), REPO_ROOT);
	return cachedFiles;
}

/** Is `relPath` (relative to the repo root) registered by the test globs? */
export function isRegistered(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, "/");
	return discoverTestFiles().includes(normalized);
}
