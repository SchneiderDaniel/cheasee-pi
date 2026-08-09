/**
 * executor.ts — Run ddgs Python script via temp files + env execution
 *
 * Isolates shell quoting and temp file management.
 * Writes Python script + config to per-call isolated temp directories and
 * executes via bash -c with properly quoted paths.
 *
 * Uses fs.mkdtempSync for concurrency-safe isolation — each call gets a
 * unique directory under ignore/web-search/search-<random>/. Startup stale
 * cleanup removes orphaned directories from crashed processes.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExecResult, ExecFn } from "./types.ts";

/** Root directory for web-search temp files */
const RUN_DIR = path.join(process.cwd(), "ignore", "web-search");

/** Prefix for per-call temp directories created via mkdtempSync */
const TEMP_DIR_PREFIX = "search-";

/** Stale temp directory threshold: 1 hour in ms */
const STALE_CLEANUP_MS = 60 * 60 * 1000;

/**
 * Template for the temp directory path used inside runSearchScript.
 * mkdtempSync appends 6 random characters to this prefix.
 */
function tempDirPath(): string {
	return path.join(RUN_DIR, TEMP_DIR_PREFIX);
}

/**
 * Escape a string for use as a single-quoted bash argument.
 * Single-quote-safe: wrap in single quotes, escape embedded single quotes
 * by ending quote, adding escaped quote, and resuming.
 * abc'def → 'abc'\''def'
 */
export function shSingleQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Remove orphaned temp directories (search-*) older than 1 hour.
 * Runs at module init to clean up leftovers from crashed processes.
 * Safe to call multiple times — no-op if directory doesn't exist.
 */
export function cleanupStaleTempDirs(): void {
	try {
		if (!fs.existsSync(RUN_DIR)) return;
		const entries = fs.readdirSync(RUN_DIR, { withFileTypes: true });
		const now = Date.now();
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.startsWith(TEMP_DIR_PREFIX)) {
				const fullPath = path.join(RUN_DIR, entry.name);
				try {
					const stat = fs.statSync(fullPath);
					if (now - stat.mtimeMs > STALE_CLEANUP_MS) {
						fs.rmSync(fullPath, { recursive: true, force: true });
					}
				} catch {
					// Best effort per-entry
				}
			}
		}
	} catch {
		// Best effort at module init
	}
}

// Run stale cleanup at module init to clear crash orphans
cleanupStaleTempDirs();

/**
 * Write Python script and config to a per-call isolated temp directory,
 * then execute via bash -c. Each call gets its own directory via
 * fs.mkdtempSync to prevent cross-contamination under concurrent calls.
 *
 * @param python — Path to python3 binary
 * @param scriptContent — Python script content (SEARCH_SCRIPT)
 * @param config — { query, max_results, proxy?, timeout? } search config
 * @param timeout — Timeout in ms
 * @param signal — Optional AbortSignal
 * @param execFn — Exec function (typically pi.exec)
 * @returns ExecResult from execFn
 */
export async function runSearchScript(
	python: string,
	scriptContent: string,
	config: { query: string; max_results: number; proxy?: string; timeout?: number },
	timeout: number,
	signal?: AbortSignal,
	execFn?: ExecFn,
): Promise<ExecResult> {
	fs.mkdirSync(RUN_DIR, { recursive: true });

	const tempDir = fs.mkdtempSync(tempDirPath());
	const scriptPath = path.join(tempDir, "search.py");
	const configPath = path.join(tempDir, "config.json");

	fs.writeFileSync(scriptPath, scriptContent, "utf-8");
	fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

	const qPython = shSingleQuote(python);
	const qScript = shSingleQuote(scriptPath);
	const qConfig = shSingleQuote(configPath);

	const bashCmd = `${qPython} ${qScript} ${qConfig}`;

	try {
		return execFn
			? await execFn("bash", ["-c", bashCmd], { timeout, signal })
			: { code: 1, stdout: "", stderr: "executor: no exec function provided" };
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup, never throw
		}
	}
}

/**
 * Parse SEARCH_OK / SEARCH_DONE delimited output from the Python script.
 * Returns the JSON text between delimiters, or null if not found.
 */
export function parseSearchOutput(stdout: string): string | null {
	const okIdx = stdout.indexOf("SEARCH_OK");
	const doneIdx = stdout.indexOf("SEARCH_DONE");
	if (okIdx === -1 || doneIdx === -1 || doneIdx <= okIdx) {
		return null;
	}
	const jsonPart = stdout.slice(okIdx + "SEARCH_OK".length, doneIdx).trim();
	return jsonPart || null;
}

/**
 * Parse search results from the delimited output.
 * Returns parsed SearchResult array or error string.
 */
export function parseSearchResults(
	stdout: string,
):
	| { ok: true; results: Array<{ title: string; url: string; snippet: string }> }
	| { ok: false; error: string } {
	const jsonText = parseSearchOutput(stdout);
	if (!jsonText) {
		return { ok: false, error: "No delimited output found" };
	}
	try {
		const parsed = JSON.parse(jsonText);
		if (parsed.ok === false) {
			return { ok: false, error: parsed.error || "Search returned error" };
		}
		return { ok: true, results: parsed.results || [] };
	} catch (e) {
		return { ok: false, error: `Failed to parse search results: ${e}` };
	}
}
