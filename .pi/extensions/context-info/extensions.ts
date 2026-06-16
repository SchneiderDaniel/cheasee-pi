/**
 * Extension enumeration and metadata extraction for context-info
 *
 * Provides listLocalExtensions() used by /explain-extensions command.
 * Domain logic only — no UI imports.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

// ─── Types ────────────────────────────────────────────────────────

export interface ExtensionMeta {
	name: string;
	filePath: string;
	description: string | null;
	error?: string;
}

// ─── JSDoc extraction ─────────────────────────────────────────────

const JSDOC_RE = /\/\*\*(?!\*)([\s\S]*?)\*\//;
const LINE_RE = /^\s*\*?\s?/;

/**
 * Extract the description from a top-level JSDoc comment block in file content.
 * Scans only first 40 lines of content. Returns null if no JSDoc found,
 * JSDoc has only whitespace, or JSDoc is not a valid /** block.
 */
export function extractJSDoc(content: string): string | null {
	// Scan only first 40 lines (covers all current extension JSDoc blocks)
	const head = content.split("\n").slice(0, 40).join("\n");
	const match = JSDOC_RE.exec(head);
	if (!match) return null;

	const raw = match[1]!;
	// Split lines, strip leading * and whitespace, join
	const lines = raw.split("\n");
	const cleaned = lines
		.map((line) => line.replace(LINE_RE, "").trimEnd())
		.filter((line, i, arr) => {
			// Keep empty lines only if they separate non-empty lines
			if (line === "") {
				// Keep if next non-empty line exists
				const remaining = arr.slice(i + 1).find((l) => l.trim() !== "");
				return remaining !== undefined;
			}
			return true;
		});

	const result = cleaned.join("\n").trim();
	return result.length > 0 ? result : null;
}

// ─── Extension enumeration ────────────────────────────────────────

/**
 * List all project-local extensions with metadata.
 * For directory-based extensions, reads JSDoc from index.ts.
 * If a .ts shim file exists alongside a directory with same name,
 * the directory is preferred (the shim is skipped).
 */
export function listLocalExtensions(): ExtensionMeta[] {
	const extDir = ".pi/extensions";
	try {
		if (!existsSync(extDir)) return [];
		const entries = readdirSync(extDir, { withFileTypes: true });

		// Collect entries, preferring directories over shim files
		const nameMap = new Map<string, { type: "file" | "dir"; entryName: string }>();
		for (const entry of entries) {
			if (entry.name === "." || entry.name === "..") continue;
			if (entry.isFile() && entry.name.endsWith(".ts")) {
				const name = entry.name.replace(/\.ts$/, "");
				// Only add if no directory already mapped
				if (!nameMap.has(name)) {
					nameMap.set(name, { type: "file", entryName: entry.name });
				}
			} else if (entry.isDirectory()) {
				// Directory overrides any previous shim file
				nameMap.set(entry.name, { type: "dir", entryName: entry.name });
			}
		}

		const result: ExtensionMeta[] = [];
		for (const [name, info] of nameMap) {
			let filePath: string;
			if (info.type === "dir") {
				filePath = joinPath(extDir, info.entryName, "index.ts");
				if (!existsSync(filePath)) {
					result.push({
						name,
						filePath: joinPath(extDir, info.entryName),
						description: null,
						error: "no index.ts in directory",
					});
					continue;
				}
			} else {
				filePath = joinPath(extDir, info.entryName);
			}

			let content: string;
			try {
				content = readFileSync(filePath, "utf-8");
			} catch (err) {
				result.push({
					name,
					filePath,
					description: null,
					error: String(err),
				});
				continue;
			}

			const description = extractJSDoc(content);
			result.push({ name, filePath, description });
		}

		return result.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}
