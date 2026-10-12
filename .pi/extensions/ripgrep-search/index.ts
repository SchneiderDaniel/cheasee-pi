/**
 * ripgrep-search entry point: registrations, events, execute, render.
 * Business logic extracted to submodules (config, args, parse) and internal.ts.
 */

import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type { ExtensionMode, SearchConfig } from "./types.ts";
import { RipgrepSearchOutputSchema } from "./types.ts";
import { loadSearchConfig, resolveBackend, ripgrepAvailable } from "./config.ts";
import { buildRgArgs, buildGrepArgs, parseVimgrepOutput, parseGrepOutput } from "./backends.ts";
import {
	validateQuery,
	registerTempDir,
	cleanupTrackedTempDirs,
	getCachedResult,
	setCachedResult,
	clearCache,
	setTestCtxMode,
} from "./internal.ts";
import { shouldInvalidateSearchCache } from "../lib/tool-mutation.ts";
import {
	buildStructuredSummary,
	buildStructuredContent,
	buildErrorStructuredContent,
} from "./summary.ts";
import { renderCallImpl, renderResultImpl } from "./render.ts";

const MAX_TOTAL_RESULTS = 500;

// ---------------------------------------------------------------------------
// Mode awareness — ExtensionMode mirrors upstream type for mode gating
// ---------------------------------------------------------------------------
// Mode state owned by internal.ts; index.ts delegates read/write to
// setTestCtxMode / getCtxMode so test and prod share one write path.

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
		if (!dirStat.isDirectory()) {
			const parentDir = dirname(resolvedDir);
			const relDir = parentDir === resolvedCwd ? "." : relative(resolvedCwd, parentDir);
			console.warn(
				`[ripgrep_search] Path "${directory}" is a file, searching parent directory "${relDir}" instead.`,
			);
			if (parentDir !== resolvedCwd && !parentDir.startsWith(resolvedCwd + "/")) {
				throw new Error(
					`Directory traversal detected: parent directory of "${directory}" resolves outside project root.`,
				);
			}
			return parentDir;
		}
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

/** @public */
export default function ripgrepSearch(pi: ExtensionAPI): void {
	let rgAvailable: boolean | null = null;
	let searchConfig: SearchConfig | null = null;
	let backendNoteInjected = false;

	pi.on("session_start", async (_event, ctx) => {
		setTestCtxMode(ctx.mode as ExtensionMode);
		searchConfig = loadSearchConfig(ctx.cwd);
		rgAvailable = searchConfig.searchBackend !== "grep" ? await ripgrepAvailable(pi.exec) : false;
		backendNoteInjected = false;
	});

	pi.on("session_shutdown", async () => {
		await cleanupTrackedTempDirs(rm);
		clearCache();
	});

	// In-session invalidation: a completed tool that may have mutated the corpus
	// (write/edit/bash/any unknown tool) makes cached matches stale, so drop the
	// whole cache. Read-only tools preserve intra-turn dedup. Fail-closed: an
	// unrecognized name invalidates. Never throws — a malformed event still clears.
	pi.on("tool_result", async (event: ToolResultEvent) => {
		const toolName = event?.toolName as string;
		if (shouldInvalidateSearchCache(toolName, event?.input)) clearCache();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!event.systemPromptOptions?.selectedTools?.includes("ripgrep_search")) return;
		if (backendNoteInjected) return;
		const config = searchConfig ?? { searchBackend: "auto" as const, maxLineLength: 200 };
		const resolved = resolveBackend(config, rgAvailable ?? false);
		const suffix =
			resolved.backend === "ripgrep"
				? `ripgrep${config.searchBackend === "ripgrep" ? " (user-configured)" : ""} — .gitignore respected, column offsets available, hidden files/dirs included (except .git/)`
				: `grep${config.searchBackend === "grep" ? " (user-configured)" : " (fallback)"} — .gitignore NOT respected, column always 1, excluded dirs: .git,node_modules,venv,__pycache__,.mypy_cache,.pytest_cache,dist,build; hidden files/dirs included by default`;
		backendNoteInjected = true;
		return { systemPrompt: event.systemPrompt + `\n[Search backend: ${suffix}]` };
	});

	pi.registerTool({
		name: "ripgrep_search",
		label: "Ripgrep Search",
		description:
			"Search codebase for literal text or regex using ripgrep. " +
			"Output: structured summary with top-N results, file counts, and truncation. " +
			"Respects .gitignore natively. Searches hidden files/directories (except .git/).",
		promptSnippet: "Search codebase for literal text or regex using ripgrep",
		promptGuidelines: [
			"Use ripgrep_search for literal text searches — magic numbers, hardcoded strings, error messages, TODOs, configuration values.",
			"ripgrep_search respects .gitignore natively. Default max_count=10 (per file). Default directory='.'.",
			"Searches hidden files/directories (e.g. .pi/), but excludes .git/.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Literal text/regex. Rejects class/def/function/$/{ patterns — use structural_search instead.",
			}),
			directory: Type.Optional(Type.String({ default: "." })),
			max_count: Type.Optional(Type.Integer({ default: 10 })),
		}),
		// Declarative hints for permission tooling: no mutation, repeatable, and
		// confined to the project directory (closed world).
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		// JSON Schema of `structuredContent` for programmatic/codemode callers.
		outputSchema: RipgrepSearchOutputSchema,
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
			const cached = getCachedResult(query, directory, maxCount);
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
					structuredContent: buildStructuredContent(
						cached.result,
						searcherName,
						query,
						directory,
					),
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
						structuredContent: buildStructuredContent(
							{ total_returned: 0, results: [] },
							searcherName,
							query,
							directory,
						),
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
				// isError (not throw): programmatic callers get typed failure data, while
				// content keeps the error text visible to the model and the TUI renderer.
				return {
					content: [{ type: "text" as const, text: errorText }],
					details: {
						success: false,
						searcher: searcherName,
						searchDirectory: resolvedDir,
					} as Record<string, unknown>,
					structuredContent: buildErrorStructuredContent(
						searcherName,
						query,
						directory,
						stderr,
						result.code,
					),
					isError: true,
				};
			}

			const searchResult = useRipgrep
				? parseVimgrepOutput(result.stdout, MAX_TOTAL_RESULTS)
				: parseGrepOutput(result.stdout, MAX_TOTAL_RESULTS);

			// Cache the result
			setCachedResult(query, directory, maxCount, {
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
				text += ` Full output saved to: ${fullOutputPath}`;
				details.truncated = true;
				details.fullOutputPath = fullOutputPath;
			} else if (searchResult.truncated) {
				text += " Full output not available";
			}

			return {
				content: [{ type: "text" as const, text }],
				details,
				structuredContent: buildStructuredContent(
					searchResult,
					searcherName,
					query,
					directory,
				),
			};
		},
		renderCall: renderCallImpl,
		renderResult: renderResultImpl,
	});
}

// Summary + render helpers extracted to siblings (issue #2005).
export {
	buildStructuredSummary,
	buildStructuredContent,
	buildErrorStructuredContent,
} from "./summary.ts";
export { renderCallImpl, renderResultImpl, wrapOsc8Link } from "./render.ts";
