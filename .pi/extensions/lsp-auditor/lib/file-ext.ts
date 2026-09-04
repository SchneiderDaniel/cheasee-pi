/**
 * File extension helper for LSP Auditor.
 *
 * Pure string logic — zero I/O. Single owner of the "no extension → ''"
 * decision, so callers can never re-derive extensions and regress to
 * slice(-1) behavior (Makefile must not yield "e").
 */

import { extname } from "node:path";

/**
 * Lowercased extension of a file path, including the leading dot.
 * Files without an extension ("Makefile", ".gitignore") yield "".
 * Matches node:path.extname semantics exactly (e.g. "file." → ".").
 */
export function fileExtension(file: string): string {
	return extname(file).toLowerCase();
}