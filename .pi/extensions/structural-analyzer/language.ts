/**
 * language.ts — Language auto-detection for structural-analyzer.
 *
 * Detects programming language from project configuration files in priority order:
 * sgconfig.yml > tsconfig.json > pyproject.toml > go.mod > Cargo.toml
 *
 * For sgconfig.yml, extracts the first key from the `languageGlobs:` section
 * using a naive line-based parser. This parser:
 * - Only extracts the first key under languageGlobs
 * - Does NOT handle multi-line YAML values (folded scalars `>`, literal blocks `|`)
 * - Does NOT handle YAML anchors, aliases, or complex keys
 * This is acceptable because the project's sgconfig.yml files never use complex values.
 *
 * The `\x00` null byte separator prevents collision when pattern, language,
 * or cwd contain '::'. Null bytes in JavaScript Map keys from agent-generated
 * inputs (not user input) are not exploitable — CWE-158 is immaterial here.
 */

/** Project config files for language auto-detection, in priority order. */
const CONFIG_PRIORITY: Array<{ file: string; language: string }> = [
	{ file: "sgconfig.yml", language: "" }, // special: parse languageGlobs from YAML
	{ file: "tsconfig.json", language: "typescript" },
	{ file: "pyproject.toml", language: "python" },
	{ file: "go.mod", language: "go" },
	{ file: "Cargo.toml", language: "rust" },
];

/** Default language when auto-detect fails and no caller-supplied language. */
export const DEFAULT_LANGUAGE = "ts";

/**
 * Check if a file exists in a given directory using `test -f`.
 */
export async function fileExists(
	exec: (command: string, args: string[], options?: { cwd?: string }) => Promise<{ code: number }>,
	file: string,
	cwd: string,
): Promise<boolean> {
	const result = await exec("test", ["-f", file], { cwd });
	return result.code === 0;
}

/**
 * Auto-detect the programming language from project configuration files
 * in the given cwd. Checks files in priority order:
 * sgconfig.yml > tsconfig.json > pyproject.toml > go.mod > Cargo.toml
 *
 * For sgconfig.yml, attempts to extract the first key from `languageGlobs`.
 * Returns null if no config file found.
 */
export async function detectLanguage(
	exec: (
		command: string,
		args: string[],
		options?: { cwd?: string },
	) => Promise<{ code: number; stdout: string }>,
	cwd: string,
): Promise<string | null> {
	for (const { file, language } of CONFIG_PRIORITY) {
		const exists = await fileExists(exec, file, cwd);
		if (!exists) continue;

		if (file === "sgconfig.yml") {
			// Read sgconfig.yml and extract first key from languageGlobs
			try {
				const readResult = await exec("cat", [file], { cwd });
				if (readResult.code === 0 && readResult.stdout) {
					const detected = parseLanguageGlobsFromYaml(readResult.stdout);
					if (detected) return detected;
				}
			} catch {
				// If reading fails, fall through to next config
			}
			continue;
		}

		// For all other config files, return the mapped language
		return language;
	}

	return null;
}

/**
 * Naive YAML parser that extracts the first key from a `languageGlobs:` section.
 * Only used for sgconfig.yml auto-detection — not a general YAML parser.
 *
 * Handles:
 *   languageGlobs:
 *     ts: "**\/*.ts"
 *     js: "**\/*.js"
 *   → returns "ts"
 *
 * Returns null if languageGlobs section not found or empty.
 */
export function parseLanguageGlobsFromYaml(yamlContent: string): string | null {
	const lines = yamlContent.split("\n");
	let inLanguageGlobs = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed === "languageGlobs:") {
			inLanguageGlobs = true;
			continue;
		}

		if (inLanguageGlobs) {
			// If we hit another top-level key (no indent), stop
			if (trimmed.length > 0 && !trimmed.startsWith("-") && line[0] !== " " && line[0] !== "\t") {
				return null;
			}

			// Match "  lang: ..." pattern
			const match = trimmed.match(/^(\S+):/);
			if (match) {
				let lang = match[1];
				// Strip surrounding single or double quotes (YAML spec §3.2.3.1)
				// Quotes are presentation detail, not content
				if (
					(lang.startsWith('"') && lang.endsWith('"')) ||
					(lang.startsWith("'") && lang.endsWith("'"))
				) {
					lang = lang.slice(1, -1);
				}
				return lang;
			}
		}
	}

	return null;
}
