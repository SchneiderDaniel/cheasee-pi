// ─── Constants (shared across message renderers) ───────────────────
// Single source of truth — extracted from message-renderer.ts.

export const MAX_TASK_PREVIEW_CHARS = 80;
export const MAX_EXPANDED_TOOL_CALLS = 30;
/** Upper bound on nested tool calls captured per agent run (mirrors pi's bound). */
export const MAX_NESTED_CALLS = 30;
