/**
 * Shared markdown resource enumeration for context-info
 *
 * Consolidates the duplicated walk+read+extract+sort scaffold from prompts.ts
 * and skills.ts into one engine with pluggable locator strategies.
 *
 * Exported for direct unit-testing with a stub filesystem.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { Dirent } from "node:fs";

// ── Inlined from frontmatter.ts (single consumer: this module) ──
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const DESCR_RE = /^description:\s*(.+)$/m;

function extractDescription(content: string): string | null {
	const head = content.split("\n").slice(0, 30).join("\n");
	const fmMatch = FRONTMATTER_RE.exec(head);
	if (!fmMatch) return null;
	const descMatch = DESCR_RE.exec(fmMatch[1]);
	return descMatch ? descMatch[1]!.trim() : null;
}

// ─── Types ────────────────────────────────────────────────────────

export interface ResourceMeta {
	name: string;
	filePath: string;
	description: string | null;
}

/**
 * Given the top-level directory and a directory entry,
 * return file paths to read (absolute) or null to skip.
 * Pure function — no I/O (except optional internal readdirSync
 * for subdirectory recursion).
 */
export type Locator = (dir: string, entry: Dirent) => string[] | null;

/**
 * Derive the resource name from an absolute file path.
 * Pure function — no I/O.
 */
export type NameOf = (filePath: string) => string;

// ─── Walker engine ────────────────────────────────────────────────

export interface ListMarkdownResourcesOptions {
	dir: string;
	locate: Locator;
	nameOf: NameOf;
}

/**
 * Walk a directory, resolve markdown file paths via `locate`,
 * read and extract frontmatter descriptions, and return sorted results.
 *
 * Missing or unreadable directories/files are silently skipped.
 * Returns sorted by `name` (localeCompare).
 */
export function listMarkdownResources(opts: ListMarkdownResourcesOptions): ResourceMeta[] {
	const { dir, locate, nameOf } = opts;
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		const result: ResourceMeta[] = [];

		for (const entry of entries) {
			const paths = locate(dir, entry);
			if (paths === null) continue;
			for (const filePath of paths) {
				try {
					const content = readFileSync(filePath, "utf-8");
					const description = extractDescription(content);
					result.push({ name: nameOf(filePath), filePath, description });
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
