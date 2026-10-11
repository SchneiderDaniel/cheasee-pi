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
import type { QnaEntry, QnaListedEntry } from "./types.ts";
import {
	QNA_DIR,
	QNA_CONTEXT,
	contextDir,
	jsonlPath,
	parseJsonlLine,
	toJsonlLine,
	validateQnaEntry,
} from "./jsonl-codec.ts";

// ─── Split-out modules (issue #2001) ─────────────────────────────
// Codec + paths live in jsonl-codec.ts, the legacy CSV adapter in
// csv-migration.ts; re-exported here so importers keep this path.
export {
	validateQnaEntry,
	isValidISODatetime,
	toJsonlLine,
	parseJsonlLine,
} from "./jsonl-codec.ts";
export {
	parseCsvLine,
	migrateQnaFromCsv,
	migrateIfCsvExists,
} from "./csv-migration.ts";

// ---------------------------------------------------------------------------
// Rotation constants
// ---------------------------------------------------------------------------

/** Max JSONL entries per file before rotation triggers. */
const MAX_LINES_PER_FILE = 100;

/** Zero-padded width for archive index in filename. */
const ARCHIVE_DIGITS = 4;

/** Prefix for archive files: qna_0001.jsonl, qna_0002.jsonl, … */
const ARCHIVE_PREFIX = "qna_";

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
async function readOneJsonlFile(filePath: string, signal?: AbortSignal): Promise<QnaEntry[]> {
	let content: string;
	try {
		content = await fs.promises.readFile(filePath, { encoding: "utf-8", signal });
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
export async function readQnaEntries(projectDir: string, signal?: AbortSignal): Promise<QnaEntry[]> {
	signal?.throwIfAborted();
	const entries: QnaEntry[] = [];

	// Read rotated archives in index order (oldest first)
	const indices = listArchiveIndices(projectDir);
	for (const idx of indices) {
		const archived = await readOneJsonlFile(rotatedJsonlPath(projectDir, idx), signal);
		entries.push(...archived);
	}

	// Read active file (most recent entries)
	const active = await readOneJsonlFile(jsonlPath(projectDir), signal);
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
	signal?: AbortSignal,
): Promise<QnaEntry | null | undefined> {
	const entries = await readQnaEntries(projectDir, signal);
	if (entries.length === 0) return undefined;
	if (id < 1 || id > entries.length) return null;
	return entries[id - 1]!;
}

/**
 * List the last N Q&A entries.
 * Default limit is 20.
 *
 * Each returned entry carries its absolute 1-based id (position in the full
 * merged history), so `getQnaEntry(projectDir, entry.id)` always fetches the
 * same entry the list displays — even when the log has more entries than the
 * limit and only the tail is returned. `total` is the full history size.
 */
export async function listQnaEntries(
	projectDir: string,
	limit: number = 20,
	signal?: AbortSignal,
): Promise<{ entries: QnaListedEntry[]; total: number }> {
	const entries = await readQnaEntries(projectDir, signal);
	const total = entries.length;
	// Normalize limit to a non-negative integer BEFORE both slicing and id
	// assignment: Array.prototype.slice truncates its index toward zero, so
	// a fractional limit (e.g. 1.5) would slice at index 1 but compute ids
	// 2.5/3.5 — ids nobody can `get`. Clamp negatives to 0 (empty list).
	const normalized = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
	// start and id math share one source, so the slice offset and the
	// absolute ids can never disagree (start = total - limit + 1 for ids)
	const start = Math.max(0, total - normalized);
	const listed = entries.slice(start).map((e, i) => ({ ...e, id: start + i + 1 }));
	return { entries: listed, total };
}

/**
 * Search Q&A entries by text (case-insensitive) in question AND answer fields.
 * Matched entries carry their absolute 1-based id, so results are `get`-able.
 */
export async function queryQnaEntries(
	projectDir: string,
	text: string,
	signal?: AbortSignal,
): Promise<QnaListedEntry[]> {
	const entries = await readQnaEntries(projectDir, signal);
	const lowerText = text.toLowerCase();
	return entries
		.map((e, i) => ({ ...e, id: i + 1 }))
		.filter(
			(e) =>
				e.question.toLowerCase().includes(lowerText) || e.answer.toLowerCase().includes(lowerText),
		);
}
