// ─── Requirements Traceability ──────────────────────────────────────
// Shim — public surface moved to checks/requirements/ (index.ts):
// runRequirementsTraceability orchestrates the split check modules
// (parse/diff/coverage/parity/cleanup/title). Kept as a re-export so
// pipeline/audit/pre-gates.ts and the test suites import paths stay untouched.
export * from "./requirements/index.ts";
