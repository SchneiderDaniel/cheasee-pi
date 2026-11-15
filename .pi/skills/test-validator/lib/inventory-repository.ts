// Adapter: inventory every runnable test file in a repository.
//
// `inventory-file-list.ts` answers which files count; this module reads them and
// hands each to `inventory-file.ts`, which dispatches on language. Every listed
// file contributes at least one inventory entry, so the completion gate can never
// be satisfied by a suite that silently dropped out.
//
// Fail closed: an unenumerable file, or a repository with no test file at all,
// throws `DiscoveryError` instead of returning a partial inventory.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { discoverInFile, languageOf } from "./inventory-file.ts";
import { listTestFiles } from "./inventory-file-list.ts";
import { runnerGlobsFrom } from "./inventory-file-names.ts";
import { DiscoveryError } from "./inventory-parse.ts";
import { TEST_LANGUAGES } from "./types.ts";
import type { ExcludedDefinition, InventoryResult, TestDefinition, TestLanguage } from "./types.ts";

export { listTestFiles } from "./inventory-file-list.ts";
export { runnerGlobsFrom } from "./inventory-file-names.ts";

interface LanguageTally {
	readonly files: number;
	readonly tests: number;
	readonly excluded: number;
}

export interface RepositoryInventoryOptions {
	/** Repository root to scan. */
	readonly cwd: string;
	/** Extra globs from the runner config; omitted means "read package.json". */
	readonly runnerGlobs?: readonly string[];
	/** Judge at most this many definitions (pilot runs). */
	readonly limit?: number;
}

export interface RepositoryInventory {
	readonly inventory: InventoryResult;
	/** Source text by repository-relative path, used for slices and preamble context. */
	readonly sources: ReadonlyMap<string, string>;
	readonly files: readonly string[];
	readonly byLanguage: Readonly<Record<TestLanguage, LanguageTally>>;
	/** Definitions a pilot `limit` left out of this run. */
	readonly truncated: number;
}

function emptyTally(): Record<TestLanguage, LanguageTally> {
	const tallies = {} as Record<TestLanguage, LanguageTally>;
	for (const language of TEST_LANGUAGES) tallies[language] = { files: 0, tests: 0, excluded: 0 };
	return tallies;
}

function tallyOf(
	tally: LanguageTally,
	entry: { readonly tests: number; readonly excluded: number },
): LanguageTally {
	return {
		files: tally.files + 1,
		tests: tally.tests + entry.tests,
		excluded: tally.excluded + entry.excluded,
	};
}

/**
 * Inventory every runnable test in the repository.
 *
 * @throws DiscoveryError when a test file cannot be enumerated, or none exists
 */
export function discoverRepository(options: RepositoryInventoryOptions): RepositoryInventory {
	const { cwd } = options;
	const runnerGlobs = options.runnerGlobs ?? runnerGlobsFrom(cwd);
	const files = listTestFiles(cwd, runnerGlobs);
	if (files.length === 0) {
		throw new DiscoveryError(
			cwd,
			null,
			"no test files found; the audit only judges the tests this repository runs",
		);
	}

	const sources = new Map<string, string>();
	const tests: TestDefinition[] = [];
	const excluded: ExcludedDefinition[] = [];
	const byLanguage = emptyTally();

	for (const file of files) {
		const source = readFileSync(join(cwd, file), "utf8");
		sources.set(file, source);
		const result = discoverInFile(source, file);
		tests.push(...result.tests);
		excluded.push(...result.excluded);
		const language = languageOf(file);
		if (language === null) continue;
		byLanguage[language] = tallyOf(byLanguage[language], {
			tests: result.tests.length,
			excluded: result.excluded.length,
		});
	}

	const limit = options.limit;
	const truncated = limit === undefined ? 0 : Math.max(0, tests.length - Math.max(0, limit));
	return {
		inventory: { tests: limit === undefined ? tests : tests.slice(0, limit), excluded },
		sources,
		files,
		byLanguage,
		truncated,
	};
}
