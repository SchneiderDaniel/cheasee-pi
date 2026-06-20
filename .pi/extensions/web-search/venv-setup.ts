/**
 * Web-search venv-setup adapter.
 *
 * Thin wrapper around shared ensureVenv utility with web-search-specific config.
 * No postInstall hook — ddgs is a lightweight pip-only dependency.
 * Throws on failure (never returns null) — caller gets typed EnsureVenvError.
 */

import { join } from "node:path";
import type { ExecFn } from "./types.ts";
import { ensureVenv } from "../lib/ensureVenv.ts";

// ── ensureWebSearchVenv ──

/**
 * Ensure web-search Python virtual environment exists with ddgs installed.
 * Returns path to venv python3 binary (throws on failure).
 *
 * @param exec — Exec function (typically pi.exec)
 * @param cwd — Working directory (project root)
 * @param onUpdate — Optional progress update callback
 * @returns Path to python3 binary (never null — throws on failure)
 * @throws EnsureVenvError if venv creation or package installation fails
 */
export async function ensureWebSearchVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
): Promise<string> {
	const result = await ensureVenv({
		exec,
		cwd,
		venvName: ".pi/web-search-venv",
		pipArgs: ["-r", join(cwd, ".pi/extensions/web-search/requirements.txt")],
		verifyCommand: "import ddgs; print('ok')",
		onUpdate,
		lockTimeoutMs: 120_000, // 2 min — pip install can take 30s+ when concurrent sessions exist
	});

	return result.pythonPath;
}
