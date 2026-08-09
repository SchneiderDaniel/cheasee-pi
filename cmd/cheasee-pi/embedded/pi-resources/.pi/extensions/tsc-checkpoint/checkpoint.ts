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
 * Type for the config parser function — matches ts.getParsedCommandLineOfConfigFile.
 * Injected as optional parameter for testability (the ts namespace has
 * non-configurable getters, preventing monkey-patching).
 */
type ParseConfigFileFn = (
	configFileName: string,
	optionsToExtend: ts.CompilerOptions,
	host: ts.ParseConfigFileHost,
) => ts.ParsedCommandLine | undefined;

/**
 * Runs a one-shot tsc check using the TypeScript compiler API.
 * Uses ts.createProgram() instead of watch mode — no file watchers,
 * no incremental state, no lingering callbacks.
 *
 * @param worktreePath - Path to the project root (contains tsconfig.json)
 * @param getParsedCommandLineOfConfigFile - Optional injectable config parser (for testing)
 */
export async function runTscCheckpoint(
	worktreePath: string,
	getParsedCommandLineOfConfigFile?: ParseConfigFileFn,
): Promise<TscCheckpointResult> {
	const configPath = resolve(worktreePath, "tsconfig.json");

	if (!existsSync(configPath)) {
		return { diagnostics: [], hasErrors: false };
	}

	// Parse tsconfig — use injected parser or default
	const parseConfig = getParsedCommandLineOfConfigFile ?? ts.getParsedCommandLineOfConfigFile;
	const parsedConfig = parseConfig(
		configPath,
		{ noEmit: true },
		ts.sys as unknown as ts.ParseConfigFileHost,
	);

	// Defensive: getParsedCommandLineOfConfigFile returned undefined
	// (unreachable in TS 6+ but must not signal success if it occurs)
	if (!parsedConfig) {
		return {
			diagnostics: [
				{
					file: "tsconfig.json",
					line: 0,
					column: 0,
					severity: "Error" as const,
					message:
						"Failed to parse tsconfig.json — getParsedCommandLineOfConfigFile returned undefined",
					filePath: configPath,
				},
			],
			hasErrors: true,
		};
	}

	// Check for config parse errors (malformed JSON, missing extends, etc.)
	// before creating a program — these are preconditions that prevent
	// reliable type-checking.
	const configErrors = parsedConfig.errors.filter(
		(d) => d.category === ts.DiagnosticCategory.Error,
	);
	if (configErrors.length > 0) {
		const mapped = configErrors.map((d) => toTscDiagnostic(d, configPath));
		return { diagnostics: mapped, hasErrors: true };
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

// ═══════════════════════════════════════════════════════════════════════
// Config Diagnostic Helper
// ═══════════════════════════════════════════════════════════════════════

/**
 * Map a ts.Diagnostic from config parsing to TscDiagnostic.
 *
 * File-based diagnostics delegate to {@link diagnosticToTscDiagnostic}.
 * Fileless diagnostics (common for config parse errors like "No inputs found",
 * malformed JSON, circular extends) get a synthetic file pointing to tsconfig.json
 * so they are not silently dropped by the adapter.
 */
export function toTscDiagnostic(diagnostic: ts.Diagnostic, configPath: string): TscDiagnostic {
	const file = diagnostic.file;
	if (file) {
		const configDir = dirname(configPath);
		const result = diagnosticToTscDiagnostic(diagnostic, configDir);
		if (result) return result;
	}

	// Fileless or delegation failed — synthesize diagnostic pointing to tsconfig.json
	const message =
		typeof diagnostic.messageText === "string"
			? diagnostic.messageText
			: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

	return {
		file: "tsconfig.json",
		line: 0,
		column: 0,
		severity: "Error",
		message,
		code: `TS${diagnostic.code}`,
		filePath: configPath,
	};
}
