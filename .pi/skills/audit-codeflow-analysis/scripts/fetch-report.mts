#!/usr/bin/env node
/**
 * Fetch the CodeFlow analysis report into the workspace (CLI adapter).
 *
 * Thin delivery adapter over `lib/fetch-report.ts`: parse argv, run the fetch
 * use-case once, print the JSON result, map the outcome to an exit code. All
 * transport, write hardening and cache behavior lives in the use-case.
 *
 * Usage:
 *   node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/fetch-report.mts [--refresh]
 *
 * stdout is pure JSON `{path, jsonPath, bytes, analyzedAt, warnings}`; stderr
 * carries messages. Exit codes:
 *   0  report fetched and written
 *   2  no report and no headless run route (old shim) or bad usage — run an analysis in the CodeFlow UI
 *   1  transport, run or write failure
 */

import { pathToFileURL } from "node:url";
import { fetchAndStoreReport } from "../lib/fetch-report.ts";

export interface CliIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

const defaultIo: CliIo = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

/**
 * Run the fetch CLI and return its exit code. Never calls `process.exit`, so
 * tests can import and drive it in-process through the `lib/fetch-report.ts`
 * seams; the entrypoint below maps the returned code to `process.exitCode`.
 */
export async function runFetchReportCli(
	argv: string[],
	io: CliIo = defaultIo,
	cwd: string = process.cwd(),
): Promise<number> {
	let refresh = false;
	for (const arg of argv) {
		if (arg === "--refresh") {
			refresh = true;
		} else {
			io.stderr(`unknown argument: ${arg}\nusage: fetch-report.mts [--refresh]\n`);
			return 2;
		}
	}

	let outcome;
	try {
		outcome = await fetchAndStoreReport({ cwd, refresh });
	} catch (err) {
		io.stderr(
			`CodeFlow report fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}

	if (!outcome.ok) {
		io.stderr(`${outcome.message}\n`);
		return outcome.status === 404 ? 2 : 1;
	}

	io.stdout(`${JSON.stringify(outcome.result)}\n`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await runFetchReportCli(process.argv.slice(2));
}
