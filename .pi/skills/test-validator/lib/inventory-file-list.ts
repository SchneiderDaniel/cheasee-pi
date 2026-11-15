// Adapter: the directory walk behind `inventory-repository.ts`.
//
// Union of two sources: every file whose name matches a language convention, and
// every file the runner's own globs name. Dependencies, caches, build output, and
// nested checkouts are skipped, so a vendored tree is never audited as this
// project's tests.

import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, sep } from "node:path";

import { languageOf } from "./inventory-file.ts";
import { SKIPPED_DIRS, isGoModule, looksLikeTestFile } from "./inventory-file-names.ts";
import { DiscoveryError } from "./inventory-parse.ts";
import { declaresRustTest } from "./inventory-rust.ts";

function isFile(cwd: string, relativePath: string): boolean {
	try {
		return statSync(join(cwd, relativePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Rust has no test-file naming convention, so its file set is decided by content:
 * only a `.rs` file that declares a test function is a test file. A Rust source
 * file that declares none is not a test file and never contributes a definition.
 */
function isRustTestFile(dir: string, name: string): boolean {
	try {
		return declaresRustTest(readFileSync(join(dir, name), "utf8"));
	} catch (err) {
		throw new DiscoveryError(
			join(dir, name),
			null,
			`cannot read Rust source: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Every test file under `cwd`, repository-relative, POSIX separators, sorted. */
export function listTestFiles(cwd: string, runnerGlobs: readonly string[] = []): string[] {
	const goModule = isGoModule(cwd);
	const found = new Set<string>();

	const walk = (dir: string, prefix: string): void => {
		// A nested checkout is a vendored repository, not this project's suite.
		if (prefix !== "" && existsSync(join(dir, ".git"))) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			throw new DiscoveryError(
				dir,
				null,
				`cannot list directory: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		for (const entry of entries) {
			// Symlinks are not followed: a linked venv or checkout can loop or
			// escape the repository.
			if (entry.isSymbolicLink()) continue;
			const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
				walk(join(dir, entry.name), relativePath);
			if (!entry.isFile()) continue;
			if (!looksLikeTestFile(entry.name, goModule)) continue;
			if (entry.name.endsWith(".rs") && !isRustTestFile(dir, entry.name)) continue;
			found.add(relativePath);
		}
	};
	walk(cwd, "");

	for (const pattern of runnerGlobs) {
		for (const match of globSync(pattern, { cwd })) {
			const relativePath = match.split(sep).join("/").replace(/^\.\//, "");
			if (relativePath.split("/").some((segment) => SKIPPED_DIRS.has(segment))) continue;
			if (!isFile(cwd, relativePath)) continue;
			// Fail closed: a file the runner executes that this audit cannot
			// enumerate would make the completion claim false.
			if (languageOf(relativePath) === null) {
				throw new DiscoveryError(
					relativePath,
					null,
					"cannot enumerate tests: unsupported test file kind the runner executes",
				);
			}
			found.add(relativePath);
		}
	}

	return [...found].sort();
}
