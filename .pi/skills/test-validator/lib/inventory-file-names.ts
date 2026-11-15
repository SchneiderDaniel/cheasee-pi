// Adapter: naming rules for test files, plus the runner globs that supplement them.
//
// A file counts because the runner runs it (its own globs) or because its name
// says so per language convention.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DiscoveryError } from "./inventory-parse.ts";

/** Directories that never hold the project's own tests. */
export const SKIPPED_DIRS = new Set([
	".git",
	"node_modules",
	"ignore",
	"dist",
	"build",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
	".mypy_cache",
	".pytest_cache",
	"coverage",
	".next",
	".turbo",
	".cache",
]);

const NODE_TEST_NAME = /\.test\.[cm]?[jt]sx?$/;
const GO_TEST_NAME = /_test\.go$/;
const PYTHON_TEST_NAME = /^(test_.*\.py|.*_test\.py|.*\.test\.py)$/;
const SHELL_TEST_NAME = /\.test\.(sh|bash)$/;

export function isGoModule(cwd: string): boolean {
	return existsSync(join(cwd, "go.mod"));
}

export function looksLikeTestFile(name: string, goModule: boolean): boolean {
	if (NODE_TEST_NAME.test(name)) return true;
	if (goModule && GO_TEST_NAME.test(name)) return true;
	if (PYTHON_TEST_NAME.test(name)) return true;
	return SHELL_TEST_NAME.test(name);
}

/** Test-file globs `package.json` `scripts.test` runs, or none when it declares none. */
export function runnerGlobsFrom(cwd: string): string[] {
	const packagePath = join(cwd, "package.json");
	if (!existsSync(packagePath)) return [];
	let scripts: unknown;
	try {
		scripts = (JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: { test?: unknown } })
			.scripts;
	} catch (err) {
		throw new DiscoveryError(
			packagePath,
			null,
			`cannot parse package.json: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const test = (scripts as { test?: unknown } | undefined)?.test;
	if (typeof test !== "string") return [];
	return [...test.matchAll(/'([^']+)'/g)]
		.map((match) => match[1])
		.filter((pattern) => /[*?]/.test(pattern) || /\.[cm]?[jt]s$/.test(pattern));
}
