// ─── Task build context ─────────────────────────────────────────
// Everything a per-agent task template needs, assembled once by buildAgentTask.
// Split out of task.ts (issue #2033) so the templates import the shape rather
// than the dispatcher.

import type { FilteredIssueData } from "../config/types.ts";
import type { SystemPromptOptions } from "./task-prompt.ts";

export interface TaskBuildContext {
	agentName: string;
	issueNum: number;
	repo: string;
	title: string;
	filteredData: FilteredIssueData;
	defaultBranch: string;
	remote: string;
	branchPrefix: string;
	worktreePath?: string;
	branchName?: string;
	researchFindings?: string | null;
	gateFailureContext?: string;
	auditFeedback?: string | null;
	rebaseConflictContext?: string | null;
	wipResumeContext?: { sha: string; subject: string } | null;
	duplicateCodeContext?: string | null;
	deadCodeContext?: string | null;
	vulnContext?: string | null;
	/** The pre-filtered issue block every template starts from. */
	issueBlock: string;
	/** `buildSystemPromptSection(...)` plus its trailing blank lines, or "". */
	systemPromptPrefix: string;
}
