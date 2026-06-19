/**
 * structural-search — AST-aware code search for function calls, classes, and patterns
 *
 * Extension entry point: tool registration, event handlers, execute orchestration.
 * All business logic is extracted to submodules (types, cache, language, parser,
 * validate, renderer).
 *
 * Features:
 * - Result cache keyed by (pattern, language, cwd)
 * - Language auto-detect from project files when language param omitted
 * - Streaming support: truncates large result sets (>100 matches)
 * - Binary auto-detection via promise caching (race-condition-free)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { setCache, getCache, makeCacheKey, clearResultCache } from "./cache.ts";
import { detectLanguage, DEFAULT_LANGUAGE } from "./language.ts";
import { interpretSgExecResult } from "./parser.ts";
import { validatePattern } from "./validate.ts";
import { renderStructuralSearchResult } from "./renderer.ts";

export default function structuralAnalyzer(pi: ExtensionAPI): void {
	// Lazy async binary detection — cached via shared promise (race-condition-free)
	// All concurrent callers await the same promise, so only one version check runs.
	// On failure, the promise is reset so the next caller retries (transient recovery).
	let binaryPromise: Promise<string> | null = null;

	function getSgBinary(): Promise<string> {
		if (binaryPromise) return binaryPromise;

		const COMMON_PATHS = [
			"/home/miria/.npm-global/bin/ast-grep",
			process.env.HOME ? `${process.env.HOME}/.npm-global/bin/ast-grep` : "",
			process.env.HOME ? `${process.env.HOME}/.local/bin/ast-grep` : "",
		];

		async function tryResolve(): Promise<string> {
			// 1) Try PATH-based lookup
			try {
				const result = await pi.exec("ast-grep", ["--version"], {
					timeout: 5_000,
				});
				if (result.code === 0) return "ast-grep";
			} catch {
				// not in PATH — continue
			}

			// 2) Try common npm global bin paths
			try {
				const prefixResult = await pi.exec("npm", ["config", "get", "prefix"], {
					timeout: 3_000,
				});
				if (prefixResult.code === 0) {
					const prefix = prefixResult.stdout?.trim();
					if (prefix) {
						const candidate = `${prefix}/bin/ast-grep`;
						const testResult = await pi.exec(candidate, ["--version"], {
							timeout: 5_000,
						});
						if (testResult.code === 0) return candidate;
					}
				}
			} catch {
				// npm config failed — continue
			}

			// 3) Try common hardcoded fallback paths
			for (const candidate of COMMON_PATHS) {
				if (!candidate) continue;
				try {
					const testResult = await pi.exec(candidate, ["--version"], {
						timeout: 3_000,
					});
					if (testResult.code === 0) return candidate;
				} catch {
					// not at this path — continue
				}
			}

			throw new Error(
				"ast-grep is not installed or not working. " + "Install it with: npm i -g @ast-grep/cli",
			);
		}

		binaryPromise = tryResolve().catch((err: unknown) => {
			// Reset so next caller retries (transient failure recovery)
			binaryPromise = null;
			throw err;
		});

		return binaryPromise;
	}

	pi.registerTool({
		name: "structural_search",
		label: "Structural Search",
		description:
			"Search codebase for structural/grammatical patterns using ast-grep. " +
			"Uses Tree-sitter AST parsing to find semantic code relationships like " +
			"function calls, try/catch blocks, class definitions, and method invocations. " +
			"Output: JSON object with match count and array of results containing " +
			'{ file: string, lines: string (e.g. "22-28"), snippet: string (truncated) }. ' +
			"Use this to answer 'Where is this function called?' or 'Find all try/catch blocks' " +
			"without noise from text matches in comments or strings. " +
			"Requires ast-grep installed (`npm i -g @ast-grep/cli`).",
		promptSnippet: "Search codebase for structural code patterns using ast-grep AST matching",
		promptGuidelines: [
			"Use structural_search for syntax-aware code searches where you need to find function calls, class definitions, try/catch blocks, or method invocations without text-match noise from comments or strings.",
			"Pattern syntax uses $META_VAR for single AST node matching (e.g., console.log($A)) and $$$MULTI for zero-or-more nodes (e.g., try { $$$BODY } catch (e) { $A }).",
			"Single-word text patterns like 'TODO' are rejected — use ripgrep_search for plain text searches instead of ast-grep.",
			"Combine structural_search results with read to inspect specific matches by file path and line range.",
		],
		parameters: Type.Object({
			pattern: Type.String({
				description:
					"S-expression or code pattern for AST matching. " +
					"Uses $META_VAR for single nodes, $$$MULTI for zero-or-more nodes. " +
					"Examples: console.log($A), try { $$$BODY } catch (e) { $A }, function($A, $B). " +
					"Must contain structural syntax ($, {, (, [) — single-word text patterns are rejected.",
			}),
			language: Type.Optional(
				Type.String({
					description:
						"Target programming language for Tree-sitter grammar. " +
						"Auto-detected from project files when omitted. " +
						"Supported: ts, typescript, js, jsx, py, python, go, golang, rs, rust, and more. " +
						"See ast-grep docs for full list.",
				}),
			),
		}),
		renderResult: renderStructuralSearchResult as any,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { pattern } = params;
			const language =
				params.language ?? (await detectLanguage(pi.exec.bind(pi), ctx.cwd)) ?? DEFAULT_LANGUAGE;

			// Validate pattern first (collision rule)
			const validationError = validatePattern(pattern);
			if (validationError) {
				throw new Error(validationError);
			}

			// Check cache before executing
			const cacheKey = makeCacheKey(pattern, language, ctx.cwd);
			const cached = getCache(cacheKey);
			if (cached) {
				return cached;
			}

			// Get binary (lazy init, cached for subsequent calls)
			const binary = await getSgBinary();
			const args = ["scan", "--pattern", pattern, "--json=stream", "--lang", language];

			const result = await pi.exec(binary, args, {
				cwd: ctx.cwd,
				timeout: 30_000,
				signal: _signal,
			});

			// Use the extracted pure function to interpret the exec result
			const response = interpretSgExecResult(
				result.code,
				result.stdout || "",
				result.stderr || "",
				pattern,
				language,
			);

			// If the response indicates an error, throw so pi sets the isError flag
			if (response.isError) {
				throw new Error(response.content[0].text);
			}

			// Cache the result
			setCache(cacheKey, response);

			return response;
		},
	});

	// Clear cache between sessions to prevent cross-session memory bleed
	pi.on("session_shutdown", async () => {
		clearResultCache();
	});
}
