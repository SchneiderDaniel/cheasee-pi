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
			// Install patchright Chromium (revision 1228 — the build StealthyFetcher
			// launches). NOT scrapling.cli install: that runs `playwright install`
			// (wrong revision 1234 for patchright), and `python -m scrapling.cli` is
			// a silent no-op (cli.py has no `__main__` guard — only the bin script
			// invokes main(), and its shebang points at an absolute /opt/venvs path).
			// Best-effort: a failed browser download must not kill the venv — the
			// lightweight tier keeps working, and the Docker image pre-installs
			// chromium at build time with a fatal check (Dockerfile layer 5e).
			const result = await exec(pythonPath, ["-m", "patchright", "install", "chromium"], {
				timeout: 300_000,
			});
			if (isExecFailure(result)) {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `patchright chromium install failed (non-fatal — stealth tier unavailable): ${(
								result.stderr || result.stdout
							).slice(0, 300)}`,
						},
					],
					details: {},
				});
			}
		},
		onUpdate,
	});

	return result.pythonPath;
}
