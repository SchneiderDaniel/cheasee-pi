// ─── Event adapter barrel ───
// Public surface of the event/adapter split. Consumers import this
// directory (or the event/adapter.ts shim) — never the modules directly.
// Explicit re-exports on purpose: the surface must stay auditable, and types
// are re-exported with `export type` so `isolatedModules` never trips TS1205.
// The handler families are re-exported explicitly from handlers.ts, which is
// where that surface is audited (issue #2033).

export type { NormalizedEvent, NormalizedUsage, HandlerResult } from "./normalize-types.ts";
export {
	normalizeEvent,
	agentSessionEventToNormalizedEvent,
	jsonLineToNormalizedEvent,
	filterStderr,
	processNormalizedEvent,
} from "./normalize.ts";
export {
	handleToolExecutionStart,
	handleToolExecutionEnd,
	handleThinkingStart,
	handleThinkingDelta,
	handleThinkingEnd,
	handleTextStart,
	handleTextDelta,
	handleTextEnd,
	handleMessageEnd,
	handleDone,
	handleContextInfo,
} from "./handlers.ts";
export type { ForwardChatState } from "./forward.ts";
export { createForwardChatState, forwardNormalizedEventToChat } from "./forward.ts";
