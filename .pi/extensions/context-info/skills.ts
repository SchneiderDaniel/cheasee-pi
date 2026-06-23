/**
 * Skill enumeration and metadata extraction for context-info
 *
 * Provides listLocalSkills() used by welcome banner and /explain-skills command.
 * Thin wrapper around the shared listMarkdownResources engine.
 */

import { existsSync } from "node:fs";
import { join as joinPath, basename, dirname } from "node:path";
import {
	listMarkdownResources,
	type ResourceMeta,
	type Locator,
	type NameOf,
} from "./markdown-resources.ts";
import type { Dirent } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────

export type SkillMeta = ResourceMeta;

// ─── Locator strategy ─────────────────────────────────────────────

/**
 * Skills locator: look for <dir>/SKILL.md in subdirectories,
 * or standalone .md files at the top level.
 * Skips .gitkeep entries.
 */
export const skillsLocator: Locator = (dir, entry) => {
	if (entry.name === ".gitkeep") return null;
	if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
		const skillMdPath = joinPath(dir, entry.name, "SKILL.md");
		if (existsSync(skillMdPath)) {
			return [skillMdPath];
		}
		return null;
	} else if (entry.isFile() && entry.name.endsWith(".md")) {
		return [joinPath(dir, entry.name)];
	}
	return null;
};

/**
 * Derive name from file path:
 * - For SKILL.md, use the parent directory name
 * - For standalone .md, strip extension
 */
export const skillsNameOf: NameOf = (filePath) => {
	if (basename(filePath) === "SKILL.md") {
		return basename(dirname(filePath));
	}
	return basename(filePath).replace(/\.md$/, "");
};

// ─── Skill enumeration ────────────────────────────────────────────

/**
 * List all project-local skills with metadata.
 * Walks .pi/skills/ for directories containing SKILL.md or standalone .md files.
 * Returns sorted by name.
 */
export function listLocalSkills(): SkillMeta[] {
	return listMarkdownResources({
		dir: ".pi/skills",
		locate: skillsLocator,
		nameOf: skillsNameOf,
	});
}
