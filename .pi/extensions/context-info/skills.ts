/**
 * Skill enumeration and metadata extraction for context-info
 *
 * Provides listLocalSkills() used by welcome banner and /explain-skills command.
 * Reads description from YAML frontmatter (`description:` field) of SKILL.md files
 * in .pi/skills/ directories. Falls back to first content line if no frontmatter found.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { extractDescription } from "./frontmatter.ts";

// ─── Types ────────────────────────────────────────────────────────

export interface SkillMeta {
	name: string;
	filePath: string;
	description: string | null;
}

// ─── Skill enumeration ────────────────────────────────────────────

/**
 * List all project-local skills with metadata.
 * Walks .pi/skills/ for directories containing SKILL.md or standalone .md files.
 * Returns sorted by name.
 */
export function listLocalSkills(): SkillMeta[] {
	const skillsDir = ".pi/skills";
	try {
		if (!existsSync(skillsDir)) return [];
		const entries = readdirSync(skillsDir, { withFileTypes: true });
		const result: SkillMeta[] = [];

		for (const entry of entries) {
			if (entry.name === ".gitkeep") continue;
			if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
				const skillMdPath = joinPath(skillsDir, entry.name, "SKILL.md");
				if (!existsSync(skillMdPath)) continue;
				try {
					const content = readFileSync(skillMdPath, "utf-8");
					const description = extractDescription(content);
					result.push({
						name: entry.name,
						filePath: skillMdPath,
						description,
					});
				} catch {
					// skip unreadable files
				}
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const filePath = joinPath(skillsDir, entry.name);
				try {
					const content = readFileSync(filePath, "utf-8");
					const description = extractDescription(content);
					const name = entry.name.replace(/\.md$/, "");
					result.push({ name, filePath, description });
				} catch {
					// skip unreadable files
				}
			}
		}

		return result.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}
