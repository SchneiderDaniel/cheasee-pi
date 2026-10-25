// ─── Report artifact paths ──────────────────────────────────────
// The two gitignored artifact locations, relative to the session cwd. Split
// out of fetch-report.ts (issue #2033) so the store and the use case share one
// literal instead of importing each other.

/** Markdown artifact path, relative to the session cwd (gitignored). */
export const REPORT_REL_PATH = "ignore/codeflow-report.md";
/** Structured JSON artifact path, relative to the session cwd (gitignored). */
export const REPORT_JSON_REL_PATH = "ignore/codeflow-report.json";
