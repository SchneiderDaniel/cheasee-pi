// ─── Constants (shared across message renderers) ───────────────────
// Consumed by render-subagent.ts (MAX_EXPANDED_TOOL_CALLS) and
// event/adapter/handlers.ts (MAX_NESTED_CALLS).

export const MAX_EXPANDED_TOOL_CALLS = 30;
/** Upper bound on nested tool calls captured per agent run (supervisor cap; pi's own bound is `maxCalls: 256`). */
export const MAX_NESTED_CALLS = 30;
