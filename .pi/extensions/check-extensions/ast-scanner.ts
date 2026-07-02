/**
 * ast-scanner — AST-aware file scanner for pi API usage
 *
 * Uses ast-grep subprocess (via injected execFn) to find and classify
 * API usage patterns in TypeScript extension files.
 *
 * Replaces regex-based extension-scanner.ts with AST-precise matching.
 * Naturally excludes comments, string literals, and import statements
 * from runtime-call findings — eliminating false positives from #1, #5, #6.
 */

import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, basename } from "node:path";

/** Match context classification */
export type MatchContext =
	| "runtime-call"
	| "import-type"
	| "import-value"
	| "comment"
	| "string-literal"
	| "dead-code";

/** Finding from AST-based scanning */
export interface ASTFinding {
	extensionName: string;
	file: string;
	apiName: string;
	line: number;
	column: number;
	lineContent: string;
	matchContext: MatchContext;
	callArgs: string[];
	changelogVersion: string;
	isBreaking: boolean;
	category: string;
}

/** Result from AST scanning */
export interface ASTScanningResult {
	findings: ASTFinding[];
	skipCount: number;
}

/** Exec function type for ast-grep subprocess calls */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/**
 * Mapping from normalized API names to their ast-grep search patterns.
 * We use two broad patterns to cover all pi and ctx API calls.
 */
const PI_PATTERN = "pi.$METHOD($$$ARGS)";
const CTX_PATTERN = "ctx.$METHOD($$$ARGS)";

/** Known pi.* API names we search for */
const PI_APIS = new Set([
	"on",
	"registerCommand",
	"registerTool",
	"exec",
	"sendUserMessage",
	"registerFlag",
	"registerShortcut",
	"getFlag",
	"setActiveTools",
	"sendMessage",
	"appendEntry",
	"setSessionName",
]);

/** Known ctx.* API prefixes we search for */
const CTX_API_PREFIXES = ["ui", "sessionManager", "abort"];

/**
 * Classify a match from an ast-grep JSON result node.
 * Returns the API name (e.g. "pi.on", "ctx.ui") from the match.
 */
function classifyApiName(
	methodText: string,
	hasPiPrefix: boolean,
	hasCtxPrefix: boolean,
): string | null {
	if (hasPiPrefix) {
		if (PI_APIS.has(methodText)) return `pi.${methodText}`;
		// Check for ctx-like methods called on pi (unlikely but handle)
		return null;
	}
	if (hasCtxPrefix) {
		// For ctx patterns, methodText might be "ui.notify" or "sessionManager.get"
		// Check if it starts with a known ctx API prefix
		for (const prefix of CTX_API_PREFIXES) {
			if (methodText === prefix || methodText.startsWith(`${prefix}.`)) {
				return `ctx.${prefix}`;
			}
		}
		// For broader ctx.* matches, include any ctx method
		const dotIdx = methodText.indexOf(".");
		const baseMethod = dotIdx >= 0 ? methodText.slice(0, dotIdx) : methodText;
		return `ctx.${baseMethod}`;
	}
	return null;
}

/**
 * Map a pi.$METHOD or ctx.$METHOD match to the standardized API name
 * used by the rest of the pipeline.
 */
function mapToStandardApiName(apiName: string): string {
	// Direct mappings for known API names
	const standardMap: Record<string, string> = {
		"pi.on": "pi.on",
		"pi.registerCommand": "pi.registerCommand",
		"pi.registerTool": "pi.registerTool",
		"pi.exec": "pi.exec",
		"pi.sendUserMessage": "pi.sendUserMessage",
		"ctx.ui": "ctx.ui",
		"ctx.sessionManager": "ctx.sessionManager",
		"ctx.abort": "ctx.abort",
		"pi.registerFlag": "pi.registerFlag",
		"pi.registerShortcut": "pi.registerShortcut",
		"pi.getFlag": "pi.getFlag",
		"pi.setActiveTools": "pi.setActiveTools",
		"pi.sendMessage": "pi.sendMessage",
		"pi.appendEntry": "pi.appendEntry",
		"pi.setSessionName": "pi.setSessionName",
	};
	return standardMap[apiName] || apiName;
}

/**
 * Parse an ast-grep match from the multi-metavariable ARGS to extract
 * the first-string-argument value (e.g., event name, command name).
 */
function extractFirstArg(match: Record<string, unknown>): string[] {
	const args: string[] = [];
	const metaVars = match.metaVariables as Record<string, unknown> | undefined;
	if (!metaVars) return args;

	const multiArgs = metaVars.multi as Record<string, Array<{ text: string }>> | undefined;
	if (!multiArgs?.ARGS) return args;

	for (const arg of multiArgs.ARGS) {
		const text = arg.text.trim();
		if (text === ",") continue; // Skip separator commas
		args.push(text);
		// Only take first meaningful arg
		if (args.length >= 1) break;
	}

	return args;
}

/**
 * Build an ASTFinding from an ast-grep match and contextual metadata.
 *
 * Shared helper used by both pi.* and ctx.* processing blocks to eliminate
 * near-identical code duplication (previously ~27 lines × 2 locations).
 */
export function processAstGrepMatch(
	match: Record<string, unknown>,
	dirName: string,
	filePath: string,
	apiName: string,
): ASTFinding {
	const range = match.range as Record<string, unknown>;
	const start = range?.start as Record<string, number> | undefined;
	const lineNum = (start?.line ?? 0) + 1;
	const colNum = (start?.column ?? 0) + 1;
	const firstLine = ((match.text ?? "") as string).split("\n")[0] ?? "";
	const args = extractFirstArg(match);

	return {
		extensionName: dirName,
		file: filePath,
		apiName: mapToStandardApiName(apiName),
		line: lineNum,
		column: colNum,
		lineContent: firstLine.trim(),
		matchContext: "runtime-call",
		callArgs: args.map((a) => a.trim()), // Keep raw (quoted) args so downstream code can distinguish string literals from variable references
		changelogVersion: "",
		isBreaking: false,
		category: "",
	};
}

/**
 * Build an import-related ASTFinding with boilerplate fields filled in.
 * Eliminates ~10 lines × 4 occurrences of duplicate object literals.
 */
function emitImportFinding(
	extName: string,
	filePath: string,
	line: number,
	lineContent: string,
	matchContext: MatchContext,
	apiName: string,
): ASTFinding {
	return {
		extensionName: extName,
		file: filePath,
		apiName,
		line,
		column: 1,
		lineContent,
		matchContext,
		callArgs: [],
		changelogVersion: "",
		isBreaking: false,
		category: "",
	};
}

/**
 * Check if a default import name qualifies as a pi module reference.
 * Wraps the substring-match logic so it lives in one place instead of two.
 */
function isPiDefaultImport(name: string): boolean {
	return name === "pi" || name.toLowerCase().includes("pi");
}

/**
 * Run ast-grep for a pattern and parse JSON results.
 */
async function runAstGrep(
	execFn: ExecFn,
	astGrepPath: string,
	filePath: string,
	pattern: string,
	lang: string,
): Promise<Array<Record<string, unknown>>> {
	const result = await execFn(astGrepPath, [
		"run",
		"--pattern",
		pattern,
		"--lang",
		lang,
		"--json",
		filePath,
	]);

	if (result.code !== 0) {
		// ast-grep returns code 1 when no matches found
		if (result.stderr && !result.stdout) {
			return [];
		}
		// Some ast-grep versions return empty stdout on no match
		if (!result.stdout.trim()) {
			return [];
		}
	}

	try {
		return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
	} catch {
		return [];
	}
}

/**
 * Detect import statements from "pi" modules in file content.
 * Returns findings with matchContext "import-type" or "import-value".
 */
function findImportFindings(filePath: string, content: string, extName: string): ASTFinding[] {
	const findings: ASTFinding[] = [];
	const lines = content.split("\n");

	// Patterns for imports from pi-related modules
	const piModulePattern = /@earendil-works\/pi-coding-agent|^pi$/i;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();

		// Check for type import
		const typeImportMatch = trimmed.match(
			/^import\s+type\s+\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["']/,
		);
		if (typeImportMatch && piModulePattern.test(typeImportMatch[2]!)) {
			const importedNames = typeImportMatch[1]!.trim();
			// Emit finding for any non-empty type import from a pi module.
			// The import source being a pi module is sufficient — no need
			// to check the imported name content. This fixes false negatives
			// for names like ExtensionContext, ExtensionOptions, etc. that
			// don't contain "pi" or "extensionapi" as substrings.
			if (importedNames.length > 0) {
				findings.push(emitImportFinding(extName, filePath, i + 1, trimmed, "import-type", "pi.import-type"));
			}
			continue;
		}

		// Check for value import (not type import)
		const valueImportMatch = trimmed.match(/^import\s+\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["']/);
		if (valueImportMatch && piModulePattern.test(valueImportMatch[2]!)) {
			const importedNames = valueImportMatch[1]!;
			const trimmedNames = importedNames.split(",").map((name: string) => name.trim());
			for (const name of trimmedNames) {
				if (PI_APIS.has(name)) {
					findings.push(emitImportFinding(extName, filePath, i + 1, trimmed, "import-value", `pi.${name}`));
				}
			}
			continue;
		}

		// Check for mixed default + named imports (Pattern 4)
		// e.g. import pi, { ExtensionAPI } from "@earendil-works/pi-coding-agent"
		//      import * as pi, { ExtensionAPI, on } from "..."
		const mixedImportMatch = trimmed.match(
			/^import\s+(?:\*\s+as\s+)?(\w+)\s*,\s*\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["']/,
		);
		if (mixedImportMatch && piModulePattern.test(mixedImportMatch[3]!)) {
			const defaultName = mixedImportMatch[1]!;
			const namedList = mixedImportMatch[2]!.trim();
			if (isPiDefaultImport(defaultName)) {
				findings.push(emitImportFinding(extName, filePath, i + 1, trimmed, "import-value", "pi"));
			}
			const trimmedNames = namedList.split(",").map((name) => name.trim());
			for (const name of trimmedNames) {
				if (PI_APIS.has(name)) {
					findings.push(emitImportFinding(extName, filePath, i + 1, trimmed, "import-value", `pi.${name}`));
				}
			}
			continue;
		}

		// Check for default/namespace import from pi
		const defaultImportMatch = trimmed.match(
			/^import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+["']([^"']+)["']/,
		);
		if (defaultImportMatch && piModulePattern.test(defaultImportMatch[2]!)) {
			const importName = defaultImportMatch[1]!;
			if (isPiDefaultImport(importName)) {
				findings.push(emitImportFinding(extName, filePath, i + 1, trimmed, "import-value", "pi"));
			}
		}
	}

	return findings;
}

/**
 * Scan extension directories using AST analysis (ast-grep subprocess).
 *
 * @param extensionsDir - Path to .pi/extensions/
 * @param apiNames - API names to search for (e.g. "pi.on", "pi.exec", "ctx.ui")
 * @param execFn - Exec function (e.g., pi.exec or child_process.execFile)
 * @param astGrepPath - Path to ast-grep binary
 * @returns ASTScanningResult with classified findings
 */
export async function scanExtensionsAST(
	extensionsDir: string,
	apiNames: string[],
	execFn: ExecFn,
	astGrepPath: string,
): Promise<ASTScanningResult> {
	const findings: ASTFinding[] = [];
	let skipCount = 0;

	if (!existsSync(extensionsDir)) {
		return { findings, skipCount };
	}

	// Determine which pi methods and ctx methods to search for based on apiNames
	const targetPiMethods = new Set<string>();
	const targetCtxMethods = new Set<string>();

	const apiToMethod: Record<string, string> = {
		"pi.on": "on",
		"pi.registerCommand": "registerCommand",
		"pi.registerTool": "registerTool",
		"pi.exec": "exec",
		"pi.sendUserMessage": "sendUserMessage",
		"pi.registerFlag": "registerFlag",
		"pi.registerShortcut": "registerShortcut",
		"pi.getFlag": "getFlag",
		"pi.setActiveTools": "setActiveTools",
		"pi.sendMessage": "sendMessage",
		"pi.appendEntry": "appendEntry",
		"pi.setSessionName": "setSessionName",
	};

	const ctxPrefixes = ["ui", "sessionManager", "abort"];

	for (const name of apiNames) {
		if (name.startsWith("pi.")) {
			const method = apiToMethod[name];
			if (method) targetPiMethods.add(method);
		} else if (name.startsWith("ctx.")) {
			const prefix = name.replace("ctx.", "");
			if (ctxPrefixes.includes(prefix)) targetCtxMethods.add(prefix);
		}
	}

	// If no specific patterns, search all
	if (targetPiMethods.size === 0 && targetCtxMethods.size === 0) {
		for (const m of Object.values(apiToMethod)) targetPiMethods.add(m);
		for (const p of ctxPrefixes) targetCtxMethods.add(p);
	}

	// Collect .ts files
	const tsFiles: Array<{ dirName: string; filePath: string }> = [];

	let entries: Dirent[];
	try {
		entries = readdirSync(extensionsDir, { withFileTypes: true });
	} catch {
		return { findings, skipCount };
	}
	const hasExtensionSubdirs = entries.some(
		(entry) => entry.isDirectory() && !entry.name.startsWith("."),
	);

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".")) continue;

		const extDir = join(extensionsDir, entry.name);
		let files: string[];
		try {
			files = readdirSync(extDir);
		} catch {
			skipCount++;
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".ts")) continue;
			tsFiles.push({
				dirName: entry.name,
				filePath: join(extDir, file),
			});
		}
	}

	// Also check top-level .ts files
	let rootFiles: string[];
	try {
		rootFiles = readdirSync(extensionsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("."));
	} catch {
		rootFiles = [];
	}
	const treatRootFilesAsSingleExtension = !hasExtensionSubdirs && rootFiles.includes("index.ts");
	for (const file of rootFiles) {
		tsFiles.push({
			dirName: treatRootFilesAsSingleExtension ? basename(extensionsDir) : basename(file, ".ts"),
			filePath: join(extensionsDir, file),
		});
	}

	// Scan each file with ast-grep
	for (const { dirName, filePath } of tsFiles) {
		// Read file content once for line-level operations and import detection
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			skipCount++;
			continue;
		}

		// Find pi.* method calls via ast-grep
		if (targetPiMethods.size > 0) {
			const piResults = await runAstGrep(execFn, astGrepPath, filePath, PI_PATTERN, "ts");
			for (const match of piResults) {
				const metaVars = match.metaVariables as Record<string, unknown> | undefined;
				const singleVars = metaVars?.single as Record<string, { text: string }> | undefined;
				const methodText = singleVars?.METHOD?.text ?? "";
				const apiName = classifyApiName(methodText, true, false);
				if (!apiName || !targetPiMethods.has(methodText)) continue;

				findings.push(processAstGrepMatch(match, dirName, filePath, apiName));
			}
		}

		// Find ctx.* method calls via ast-grep
		if (targetCtxMethods.size > 0) {
			const ctxResults = await runAstGrep(execFn, astGrepPath, filePath, CTX_PATTERN, "ts");
			for (const match of ctxResults) {
				const metaVars = match.metaVariables as Record<string, unknown> | undefined;
				const singleVars = metaVars?.single as Record<string, { text: string }> | undefined;
				const methodText = singleVars?.METHOD?.text ?? "";
				const apiName = classifyApiName(methodText, false, true);
				if (!apiName) continue;

				// Check if this ctx method matches a target prefix
				const baseMethod = methodText.split(".")[0] ?? methodText;
				if (!targetCtxMethods.has(baseMethod)) continue;

				findings.push(processAstGrepMatch(match, dirName, filePath, apiName));
			}
		}

		// Find import statements referencing pi modules
		const importFindings = findImportFindings(filePath, content, dirName);
		findings.push(...importFindings);
	}

	return { findings, skipCount };
}
