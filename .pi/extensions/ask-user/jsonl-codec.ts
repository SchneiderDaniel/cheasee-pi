// ─── QnA JSONL Codec + Paths ─────────────────────────────────────
// Entry validation, JSONL line encode/parse, and the context-dir path
// helpers. Split out of jsonl-logger.ts (issue #2001); re-exported there.

import * as path from "node:path";
import type { QnaEntry } from "./types.ts";

// Constants
// ---------------------------------------------------------------------------

export const QNA_DIR = ".pi";
export const QNA_CONTEXT = "context";
const QNA_JSONL = "qna.jsonl";
const QNA_CSV = "qna.csv";

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

export function jsonlPath(projectDir: string): string {
	return path.join(projectDir, QNA_DIR, QNA_CONTEXT, QNA_JSONL);
}

export function csvPath(projectDir: string): string {
	return path.join(projectDir, QNA_DIR, QNA_CONTEXT, QNA_CSV);
}

export function contextDir(projectDir: string): string {
	return path.join(projectDir, QNA_DIR, QNA_CONTEXT);
}
