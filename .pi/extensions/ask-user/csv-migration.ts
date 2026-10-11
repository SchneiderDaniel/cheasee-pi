// ─── Legacy CSV → JSONL Migration ────────────────────────────────
// One-shot legacy adapter: parses the pre-JSONL qna.csv and migrates its
// rows into qna.jsonl. Split out of jsonl-logger.ts (issue #2001).

import * as fs from "node:fs";
import type { QnaEntry } from "./types.ts";
import { csvPath, jsonlPath, toJsonlLine, validateQnaEntry } from "./jsonl-codec.ts";

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line (semicolon-separated) into a QnaEntry.
 * Handles RFC 4180 quoted fields (fields containing ;, ", \n, \r).
 * Returns null if the line cannot be parsed.
 */
export function parseCsvLine(line: string): QnaEntry | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;

	// Parse fields with RFC 4180 awareness (quoted fields may contain semicolons)
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;

		if (ch === '"') {
			// Check for escaped quote ("")
			if (inQuotes && i + 1 < trimmed.length && trimmed[i + 1] === '"') {
				current += '"';
				i++; // skip next quote
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === ";" && !inQuotes) {
			fields.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	fields.push(current);

	if (fields.length < 3) return null;

	const [datetime, question, answer] = fields;
	if (!datetime || !question || answer === undefined) return null;

	return {
		datetime,
		question,
		answer,
	};
}

/**
 * Split CSV content into rows, handling RFC 4180 quoted fields that
 * may contain newlines. Returns an array of row strings.
 */
function splitCsvRows(content: string): string[] {
	const rows: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i]!;

		if (ch === '"') {
			// Check for escaped quote
			if (inQuotes && i + 1 < content.length && content[i + 1] === '"') {
				current += '""';
				i++;
			} else {
				inQuotes = !inQuotes;
				current += ch;
			}
		} else if (ch === "\n" && !inQuotes) {
			rows.push(current);
			current = "";
		} else if (ch === "\r" && !inQuotes) {
			// Skip CR, newline will come next
			continue;
		} else {
			current += ch;
		}
	}

	if (current.trim() !== "") {
		rows.push(current);
	}

	return rows;
}

/**
 * Migrate existing CSV entries to JSONL.
 *
 * Atomically renames CSV to a temp path first (making the original CSV
 * unavailable), reads entries from the temp file, appends them to qna.jsonl,
 * then deletes the temp file. This prevents duplicate entries if the
 * migration is interrupted: the source CSV content is moved away atomically,
 * so even on failure, no re-migration of the same entries can occur.
 *
 * If temp file deletion fails (permissions, file lock), entries have already
 * been written to JSONL — the migration is considered complete and a warning
 * is logged. Unparseable rows are skipped with a warning logged to stderr.
 */
export async function migrateQnaFromCsv(
	projectDir: string,
): Promise<{ migrated: number; skipped: number }> {
	const csvFile = csvPath(projectDir);
	const jsonlFile = jsonlPath(projectDir);

	// Check if CSV exists
	if (!fs.existsSync(csvFile)) {
		return { migrated: 0, skipped: 0 };
	}

	// Atomically rename CSV to temp path. If rename fails (permissions, disk
	// error), no entries have been written yet — throw for safe retry.
	const tmpFile = csvFile + ".tmp." + Date.now();
	fs.renameSync(csvFile, tmpFile);

	let migrated = 0;
	let skipped = 0;

	try {
		// Read content from the temp file (former CSV)
		const content = fs.readFileSync(tmpFile, "utf-8");
		const lines = splitCsvRows(content);

		for (const line of lines) {
			const entry = parseCsvLine(line);
			if (entry === null) {
				if (line.trim() !== "") {
					console.warn(`Warning: Skipping unparseable CSV row: ${line.slice(0, 80)}...`);
					skipped++;
				}
				continue;
			}

			// Validate the entry (skip invalid ones)
			const validationError = validateQnaEntry(entry);
			if (validationError !== null) {
				console.warn(`Warning: Skipping invalid CSV entry: ${validationError}`);
				skipped++;
				continue;
			}

			// Append to JSONL
			await fs.promises.appendFile(jsonlFile, toJsonlLine(entry), "utf-8");
			migrated++;
		}

		// All entries written. Delete temp file.
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Temp file unlink failure is non-fatal. Entries already committed.
			console.warn(`Warning: Could not remove temp file ${tmpFile}`);
		}

		return { migrated, skipped };
	} catch (err) {
		// Temp file (former CSV) remains on disk for potential manual recovery.
		// Migration runs once per session (called from session_start handler), so
		// even on failure no duplicate writes occur within the same session.
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Session start
// ---------------------------------------------------------------------------

/**
 * Migrate Q&A from CSV to JSONL if a CSV file exists.
 * Called at session start to migrate legacy CSV data.
 * No-op if CSV doesn't exist.
 * Errors are caught and logged as warnings — never throws.
 */
export async function migrateIfCsvExists(projectDir: string): Promise<void> {
	const csvFilePath = csvPath(projectDir);
	if (fs.existsSync(csvFilePath)) {
		try {
			const result = await migrateQnaFromCsv(projectDir);
			if (result.migrated > 0 || result.skipped > 0) {
				console.warn(
					`Migration: ${result.migrated} entries migrated to qna.jsonl, ${result.skipped} skipped`,
				);
			}
		} catch (err) {
			console.warn(`Migration warning: ${(err as Error).message}`);
		}
	}
}
