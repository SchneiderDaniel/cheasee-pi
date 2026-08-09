/**
 * Scrapling venv-setup adapter.
 *
 * Thin wrapper around shared ensureVenv utility with scrapling-specific config.
 * Keeps domain config (pip args, verify command, post-install hook) co-located
 * in the scrapling extension module.
 */

import type { ExecFn } from "./types.ts";
import { isExecFailure } from "./types.ts";
import { ensureVenv } from "../lib/ensureVenv.ts";

// ── ensureScraplingVenv ──

/**
 * Ensure Scrapling Python virtual environment exists and has required packages.
 *
 * @param exec — Exec function (typically pi.exec)
 * @param cwd — Working directory (project root)
 * @param onUpdate — Optional progress update callback
 * @returns Path to python3 binary
 * @throws EnsureVenvError if venv creation or package installation fails
 */
export async function ensureScraplingVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
): Promise<string> {
	const result = await ensureVenv({
		exec,
		cwd,
		venvName: ".pi/scrapling-venv",
		pipArgs: ["scrapling[fetchers]", "markdownify", "beautifulsoup4"],
		verifyCommand:
			"from scrapling.fetchers import StealthyFetcher; import markdownify; print('ok')",
		postInstall: async (pythonPath: string) => {
			const result = await exec(pythonPath, ["-m", "scrapling.cli", "install"], { timeout: 120_000 });
			if (isExecFailure(result)) {
				throw new Error(
					`scrapling.cli install failed: ${(result.stderr || result.stdout).slice(0, 500)}`,
				);
			}
		},
		onUpdate,
	});

	return result.pythonPath;
}
