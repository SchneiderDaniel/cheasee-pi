// Shared fixture-repo builder for the CLI subprocess tests: a throwaway repo
// with its own `.pi/settings.json`, npm test glob, test files, faux-model
// preload, and a fake `gh` shim on PATH.
//
// Not a `*.test.mts`, so the runner never executes it as a suite.

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const TEST_DIR = dirname(import.meta.dirname);
export const SKILL_DIR = dirname(TEST_DIR);
export const REPO_ROOT = dirname(dirname(dirname(SKILL_DIR)));
export const SCRIPT = join(SKILL_DIR, "scripts", "test-validator.mts");
export const PRELOAD_SOURCE = join(TEST_DIR, "fixtures", "faux-preload.fixture.txt");

export const TWO_TESTS = [
	'import { describe, it } from "node:test";',
	'import assert from "node:assert/strict";',
	'describe("suite", () => {',
	'\tit("keeps the total", () => {',
	"\t\tassert.equal(add(1, 1), 2);",
	"\t});",
	'\tit("rejects negatives", () => {',
	"\t\tassert.equal(add(-1, 1), 0);",
	"\t});",
	"});",
	"",
	"function add(a: number, b: number): number {",
	"\treturn a + b;",
	"}",
].join("\n");

export const GH_SHIM = `#!/usr/bin/env bash
set -u
{ echo "CALL"; for a in "$@"; do echo "ARG:$a"; done; } >> "$GH_LOG"
cmd="$1 $2"
if [ "$cmd" = "auth status" ]; then
  if [ "\${GH_FAIL_AUTH:-0}" = "1" ]; then echo "not logged in to any GitHub hosts" >&2; exit 1; fi
  echo "Logged in to github.com as test"
  exit 0
fi
if [ "$cmd" = "issue create" ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--body-file" ]; then cp "$a" "$GH_LOG.body"; fi
    prev="$a"
  done
  if [ "\${GH_FAIL_CREATE:-0}" = "1" ]; then echo "HTTP 422: Validation Failed" >&2; exit 1; fi
  echo "https://github.com/o/r/issues/42"
  exit 0
fi
if [ "$cmd" = "issue list" ]; then
  echo "[]"
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 9
`;

export interface FixtureRepo {
	readonly dir: string;
	readonly ghLog: string;
}

export interface RepoOptions {
	readonly tests?: string;
	readonly settings?: unknown | null;
	readonly packageJson?: unknown;
	readonly config?: unknown;
	/** extra files by relative path */
	readonly files?: Record<string, string>;
}

export const DEFAULT_CONFIG = {
	provider: "openai",
	model: "gpt-4",
	concurrency: 1,
	badConfidenceThreshold: 0.8,
	maxAttempts: 1,
	haltAfterConsecutiveFailures: 2,
};

export function makeRepo(options: RepoOptions = {}): FixtureRepo {
	const dir = mkdtempSync(join(tmpdir(), "test-validator-cli-"));
	const write = (relative: string, content: string): void => {
		const path = join(dir, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	};

	// Let the copied preload resolve `@earendil-works/pi-ai` from this repo.
	symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");

	if (options.settings !== null) {
		write(".pi/settings.json", JSON.stringify(options.settings ?? { supervisor: { repo: "o/r" } }));
	}
	write(
		"package.json",
		JSON.stringify(
			options.packageJson ?? {
				name: "fixture",
				scripts: { test: "node --experimental-strip-types --test 'src/*.test.mts'" },
			},
		),
	);
	write("src/a.test.mts", options.tests ?? TWO_TESTS);
	write("config.json", JSON.stringify(options.config ?? DEFAULT_CONFIG));
	copyFileSync(PRELOAD_SOURCE, join(dir, "preload.mts"));
	write("bin/gh", GH_SHIM);
	chmodSync(join(dir, "bin", "gh"), 0o755);
	for (const [relative, content] of Object.entries(options.files ?? {})) write(relative, content);

	return { dir, ghLog: join(dir, "gh.log") };
}

export interface CliResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export function runCli(
	repo: FixtureRepo,
	args: readonly string[] = [],
	env: Record<string, string | undefined> = {},
): CliResult {
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") childEnv[key] = value;
	}
	childEnv.PATH = `${join(repo.dir, "bin")}:${childEnv.PATH ?? ""}`;
	childEnv.GH_LOG = repo.ghLog;
	childEnv.OPENAI_API_KEY = "sk-test-secret";
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}

	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--import", join(repo.dir, "preload.mts"), SCRIPT, ...args],
		{ cwd: repo.dir, env: childEnv, encoding: "utf8" },
	);
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/** `gh` invocations recorded by the shim, one array of argv per call. */
export function ghCalls(repo: FixtureRepo): string[][] {
	const path = repo.ghLog;
	if (!existsSync(path)) return [];
	const calls: string[][] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line === "CALL") calls.push([]);
		else if (line.startsWith("ARG:") && calls.length > 0) calls.at(-1)!.push(line.slice(4));
	}
	return calls;
}

export async function withRepo(
	options: RepoOptions,
	fn: (repo: FixtureRepo) => Promise<void>,
): Promise<void> {
	const repo = makeRepo(options);
	try {
		await fn(repo);
	} finally {
		rmSync(repo.dir, { recursive: true, force: true });
	}
}

export const checkpointPath = (repo: FixtureRepo): string =>
	join(repo.dir, "ignore", "test-validator", "checkpoint.jsonl");
export const reportPath = (repo: FixtureRepo): string =>
	join(repo.dir, "ignore", "test-validator", "report.json");
