import type { RendererFn } from "./types.ts";
import { renderPhaseChange } from "./render-phase-change.ts";
import { renderToolComplete } from "./render-tool-complete.ts";
import { renderToolStart } from "./render-tool-start.ts";
import { renderSubagentResult } from "./render-subagent.ts";
import { renderThinking } from "./render-thinking.ts";
import { renderError } from "./render-error.ts";
import { renderBudgetExceeded } from "./render-budget.ts";
import { renderCompaction } from "./render-compaction.ts";
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
