// ─── Event handlers (barrel) ────────────────────────────────────
// Per-kind AgentRunState mutation for normalized events. Pure state transforms
// over shared AgentRunState — no I/O, no chat rendering (that lives in
// adapter/forward.ts).
//
// Split by event family (issue #2033): tool in handlers-tool.ts, thinking in
// handlers-thinking.ts, text in handlers-text.ts, message/done/context info in
// handlers-message.ts / handlers-done.ts / handlers-context-info.ts, budgets in
// handlers-budget.ts, phase ordering in phase.ts. Names are re-exported
// explicitly so this file stays auditable and existing importers are untouched.

export { handleToolExecutionStart, handleToolExecutionEnd } from "./handlers-tool.ts";
export {
	handleThinkingStart,
	handleThinkingDelta,
	handleThinkingEnd,
} from "./handlers-thinking.ts";
export { handleTextStart, handleTextDelta, handleTextEnd } from "./handlers-text.ts";
export { handleMessageEnd } from "./handlers-message.ts";
export { handleDone } from "./handlers-done.ts";
export { handleContextInfo } from "./handlers-context-info.ts";
