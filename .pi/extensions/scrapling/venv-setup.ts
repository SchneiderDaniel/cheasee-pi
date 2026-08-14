/**
 * Scrapling venv-setup adapter.
 *
 * Thin wrapper around shared ensureVenv utility with scrapling-specific config.
 * Keeps domain config (pip args, verify command, post-install hook) co-located
 * in the scrapling extension module.
 *
 * Stealth-tier browser contract: the stealth fetcher (StealthyFetcher) resolves
 * its chromium build via patchright's registry, NOT playwright's — patchright
 * 1.61.2 pins chromium revision 1228 while playwright 1.62.0 pins 1234, and the
 * registry resolves the exact revision directory. Verification therefore asserts
 * the patchright-expected build exists (a pre-copied venv with a missing browser
 * must not silently pass and skip the self-heal hook), and the post-install hook
 * downloads it with `python -m patchright install chromium` — never
 * `scrapling.cli install`, which delegates to playwright's registry.
 */

import type { ExecFn } from "./types.ts";
import { isExecFailure } from "./types.ts";
import { ensureVenv } from "../lib/ensureVenv.ts";

/**
 * Verify command: imports the stealth fetcher AND asserts the patchright-expected
 * chromium build is present. Success stays the ensureVenv contract (exit 0 +
 * stdout "ok"); a missing browser exits 1 with an actionable stderr message.
 *
 * The revision is read from patchright's own browsers.json (never hardcoded) so
 * the check stays correct across version bumps. The cache root comes from
 * PLAYWRIGHT_BROWSERS_PATH (set by the Docker image) with the standard
 * ~/.cache/ms-playwright fallback (entrypoint.sh symlinks that to the baked
 * cache). Directory-existence is cross-platform (chrome-mac/chrome-win layouts
 * differ from chrome-linux64).
 */
const verifyCommand = [
	"import json, os, pathlib",
	"import patchright",
	"from scrapling.fetchers import StealthyFetcher; import markdownify",
	"browsers = json.loads((pathlib.Path(patchright.__file__).parent / 'driver/package/browsers.json').read_text())",
	"rev = next(b['revision'] for b in browsers['browsers'] if b['name'] == 'chromium')",
	"cache = os.environ.get('PLAYWRIGHT_BROWSERS_PATH') or str(pathlib.Path.home() / '.cache' / 'ms-playwright')",
	"bdir = pathlib.Path(cache) / f'chromium-{rev}'",
	"if not bdir.is_dir():",
	"    raise SystemExit(f\"Stealth-fetcher Chromium missing: expected {bdir} (patchright chromium revision {rev}). Run 'python -m patchright install chromium' with write access to {cache}.\")",
	"print('ok')",
].join("\n");

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
		verifyCommand,
		postInstall: async (pythonPath: string) => {
			const result = await exec(
				pythonPath,
				["-m", "patchright", "install", "chromium"],
				// ~2m22s measured for the chromium download; the old 120s cap killed
				// legit installs mid-flight.
				{ timeout: 600_000 },
			);
			if (isExecFailure(result)) {
				throw new Error(
					`patchright install chromium failed: ${(result.stderr || result.stdout).slice(0, 500)}`,
				);
			}
		},
		onUpdate,
	});

	return result.pythonPath;
}
