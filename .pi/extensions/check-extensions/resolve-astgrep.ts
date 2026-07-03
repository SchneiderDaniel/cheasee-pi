/**
 * resolve-astgrep — ESM-safe ast-grep binary path resolver
 *
 * Replaces the CJS require() version that was in index.ts.
 * Uses fs.access with F_OK (not X_OK) for portability.
 */

import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the path to ast-grep binary.
 * Checks common locations, falls back to "ast-grep" (PATH).
 *
 * ESM-safe: uses fs.access instead of CJS require().
 */
export function resolveAstGrepPath(): string {
	const home = process.env.HOME || homedir();
	const candidates = [
		join(home, ".npm-global", "bin", "ast-grep"),
		"/usr/local/bin/ast-grep",
		"/usr/bin/ast-grep",
	];
	for (const c of candidates) {
		try {
			fs.accessSync(c, fs.constants.F_OK);
			return c;
		} catch {
			/* try next */
		}
	}
	return "ast-grep"; // fallback — hope it's on PATH
}
