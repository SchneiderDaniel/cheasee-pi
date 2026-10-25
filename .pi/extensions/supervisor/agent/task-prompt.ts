// ─── System prompt options + audit checklist ────────────────────
// The optional tool/skill/context section and the auditor's dimension
// checklist. Split out of task.ts (issue #2033).

export function buildAuditChecklist(dimensionCount: number): string {
	let checklist = [
		"Architecture compliance: ✓",
		"Ticket fulfillment: ✓",
		"Tests passed: ✓",
		"Test quality: ✓",
		"Correctness & Safety: ✓",
		"Code quality: ✓",
		"Completeness: ✓",
		"Duplicate code: ← run jscpd or ripgrep_search to verify",
		"Dead code: ← verify findings from pre-audit gate or run ripgrep_search",
		"Package safety: ← verify findings from pre-audit gate or run npm view",
		"Research incorporation: ← verify researcher findings reflected in implementation, or deviation justified",
	];
	return checklist.join("\n");
}

// No path mapping block needed — all paths are repo-relative per architecture.

/**
 * System prompt options injected from ctx.getSystemPromptOptions().
 * Passes relevant context about active tools, skills, and context files
 * to sub-agents so they don't rediscover resources independently.
 */
export interface SystemPromptOptions {
	/** Currently selected tool names */
	selectedTools?: string[];
	/** Active context file paths */
	contextFiles?: string[];
	/** Loaded skill names */
	skills?: string[];
}

/**
 * Build the Available Tools section from system prompt options.
 * Only emitted when at least one field has content.
 */
export function buildSystemPromptSection(options?: SystemPromptOptions): string {
	if (!options) return "";

	const { selectedTools, contextFiles, skills } = options;
	const hasAnyContent =
		(selectedTools && selectedTools.length > 0) ||
		(contextFiles && contextFiles.length > 0) ||
		(skills && skills.length > 0);

	if (!hasAnyContent) return "";

	const lines: string[] = ["## Available Tools"];
	lines.push("");
	lines.push("The following tools, skills, and context files are already active:");
	lines.push("");

	if (selectedTools && selectedTools.length > 0) {
		lines.push("**Tools:** " + selectedTools.join(", "));
	}

	if (skills && skills.length > 0) {
		lines.push("**Active Skills:** " + skills.join(", "));
	}

	if (contextFiles && contextFiles.length > 0) {
		lines.push("**Context Files:** " + contextFiles.join(", "));
	}

	lines.push("");
	lines.push("Reuse these instead of loading them independently to avoid redundant context.");
	lines.push("");

	return lines.join("\n");
}
