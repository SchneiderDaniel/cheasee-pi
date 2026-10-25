// ─── Agent Task Builder ────────────────────────────────────────────
// Builds task prompts per agent type. Generates branch names.
// Structured output protocol: agents output JSON in a ```json code fence.
// Pipeline parses JSON deterministically via parseAgentOutput() — no text
// markers, no regex fallback. Agents never run gh/git commands themselves.
//
// Split by responsibility (issue #2033): the issue block and Dockerfile
// relevance in issue-summary.ts, the conditional sections in
// task-context-blocks.ts, the system-prompt options in task-prompt.ts, the
// developer and auditor templates in task-developer.ts / task-auditor.ts, the
// JSON contract in task-json-instruction.ts. This module assembles the context
// and dispatches. Moved names are re-exported so importers are untouched.

import type { FilteredIssueData } from "../config/types.ts";
import { generateBranchName } from "../lib/branch-name.ts";
import {
	buildIssueBlock,
	buildResearcherIssueBlock,
	commentsBlockFor,
	hasDockerfileRelevance,
	summarizeComments,
} from "./issue-summary.ts";
import { buildSystemPromptSection } from "./task-prompt.ts";
import type { SystemPromptOptions } from "./task-prompt.ts";
import { researchBlock } from "./task-context-blocks.ts";
import { JSON_OUTPUT_INSTRUCTION } from "./task-json-instruction.ts";
import { buildDeveloperTask } from "./task-developer.ts";
import { buildAuditorTask } from "./task-auditor.ts";
import type { TaskBuildContext } from "./task-context.ts";

// Re-exported so existing consumers (`pipeline/*`, tests) keep importing it
// from the task builder.
export { generateBranchName };
export { hasDockerfileRelevance, summarizeComments };
export type { SystemPromptOptions };

/** The pre-filtered issue block plus the system-prompt prefix every task opens with. */
function buildPromptPreamble(
	title: string,
	repo: string,
	filteredData: FilteredIssueData,
	summarizedRejections: string | undefined,
	systemPromptOptions: SystemPromptOptions | undefined,
): { issueBlock: string; systemPromptPrefix: string } {
	const commentsBlock = commentsBlockFor(summarizedRejections, filteredData.comments);
	const issueBlock = buildIssueBlock(title, repo, filteredData.body, commentsBlock);
	// This passes relevant tool/skill/context info to sub-agents so they don't
	// rediscover resources independently.
	const systemPromptSection = buildSystemPromptSection(systemPromptOptions);
	return {
		issueBlock,
		systemPromptPrefix: systemPromptSection ? systemPromptSection + "\n\n" : "",
	};
}

export function buildAgentTask(
	agentName: string,
	issueNum: number,
	repo: string,
	title: string,
	filteredData: FilteredIssueData,
	defaultBranch: string,
	remote: string,
	worktreeBase: string,
	branchPrefix: string,
	mainRepoPrefix: string,
	worktreePath?: string,
	branchName?: string,
	summarizedRejections?: string,
	duplicateCodeContext?: string | null,
	researchFindings?: string | null,
	auditFeedback?: string | null,
	deadCodeContext?: string | null,
	vulnContext?: string | null,

	gateFailureContext?: string,
	systemPromptOptions?: SystemPromptOptions,
	rebaseConflictContext?: string | null,
	wipResumeContext?: { sha: string; subject: string } | null,
): string {
	const { issueBlock, systemPromptPrefix } = buildPromptPreamble(
		title,
		repo,
		filteredData,
		summarizedRejections,
		systemPromptOptions,
	);
	// The research findings block (injected for architect from issue comments)
	const research = researchBlock(researchFindings);

	const ctx: TaskBuildContext = {
		agentName,
		issueNum,
		repo,
		title,
		filteredData,
		defaultBranch,
		remote,
		branchPrefix,
		worktreePath,
		branchName,
		researchFindings,
		gateFailureContext,
		auditFeedback,
		rebaseConflictContext,
		wipResumeContext,
		issueBlock,
		systemPromptPrefix,
	};

	switch (agentName) {
		case "architect":
			return `${systemPromptPrefix}${issueBlock}${research}\n\n## Task\nFollow your system prompt instructions.\n\n${JSON_OUTPUT_INSTRUCTION}\n\n⚠️ **STRICT FORMAT REQUIREMENT:** Your response MUST include the JSON block with \`commentBody\` or the \`## Architecture\` section heading. Plain text without structured format is silently skipped — no comment appears on the issue. Always include \`commentBody\` in your JSON.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;

		case "test-designer":
			return `${systemPromptPrefix}${issueBlock}\n\n## Task\nFollow your system prompt instructions.\n\n${JSON_OUTPUT_INSTRUCTION}\n\n⚠️ **STRICT FORMAT REQUIREMENT:** Your response MUST include the JSON block with \`commentBody\` or the \`## Test Plan\` section heading. Plain text without structured format is silently skipped — no comment appears on the issue. Always include \`commentBody\` in your JSON.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;

		case "developer":
			return buildDeveloperTask(ctx);

		case "auditor":
			return buildAuditorTask({ ...ctx, duplicateCodeContext, deadCodeContext, vulnContext });

		case "researcher": {
			// Trimmed issue block for researcher — issue body only.
			// No architecture comment exists yet (researcher runs before architect).
			const researcherBlock = buildResearcherIssueBlock(title, repo, filteredData.body);
			return `${systemPromptPrefix}${researcherBlock}\n\n## Task\nFollow your system prompt instructions.

${JSON_OUTPUT_INSTRUCTION}\n\n**IMPORTANT:** You MUST always include a \`commentBody\` field in your JSON output.\nEven if you find no relevant results, set \`commentBody\` to \`## Research Findings — No relevant results found for this topic.\`\nand \`summary\` to a brief note about why nothing was found.\nDo NOT omit \`commentBody\` — a missing \`commentBody\` causes the pipeline to emit a warning\nand post a generic fallback comment instead of your actual findings.\n\n⚠️ **STRICT FORMAT REQUIREMENT:** Your response MUST include the JSON block with \`commentBody\` or the \`## Research Findings\` section heading. Plain text without structured format is silently skipped — no comment appears on the issue. Always include \`commentBody\` in your JSON.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		default:
			return `${systemPromptPrefix}${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
	}
}
