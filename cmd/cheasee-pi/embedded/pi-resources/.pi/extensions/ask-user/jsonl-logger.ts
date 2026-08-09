/**
 * ask-user — JSONL logger
 *
 * Pure functions for JSON Lines Q&A storage.
 * Each line is a valid JSON object: {"datetime":"<ISO>","question":"<string>","answer":"<string>"}
 * No TUI imports, no pi-ai dependency beyond types import.
 * Testable standalone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { QnaEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QNA_DIR = ".pi";
const QNA_CONTEXT = "context";
const QNA_JSONL = "qna.jsonl";
const QNA_CSV = "qna.csv";

// ---------------------------------------------------------------------------
// Rotation constants
// ---------------------------------------------------------------------------

/** Max JSONL entries per file before rotation triggers. */
const MAX_LINES_PER_FILE = 100;

/** Zero-padded width for archive index in filename. */
const ARCHIVE_DIGITS = 4;

/** Prefix for archive files: qna_0001.jsonl, qna_0002.jsonl, … */
const ARCHIVE_PREFIX = "qna_";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a Q&A entry before writing to JSONL.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateQnaEntry(entry: QnaEntry): string | null {
	if (!entry.question || entry.question.trim() === "") {
		return "Question must be non-empty";
	}
	if (!entry.answer || entry.answer.trim() === "") {
		return "Answer must be non-empty";
	}
	if (!isValidISODatetime(entry.datetime)) {
		return "Datetime must be a valid ISO 8601 string";
	}
	return null;
}

/**
 * Check if a string is a valid ISO 8601 datetime.
 * Accepts formats like: 2026-05-15T19:00:00.000Z or 2026-05-15T19:00:00+00:00
 */
export function isValidISODatetime(s: string): boolean {
	if (typeof s !== "string" || s.length < 10) return false;
	const d = new Date(s);
	if (isNaN(d.getTime())) return false;
	// Extract date components from the input string directly (first 10 chars)
	// and compare against a local-date constructor to detect overflow dates
	// (e.g. Feb 30 → Mar 2) WITHOUT rejecting valid timestamps where the UTC
	// date differs from the input date due to timezone offset.
	const datePart = s.slice(0, 10);
	const parts = datePart.split("-");
	if (parts.length !== 3) return false;
	const year = parseInt(parts[0]!, 10);
	const month = parseInt(parts[1]!, 10);
	const day = parseInt(parts[2]!, 10);
	// Construct a local date from the components to detect overflow rollover
	const constructed = new Date(year, month - 1, day);
	if (
		constructed.getFullYear() !== year ||
		constructed.getMonth() !== month - 1 ||
		constructed.getDate() !== day
	) {
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// JSONL serialization
// ---------------------------------------------------------------------------

/**
 * Convert a QnaEntry to a JSONL line (single JSON object + newline).
 */
export function toJsonlLine(entry: QnaEntry): string {
	return JSON.stringify(entry) + "\n";
}

/**
 * Parse a single JSONL line back to a QnaEntry.
 * Returns null for empty lines or parse errors.
 */
export function parseJsonlLine(line: string): QnaEntry | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (
			typeof parsed.datetime !== "string" ||
			typeof parsed.question !== "string" ||
			typeof parsed.answer !== "string"
		) {
			return null;
		}
		return parsed as QnaEntry;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function jsonlPath(projectDir: string): string {
	return path.join(projectDir, QNA_DIR, QNA_CONTEXT, QNA_JSONL);
}

function csvPath(projectDir: string): string {
	return path.join(projectDir, QNA_DIR, QNA_CONTEXT, QNA_CSV);
}

function contextDir(projectDir: string): string {
	return path.join(projectDir, QNA_DIR, QNA_CONTEXT);
}

/** Path for a rotated archive file (e.g. qna_0001.jsonl, qna_0002.jsonl). */
function rotatedJsonlPath(projectDir: string, index: number): string {
	const padded = String(index).padStart(ARCHIVE_DIGITS, "0");
	return path.join(projectDir, QNA_DIR, QNA_CONTEXT, `${ARCHIVE_PREFIX}${padded}.jsonl`);
}

/** Regex to match archive filenames like qna_0001.jsonl and extract the index. */
const ARCHIVE_RE = /^qna_(\d+)\.jsonl$/;

/**
 * Scan context dir for all qna_XXXX.jsonl archives, return sorted indices.
 * Returns empty array if dir doesn't exist.
 */
function listArchiveIndices(projectDir: string): number[] {
	const dir = contextDir(projectDir);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}

	const indices: number[] = [];
	for (const name of entries) {
		const m = name.match(ARCHIVE_RE);
		if (m) {
			indices.push(parseInt(m[1]!, 10));
		}
	}
	indices.sort((a, b) => a - b);
	return indices;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Count lines in a file. Returns 0 if file doesn't exist.
 * Treats a trailing newline as a line terminator, not an extra line.
 */
function countLines(filePath: string): number {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		if (content.length === 0) return 0;
		// Split, then drop trailing empty from terminal newline
		const lines = content.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			return lines.length - 1;
		}
		return lines.length;
	} catch {
		return 0;
	}
}

/**
 * Rotate Q&A log files.
 *
 * Finds next unused archive index, then renames active qna.jsonl →
 * qna_NNNN.jsonl. Archives accumulate indefinitely with no max limit.
 */
async function rotateQnaFile(projectDir: string): Promise<void> {
	const dir = contextDir(projectDir);
	await fs.promises.mkdir(dir, { recursive: true });

	// Find next unused index
	const existing = listArchiveIndices(projectDir);
	const nextIdx = existing.length > 0 ? existing[existing.length - 1]! + 1 : 1;

	// Rename active → qna_NNNN.jsonl
	try {
		await fs.promises.rename(jsonlPath(projectDir), rotatedJsonlPath(projectDir, nextIdx));
	} catch {
		/* no-op */
	}
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append one Q&A entry to .pi/context/qna.jsonl.
 * Validates the entry before writing.
 * Rotates automatically when active file reaches MAX_LINES_PER_FILE lines.
 * Returns the entry on success, or throws an error with validation/IO message.
 */
export async function appendQnaEntry(
	projectDir: string,
	timestamp: string,
	question: string,
	answer: string,
	trusted?: boolean,
): Promise<QnaEntry> {
	const entry: QnaEntry = { datetime: timestamp, question, answer };

	const validationError = validateQnaEntry(entry);
	if (validationError !== null) {
		throw new Error(validationError);
	}

	// Defensive guard: skip write when explicitly not trusted
	if (trusted === false) {
		return entry;
	}

	const dir = contextDir(projectDir);
	const filePath = jsonlPath(projectDir);

	await fs.promises.mkdir(dir, { recursive: true });

	// Rotate if active file at or above threshold
	if (countLines(filePath) >= MAX_LINES_PER_FILE) {
		await rotateQnaFile(projectDir);
	}

	await fs.promises.appendFile(filePath, toJsonlLine(entry), "utf-8");

	return entry;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a single JSONL file.
 * Skips empty/corrupted lines (logs warnings).
 * Returns empty array if file doesn't exist.
 */
async function readOneJsonlFile(filePath: string): Promise<QnaEntry[]> {
	let content: string;
	try {
		content = await fs.promises.readFile(filePath, "utf-8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw err;
	}

	const lines = content.split("\n");
	const entries: QnaEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") continue;
		const entry = parseJsonlLine(line);
		if (entry === null) {
			console.warn(`Warning: Skipping corrupted JSONL line ${i + 1} in ${path.basename(filePath)}`);
			continue;
		}
		entries.push(entry);
	}

	return entries;
}

/**
 * Read ALL Q&A entries across rotated archives + active file.
 * Merges in chronological order (oldest archive first, active last).
 * Returns empty array if no files exist.
 */
export async function readQnaEntries(projectDir: string): Promise<QnaEntry[]> {
	const entries: QnaEntry[] = [];

	// Read rotated archives in index order (oldest first)
	const indices = listArchiveIndices(projectDir);
	for (const idx of indices) {
		const archived = await readOneJsonlFile(rotatedJsonlPath(projectDir, idx));
		entries.push(...archived);
	}

	// Read active file (most recent entries)
	const active = await readOneJsonlFile(jsonlPath(projectDir));
	entries.push(...active);

	return entries;
}

/**
 * Get a single Q&A entry by 1-based line number.
 * Returns null if the line number is out of range or the entry is corrupted.
 * Returns undefined if the file doesn't exist.
 */
export async function getQnaEntry(
	projectDir: string,
	id: number,
): Promise<QnaEntry | null | undefined> {
	const entries = await readQnaEntries(projectDir);
	if (entries.length === 0) return undefined;
	if (id < 1 || id > entries.length) return null;
	return entries[id - 1]!;
}

/**
 * List the last N Q&A entries.
 * Default limit is 20.
 */
export async function listQnaEntries(projectDir: string, limit: number = 20): Promise<QnaEntry[]> {
	const entries = await readQnaEntries(projectDir);
	return entries.slice(-limit);
}

/**
 * Search Q&A entries by text (case-insensitive) in question AND answer fields.
 */
export async function queryQnaEntries(projectDir: string, text: string): Promise<QnaEntry[]> {
	const entries = await readQnaEntries(projectDir);
	const lowerText = text.toLowerCase();
	return entries.filter(
		(e) =>
			e.question.toLowerCase().includes(lowerText) || e.answer.toLowerCase().includes(lowerText),
	);
}

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
export function splitCsvRows(content: string): string[] {
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

	// Add last row if non-empty
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
	const csvFilePath = path.join(projectDir, QNA_DIR, QNA_CONTEXT, QNA_CSV);
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
