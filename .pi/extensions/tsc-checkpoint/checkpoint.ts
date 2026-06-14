/**
 * tsc-checkpoint — One-shot tsc check (runTscCheckpoint)
 *
 * Uses ts.createProgram() instead of watch mode — no file watchers,
 * no incremental state, no lingering callbacks.
 * Imported by supervisor pipeline via dynamic import("../../tsc-checkpoint").
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import ts from "typescript";
import type { TscDiagnostic, TscCheckpointResult } from "./types.ts";
import { diagnosticToTscDiagnostic } from "./adapter.ts";

/**
 * Runs a one-shot tsc check using the TypeScript compiler API.
 * Uses ts.createProgram() instead of watch mode — no file watchers,
 * no incremental state, no lingering callbacks.
 */
export async function runTscCheckpoint(worktreePath: string): Promise<TscCheckpointResult> {
	const configPath = resolve(worktreePath, "tsconfig.json");

	if (!existsSync(configPath)) {
		return { diagnostics: [], hasErrors: false };
	}

	// Parse tsconfig — fallback gracefully on parse failure
	const parsedConfig = ts.getParsedCommandLineOfConfigFile(
		configPath,
		{ noEmit: true },
		ts.sys as unknown as ts.ParseConfigFileHost,
	);

	if (!parsedConfig) {
		return { diagnostics: [], hasErrors: false };
	}

	const configDir = dirname(configPath);
	const program = ts.createProgram({
		rootNames: parsedConfig.fileNames,
		options: parsedConfig.options,
	});

	const allDiagnostics = ts.getPreEmitDiagnostics(program);
	const hasErrors = allDiagnostics.some((d) => d.category === ts.DiagnosticCategory.Error);

	const mapped: TscDiagnostic[] = hasErrors
		? allDiagnostics
				.filter((d) => d.category === ts.DiagnosticCategory.Error)
				.map((d) => diagnosticToTscDiagnostic(d, configDir))
				.filter((d): d is TscDiagnostic => d !== undefined)
		: [];

	return { diagnostics: mapped, hasErrors };
}
