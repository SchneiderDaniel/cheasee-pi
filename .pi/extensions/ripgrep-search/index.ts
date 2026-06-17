/**
 * ripgrep-search entry point: registrations, events, execute, render.
 * Business logic extracted to submodules (config, args, parse) and internal.ts.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateLine } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { RgResult, SearchConfig } from "./types.ts";
import { loadSearchConfig, resolveBackend, ripgrepAvailable } from "./config.ts";
import { buildRgArgs, buildGrepArgs } from "./args.ts";
import { parseVimgrepOutput, parseGrepOutput } from "./parse.ts";
import {
	validateQuery,
	registerTempDir,
	cleanupTrackedTempDirs,
	getCachedResult,
	setCachedResult,
	clearCache,
} from "./internal.ts";

const MAX_TOTAL_RESULTS = 500;
const DEFAULT_DISPLAY_RESULTS = 10;

// ---------------------------------------------------------------------------
// Mode awareness — ExtensionMode mirrors upstream type for mode gating
// ---------------------------------------------------------------------------

type ExtensionMode = "tui" | "rpc" | "json" | "print";
let _ctxMode: ExtensionMode | undefined;

/** @internal Test-only: override ctx mode for rendering tests. */
export function _setTestCtxMode(mode: ExtensionMode | undefined): void {
	_ctxMode = mode;
}

export function buildSearchErrorText(
	searcherName: string,
	exitCode: number | null,
	killed: boolean | undefined,
	stderr: string,
	engineStr: string,
	directory: string,
): string {
	const isMissingTool = [/command not found/i, /not recognized/i, /internal error/i].some((p) =>
		p.test(stderr),
	);
	const isPathError = [/No such file or directory/i, /ENOENT/i, /not found/i].some((p) =>
		p.test(stderr),
	);
	let errorText: string;
	if (killed) {
		errorText = `${searcherName} process killed (exit ${exitCode}).`;
	} else if (!stderr.trim()) {
		errorText = `${searcherName} failed (exit ${exitCode}) with no error output.`;
	} else if (isMissingTool) {
		errorText = `${searcherName} failed (exit ${exitCode}): ${stderr}\n\nEnsure ${engineStr} installed.`;
	} else if (isPathError) {
		errorText = `${searcherName} failed (exit ${exitCode}): ${stderr}\nDirectory "${directory}" not found or inaccessible.`;
	} else {
		errorText = `${searcherName} failed (exit ${exitCode}): ${stderr}`;
	}
	return errorText;
}

export async function verifyDirectory(cwd: string, directory: string): Promise<string> {
	const resolvedDir = resolve(cwd, directory);
	// Security: prevent path traversal — reject directories outside project root
	const resolvedCwd = resolve(cwd);
	if (resolvedDir !== resolvedCwd && !resolvedDir.startsWith(resolvedCwd + "/")) {
		throw new Error(`Directory traversal detected: "${directory}" resolves outside project root.`);
	}
	try {
		const dirStat = await stat(resolvedDir);
		if (!dirStat.isDirectory()) throw new Error(`"${directory}" is a file, not a directory.`);
		return resolvedDir;
	} catch (err: unknown) {
		const nodeErr = err as { code?: string };
		if (nodeErr.code === "ENOENT") {
			let validDirs: string[] = [];
			try {
				const entries = await readdir(cwd, { withFileTypes: true });
				validDirs = entries
					.filter((e) => e.isDirectory())
					.map((e) => e.name + "/")
					.sort();
			} catch {
				/* ignore */
			}
			const dirList = validDirs.length > 0 ? ` Valid directories: ${validDirs.join(", ")}` : "";
			throw new Error(`Directory "${directory}" not found in project root.${dirList}`);
		}
		if (nodeErr.code === "ENOTDIR") throw new Error(`"${directory}" is a file, not a directory.`);
		const errorCode = nodeErr.code ? ` (${nodeErr.code})` : "";
		throw new Error(`Failed to access directory "${directory}": ${err}${errorCode}`);
	}
}

/**
 * Build a structured human-readable summary of search results.
 * Replaces the old JSON output format with a concise summary
 * showing top-N results, truncated indicator, and file counts.
 */
export function buildStructuredSummary(
	searchResult: RgResult,
	searcherName: string,
	query: string,
	directory: string,
	maxDisplay: number = DEFAULT_DISPLAY_RESULTS,
): { text: string; details: Record<string, unknown> } {
	const totalReturned = searchResult.total_returned;

	if (totalReturned === 0) {
		return {
			text: `No matches found for query "${query}" in "${directory}" (${searcherName}).`,
			details: { success: true, total_returned: 0, searcher: searcherName },
		};
	}

	// Count unique files
	const uniqueFiles = new Set(searchResult.results.map((r) => r.file));

	let text = `${searcherName} search results for query: ${query}\n`;
	text += `Directory: ${directory}\n`;
	text += `Matches returned: ${totalReturned}`;
	text += ` across ${uniqueFiles.size} file${uniqueFiles.size !== 1 ? "s" : ""}\n\n`;

	// Show top-N results (each line truncated to MAX_LINE_LENGTH for safety)
	const displayResults = searchResult.results.slice(0, maxDisplay);
	for (let i = 0; i < displayResults.length; i++) {
		const r = displayResults[i]!;
		const truncatedText = truncateLine(r.text).text;
		text += `${i + 1}. ${r.file}:${r.line}:${r.column}:${truncatedText}\n`;
	}

	const resultsTruncated = totalReturned > maxDisplay;
	let truncatedIndicator = "";
	if (resultsTruncated) {
		truncatedIndicator = `\n[Showing first ${maxDisplay} of ${totalReturned} results across ${uniqueFiles.size} file${uniqueFiles.size !== 1 ? "s" : ""}.`;
		text += truncatedIndicator;
	}

	const details: Record<string, unknown> = {
		success: true,
		searcher: searcherName,
		total_returned: totalReturned,
		unique_files: uniqueFiles.size,
		truncated: resultsTruncated,
	};

	return { text, details };
}

/**
 * Save oversized raw output to a temp file and return the path.
 */
async function saveOversizedOutput(rawStdout: string | undefined): Promise<string | undefined> {
	if (!rawStdout) return undefined;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-ripgrep-"));
	registerTempDir(tempDir);
	const fop = join(tempDir, "full-output.txt");
	await writeFile(fop, rawStdout, "utf8");
	return fop;
}

export default function ripgrepSearch(pi: ExtensionAPI): void {
	let rgAvailable: boolean | null = null;
	let searchConfig: SearchConfig | null = null;
	let backendNoteInjected = false;

	pi.on("session_start", async (_event, ctx) => {
		_ctxMode = ctx.mode as ExtensionMode;
		searchConfig = loadSearchConfig(ctx.cwd);
		rgAvailable = searchConfig.searchBackend !== "grep" ? await ripgrepAvailable(pi.exec) : false;
		backendNoteInjected = false;
	});

	pi.on("session_shutdown", async () => {
		await cleanupTrackedTempDirs(rm);
		clearCache();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!event.systemPromptOptions?.selectedTools?.includes("ripgrep_search")) return;
		if (backendNoteInjected) return;
		const config = searchConfig ?? { searchBackend: "auto" as const, maxLineLength: 200 };
		const resolved = resolveBackend(config, rgAvailable ?? false);
		const suffix =
			resolved.backend === "ripgrep"
				? `ripgrep${config.searchBackend === "ripgrep" ? " (user-configured)" : ""} — .gitignore respected, column offsets available`
				: `grep${config.searchBackend === "grep" ? " (user-configured)" : " (fallback)"} — .gitignore NOT respected, column always 1, excluded dirs: .git,node_modules,venv,__pycache__,.mypy_cache,.pytest_cache,dist,build`;
		backendNoteInjected = true;
		return { systemPrompt: event.systemPrompt + `\n[Search backend: ${suffix}]` };
	});

	pi.registerTool({
		name: "ripgrep_search",
		label: "Ripgrep Search",
		description:
			"Search codebase for literal text or regex using ripgrep. " +
			"Output: structured summary with top-N results, file counts, and truncation. " +
			"Respects .gitignore natively.",
		promptSnippet: "Search codebase for literal text or regex using ripgrep",
		promptGuidelines: [
			"Use ripgrep_search for literal text searches — magic numbers, hardcoded strings, error messages, TODOs, configuration values.",
			"ripgrep_search respects .gitignore natively. Default max_count=10 (per file). Default directory='.'.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Literal text/regex. Rejects class/def/function/$/{ patterns — use structural_search instead.",
			}),
			directory: Type.Optional(Type.String({ default: "." })),
			max_count: Type.Optional(Type.Number({ default: 10 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query;
			const directory = params.directory ?? ".";
			const maxCount = params.max_count ?? 10;

			const validationError = validateQuery(query);
			if (validationError) throw new Error(validationError);

			const resolvedDir = await verifyDirectory(ctx.cwd, directory);

			const config = searchConfig ?? loadSearchConfig(ctx.cwd);
			searchConfig = config;
			if (rgAvailable === null) rgAvailable = await ripgrepAvailable(pi.exec);

			const resolved = resolveBackend(config, rgAvailable);
			if (resolved.error) throw new Error(resolved.error);

			const useRipgrep = resolved.backend === "ripgrep";
			const searcherName = useRipgrep ? "ripgrep" : "grep";

			// Check cache first
			const cached = getCachedResult(query, directory);
			if (cached) {
				const summary = buildStructuredSummary(
					cached.result,
					searcherName,
					query,
					directory,
					maxCount,
				);
				return {
					content: [{ type: "text" as const, text: summary.text }],
					details: {
						...summary.details,
						searchDirectory: resolvedDir,
					} as Record<string, unknown>,
				};
			}

			const { command, args } = useRipgrep
				? buildRgArgs(query, directory, maxCount, config.maxLineLength)
				: buildGrepArgs(query, directory, maxCount);

			const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 30_000, signal });

			if (result.code !== 0) {
				if (result.code === 1) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No matches found for query "${query}" in "${directory}" (${searcherName}).`,
							},
						],
						details: {
							success: true,
							total_returned: 0,
							searcher: searcherName,
							searchDirectory: resolvedDir,
						} as Record<string, unknown>,
					};
				}
				const stderr = result.stderr || "";
				const engineStr = useRipgrep ? "ripgrep (`rg --version`)" : "grep";

				const errorText = buildSearchErrorText(
					searcherName,
					result.code,
					result.killed,
					stderr,
					engineStr,
					directory,
				);
				throw new Error(errorText);
			}

			const searchResult = useRipgrep
				? parseVimgrepOutput(result.stdout, MAX_TOTAL_RESULTS)
				: parseGrepOutput(result.stdout, MAX_TOTAL_RESULTS);

			// Cache the result
			setCachedResult(query, directory, {
				result: searchResult,
				rawStdout: result.stdout ?? "",
			});

			const summary = buildStructuredSummary(
				searchResult,
				searcherName,
				query,
				directory,
				maxCount,
			);

			// Save oversized output to temp file if truncated
			let fullOutputPath: string | undefined;
			if (searchResult.truncated) {
				fullOutputPath = await saveOversizedOutput(result.stdout);
			}

			let text = summary.text;
			const details: Record<string, unknown> = {
				...summary.details,
				searchDirectory: resolvedDir,
			};
			if (fullOutputPath) {
				text += ` Full output saved to: ${fullOutputPath}]`;
				details.truncated = true;
				details.fullOutputPath = fullOutputPath;
			} else if (searchResult.truncated) {
				text += " Full output not available]";
			}

			return {
				content: [{ type: "text" as const, text }],
				details,
			};
		},
		renderCall: renderCallImpl,
		renderResult: renderResultImpl,
	});
}

// ---------------------------------------------------------------------------
// Renderers — exported for testing
// ---------------------------------------------------------------------------

/** Render the tool call. */
export function renderCallImpl(
	args: { query: string; directory?: string },
	theme: Theme,
	_context: unknown,
): Text {
	if (_ctxMode && _ctxMode !== "tui") {
		return new Text(args.query, 0, 0);
	}

	let text = theme.fg("toolTitle", theme.bold("rg "));
	text += theme.fg("accent", `"${args.query}"`);
	if (args.directory && args.directory !== ".") text += theme.fg("muted", ` in ${args.directory}`);
	return new Text(text, 0, 0);
}

/** Render the tool result. */
export function renderResultImpl(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
	},
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Theme,
	_context: unknown,
): Text {
	const { expanded, isPartial } = options;

	// Non-TUI mode: pass through raw text content without theme
	if (_ctxMode && _ctxMode !== "tui") {
		const textContent = (result.content[0] as { text?: string })?.text ?? "";
		return new Text(textContent, 0, 0);
	}

	const d = result.details as
		| {
				total_returned?: number;
				searcher?: string;
				truncated?: boolean;
				fullOutputPath?: string;
				success?: boolean;
				searchDirectory?: string;
		  }
		| undefined;

	if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
	if (!d || d.success === false)
		return new Text(
			theme.fg("error", (result.content[0] as { text?: string })?.text ?? "Search failed"),
			0,
			0,
		);
	if (!d.total_returned) return new Text(theme.fg("dim", "No matches found"), 0, 0);

	let text = theme.fg("success", `${d.total_returned} matches`);
	text += theme.fg("muted", ` (${d.searcher ?? "?"})`);
	if (d.truncated) text += theme.fg("warning", " [truncated]");

	if (expanded) {
		const c = result.content[0] as { text?: string } | undefined;
		if (c?.text) {
			const lines = c.text.split("\n").slice(0, 20);
			for (const line of lines) {
				// Apply OSC 8 file:// hyperlink when searchDirectory is available
				const formattedLine = d.searchDirectory ? wrapOsc8Link(line, d.searchDirectory) : line;
				text += "\n" + theme.fg("dim", formattedLine);
			}
			if (c.text.split("\n").length > 20)
				text += "\n" + theme.fg("muted", "... (use read tool to see full output)");
		}
		if (d.fullOutputPath) text += "\n" + theme.fg("dim", `Full output: ${d.fullOutputPath}`);
	}

	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// OSC 8 hyperlink helper
// ---------------------------------------------------------------------------

/**
 * Wrap file path in a result line with an OSC 8 file:// hyperlink.
 *
 * Input format (from buildStructuredSummary):
 *   "1. file:line:column:text"
 * Output:
 *   "1. \x1b]8;;file:///path#L42\x1b\\file:42:16\x1b]8;;\x1b\\:text"
 */
export function wrapOsc8Link(line: string, searchDirectory: string): string {
	const resultLineRe = /^(\d+\.\s+)([^:]+):(\d+):(\d+):/;
	const match = line.match(resultLineRe);
	if (!match) return line;

	const [, prefix, file, lineNum] = match;
	const fileUrl = pathToFileURL(join(searchDirectory, file)).href + "#L" + lineNum;
	const osc8 = `\x1b]8;;${fileUrl}\x1b\\`;
	const osc8End = `\x1b]8;;\x1b\\`;

	// Build: "N. ${OSC8}file:line:column${OSC8_END}:text"
	const matchedPart = match[0]; // e.g. "1. src/app.ts:42:16:"
	const prefixLen = prefix.length; // "1. "
	const filePart = matchedPart.slice(prefixLen, -1); // "src/app.ts:42:16" (without trailing colon)
	return `${prefix}${osc8}${filePart}${osc8End}:${line.slice(matchedPart.length)}`;
}
