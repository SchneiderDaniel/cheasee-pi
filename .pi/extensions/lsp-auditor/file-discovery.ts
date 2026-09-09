/**
 * File discovery utilities for LSP Auditor.
 *
 * Pure string/map logic — zero I/O. Handles parsing git diff output
 * and grouping files by their matching LSP server.
 */

import type { ServerMapping } from "./types.ts";
import { fileExtension } from "./lib/file-ext.ts";

// ─── Git Diff Parsing ────────────────────────────────────────────────

/**
 * Extract list of modified files from `git diff <branch> --name-only` output.
 * Path validation restricts to worktree and blocks traversal.
 */
export function extractModifiedFiles(gitDiffOutput: string, _worktreePath: string): string[] {
	if (!gitDiffOutput || !gitDiffOutput.trim()) return [];

	const lines = gitDiffOutput
		.trim()
		.split("\n")
		.filter((l) => l.trim());
	const files: string[] = [];

	for (const line of lines) {
		const file = line.trim();
		if (!file) continue;

		const resolved = file.replace(/^(\.\/)+/, "");
		// Path traversal prevention — block only ".." as path component
		if (/\.\.(\/|$)/.test(resolved)) continue;
		if (resolved.startsWith("/")) continue;

		files.push(resolved);
	}

	return files;
}

// ─── File Grouping ───────────────────────────────────────────────────

/**
 * Group modified files by their matching LSP server mapping.
 * Unsupported files are noted in errors.
 */
export function groupFilesByServer(
	files: string[],
	mappings: ServerMapping[],
): { serverFiles: Map<ServerMapping, string[]>; errors: string[] } {
	const serverFiles = new Map<ServerMapping, string[]>();
	const unsupported: string[] = [];

	for (const file of files) {
		const ext = fileExtension(file);
		let found = false;
		// An empty extension (extension-less file) never matches — a mapping
		// configured with extensions: [""] must not capture Makefile-like files.
		for (const mapping of mappings) {
			if (ext !== "" && mapping.extensions.includes(ext)) {
				const list = serverFiles.get(mapping) || [];
				list.push(file);
				serverFiles.set(mapping, list);
				found = true;
				break;
			}
		}
		if (!found) unsupported.push(file);
	}

	const errors: string[] = [];
	if (unsupported.length > 0) {
		errors.push(`Unsupported file types (no LSP server configured): ${unsupported.join(", ")}`);
	}

	return { serverFiles, errors };
}
