// ─── Extension Resolution Module ──────────────────────────────────
// Resolve --extension CLI flags from agent frontmatter.
// Discover tools from registered extensions.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadSkillsRoots } from "../config/config.ts";

// ─── Extension path resolution ──────────────────────────────────────

/**
 * Internal version of resolveExtensionPaths that accepts a custom existsSync
 * function for testing. Public API wraps this with real existsSync.
 */
export function resolveExtensionPathsWithFs(
	extensionsRaw: string | undefined,
	cwd: string,
	existsSyncFn: (path: string) => boolean,
): string[] {
	if (!extensionsRaw || !extensionsRaw.trim()) return [];

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	const paths: string[] = [];
	for (const ext of extensions) {
		// Try single-file extensions: .ts first, then .js
		const fileTs = resolvePath(cwd, `.pi/extensions/${ext}.ts`);
		const fileJs = resolvePath(cwd, `.pi/extensions/${ext}.js`);
		// Try directory-based: index.ts first, then index.js
		const dirTs = resolvePath(cwd, `.pi/extensions/${ext}/index.ts`);
		const dirJs = resolvePath(cwd, `.pi/extensions/${ext}/index.js`);

		const found = [fileTs, fileJs, dirTs, dirJs].find((p) => existsSyncFn(p));

		if (found) {
			paths.push(found);
		} else {
			// Default to .ts path (will fail at runtime, but preserves existing behavior)
			paths.push(fileTs);
		}
	}

	return paths;
}

/**
 * Resolve extension names from agent frontmatter to absolute file paths.
 * Returns bare absolute paths (not CLI flags). Callers format flags
 * as needed (e.g., flatMap to "--extension" flags).
 *
 * Use resolveExtensionPathsWithFs for testing with a mock existsSync.
 */
export function resolveExtensionPaths(extensionsRaw: string | undefined, cwd?: string): string[] {
	return resolveExtensionPathsWithFs(extensionsRaw, cwd ?? process.cwd(), existsSync);
}

// ─── Skill path resolution ───────────────────────────────────────────

/**
 * Internal version of resolveSkillPaths that accepts a custom existsSync
 * function for testing. Public API wraps this with real existsSync.
 *
 * Resolution per skill name, per root, in declared order:
 * 1. `<root>/<name>.md`
 * 2. `<root>/<name>/SKILL.md`
 * first hit wins; later roots act as fallbacks.
 *
 * A skill missing from all roots warns (with name + tried paths) and is
 * skipped — never throws (fail-open, matches SDK loadSkills semantics).
 */
export function resolveSkillPathsWithFs(
	skillsRaw: string | undefined,
	cwd: string,
	existsSyncFn: (path: string) => boolean,
	roots?: string[],
): string[] {
	if (!skillsRaw || !skillsRaw.trim()) {
		return [];
	}

	const skills = skillsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (skills.length === 0) {
		return [];
	}

	// Pattern-prefixed entries are SDK override patterns, never literal roots.
	const skillRoots = (roots ?? [resolvePath(cwd, ".pi/skills")]).filter(
		(r) => !/^[!+-]/.test(r),
	);

	const result: string[] = [];
	for (const name of skills) {
		const tried: string[] = [];
		let found: string | undefined;
		for (const root of skillRoots) {
			const mdPath = resolvePath(root, `${name}.md`);
			const skillDirPath = resolvePath(root, `${name}/SKILL.md`);
			tried.push(mdPath, skillDirPath);
			if (existsSyncFn(mdPath)) {
				found = mdPath;
				break;
			}
			if (existsSyncFn(skillDirPath)) {
				found = skillDirPath;
				break;
			}
		}
		if (found) {
			result.push(found);
		} else {
			console.warn(
				`Skill "${name}" not found: tried ${tried.map((p) => `"${p}"`).join(", ")} — skipping`,
			);
		}
	}

	return result;
}

/**
 * Resolve comma-separated skill names from agent frontmatter to absolute
 * file paths suitable for --skill CLI flags.
 *
 * Skill roots come from the `skills` array in `.pi/settings.json`
 * (see loadSkillsRoots) — missing skills warn and are skipped, never throw.
 *
 * Empty/undefined input returns empty array (noop).
 */
export function resolveSkillPaths(skillsRaw: string | undefined, cwd?: string): string[] {
	const baseCwd = cwd || process.cwd();
	return resolveSkillPathsWithFs(skillsRaw, baseCwd, existsSync, loadSkillsRoots(baseCwd));
}

// ─── Tool discovery ────────────────────────────────────────────────

let _extToolsCache: Map<string, string[]> | null = null;

export function discoverExtensionTools(cwd?: string): Map<string, string[]> {
	if (_extToolsCache) return _extToolsCache;

	const map = new Map<string, string[]>();
	const baseCwd = cwd || process.cwd();
	const extDir = resolvePath(baseCwd, ".pi/extensions");

	let files: string[];
	try {
		files = readdirSync(extDir);
	} catch {
		_extToolsCache = map;
		return map;
	}

	const entries = files.filter((f) => f.endsWith(".ts") || !f.includes("."));

	for (const entry of entries) {
		const entryPath = resolvePath(extDir, entry);

		// Handle subdirectory extension (index.ts)
		let filePath: string;
		let basename: string;
		if (entry.endsWith(".ts")) {
			basename = entry.replace(/\.ts$/, "");
			filePath = entryPath;
		} else if (statSync(entryPath).isDirectory()) {
			basename = entry;
			filePath = resolvePath(entryPath, "index.ts");
			if (!existsSync(filePath)) continue;
		} else {
			continue;
		}

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const toolRe = /\.registerTool\(\s*\{[^}]*?\bname:\s*["']([^"']+)["']/gs;
		const tools: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = toolRe.exec(content)) !== null) {
			tools.push(m[1]!);
		}
		if (tools.length > 0) {
			map.set(basename, tools);
		}
	}

	_extToolsCache = map;
	return map;
}

// ─── Tool merging ──────────────────────────────────────────────────

/**
 * Merge agent-declared tools with tools from agent's extensions.
 * Returns a comma-separated string for --tools flag.
 */
export function resolveTools(
	agentTools: string,
	extNamesRaw: string | undefined,
	cwd?: string,
): string {
	const toolSet = new Set(
		agentTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	if (extNamesRaw && extNamesRaw.trim()) {
		const extToolsMap = discoverExtensionTools(cwd);
		const extNames = extNamesRaw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && s.toLowerCase() !== "supervisor");

		for (const extName of extNames) {
			const extTools = extToolsMap.get(extName);
			if (extTools) {
				for (const t of extTools) toolSet.add(t);
			}
		}
	}

	return [...toolSet].join(",");
}
