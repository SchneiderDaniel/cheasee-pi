/**
 * Shared path-containment policy (CWE-22).
 *
 * Single source of truth for the "does this path stay inside that root?"
 * question. Extracted from the inline checks in ripgrep-search and
 * worktree-sandbox so a tool adapter can reuse the exact same rule instead of
 * growing a third spelling of it.
 *
 * Rule: normalize BOTH operands with `path.resolve` (collapsing `..`, `//`,
 * trailing slashes) BEFORE the containment test — a raw string-prefix check on
 * unnormalized input can be bypassed (`<root>/../../etc`) and is the
 * check-before-normalize class behind Vite CVE-2023-34092. The test itself uses
 * `path.relative`, which is separator-agnostic and rejects `..`-equal,
 * `..`-prefixed, sibling-prefix (`/srv/proj-evil` vs `/srv/proj`) and
 * cross-drive results natively.
 */

import { isAbsolute, relative as relativePath, resolve as resolvePath, sep } from "node:path";

/**
 * True when `absolutePath` lexically resolves inside `baseDir`.
 * Pure — no filesystem access, so it is safe for not-yet-existing paths.
 */
export function isPathWithinBase(absolutePath: string, baseDir: string): boolean {
	const resolved = resolvePath(absolutePath);
	const base = resolvePath(baseDir);
	const rel = relativePath(base, resolved);
	if (rel === "") return true;
	if (isAbsolute(rel)) return false; // different drive / root (Windows)
	return rel !== ".." && !rel.startsWith(".." + sep);
}

/**
 * Resolve `directory` against `cwd` and fail closed when it escapes `cwd`.
 * Returns the canonical absolute directory; throws otherwise.
 *
 * The thrown message quotes the RAW (unresolved) `directory` so the caller can
 * see exactly what was rejected.
 */
export function resolveWithinRoot(cwd: string, directory: string): string {
	const resolvedDir = resolvePath(cwd, directory);
	if (!isPathWithinBase(resolvedDir, cwd)) {
		throw new Error(`Directory traversal detected: "${directory}" resolves outside project root.`);
	}
	return resolvedDir;
}
