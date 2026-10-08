import type { RendererFn } from "./types.ts";
import {
	renderBudgetExceeded,
	renderCompaction,
	renderError,
	renderPhaseChange,
	renderThinking,
	renderToolStart,
} from "./render-simple.ts";
import { renderSubagentResult } from "./render-subagent.ts";
import { renderToolComplete } from "./render-tool-complete.ts";
import { fallbackRenderer } from "./fallback-renderer.ts";

/** Dispatch table: one pure renderer per eventType, plus fallback. */
export const RENDERERS: Record<string, RendererFn> = {
	"phase-change": renderPhaseChange,
	"tool-complete": renderToolComplete,
	"tool-start": renderToolStart,
	"subagent-result": renderSubagentResult,
	thinking: renderThinking,
	error: renderError,
	"budget-exceeded": renderBudgetExceeded,
	compaction: renderCompaction,
};

export { fallbackRenderer };
