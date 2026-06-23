/**
 * Prompt enumeration and metadata extraction for context-info
 *
 * Provides listLocalPrompts() used by welcome banner and /explain-prompts command.
 * Thin wrapper around the shared listMarkdownResources engine.
 */

import { readdirSync } from "node:fs";
import { join as joinPath, basename } from "node:path";
import {
	listMarkdownResources,
	type ResourceMeta,
	type Locator,
	type NameOf,
} from "./markdown-resources.ts";
import type { Dirent } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────

export type PromptMeta = ResourceMeta;

// ─── Locator strategy ─────────────────────────────────────────────

/**
 * Prompts locator: recurse into subdirectories for .md files,
 * also accept top-level .md files.
 */
export const promptsLocator: Locator = (dir, entry) => {
	if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
		const subDir = joinPath(dir, entry.name);
		try {
			const subEntries = readdirSync(subDir, { withFileTypes: true });
			const paths: string[] = [];
			for (const sub of subEntries) {
				if (sub.isFile() && sub.name.endsWith(".md")) {
					paths.push(joinPath(subDir, sub.name));
				}
			}
			return paths.length > 0 ? paths : null;
		} catch {
			return null; // skip unreadable subdirectories
		}
	} else if (entry.isFile() && entry.name.endsWith(".md")) {
		return [joinPath(dir, entry.name)];
	}
	return null;
};

/** Derive name from file path: strip .md extension from filename. */
export const promptsNameOf: NameOf = (filePath) => basename(filePath).replace(/\.md$/, "");

// ─── Prompt enumeration ───────────────────────────────────────────

/**
 * List all prompt markdown files in .pi/prompts/ with metadata.
 * Recursively walks subdirectories. Returns sorted by name.
 */
export function listLocalPrompts(): PromptMeta[] {
	return listMarkdownResources({
		dir: ".pi/prompts",
		locate: promptsLocator,
		nameOf: promptsNameOf,
	});
}
