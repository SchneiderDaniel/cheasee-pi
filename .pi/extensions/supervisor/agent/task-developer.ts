// ─── Developer task template ────────────────────────────────────
// The implementation prompt: worktree setup, resume hints, the conditional
// blocks (rebase, wip, gate failure, audit feedback, dead code, Dockerfile) and
// the structured-output contract. Split out of task.ts (issue #2033).

import { generateBranchName } from "../lib/branch-name.ts";
import type { TaskBuildContext } from "./task-context.ts";
import {
	auditFeedbackBlock,
	gateFailureBlock,
	rebaseConflictBlock,
	wipResumeBlock,
} from "./task-context-blocks.ts";
import { DOCKERFILE_AWARENESS_BLOCK, hasDockerfileRelevance } from "./issue-summary.ts";
import { JSON_OUTPUT_INSTRUCTION } from "./task-json-instruction.ts";

export function buildDeveloperTask(ctx: TaskBuildContext): string {
	const { title, issueNum, branchPrefix, remote, defaultBranch, filteredData } = ctx;
	const { systemPromptPrefix, issueBlock } = ctx;
	// Conditional sections, each "" when it does not apply.
	const rebaseConflict = rebaseConflictBlock(ctx.rebaseConflictContext, defaultBranch, remote);
	const wipResume = wipResumeBlock(ctx.wipResumeContext);
	const gateFailure = gateFailureBlock(ctx.gateFailureContext, remote, defaultBranch);
	const auditFeedback = auditFeedbackBlock(ctx.auditFeedback);

	const branch = generateBranchName(issueNum, title, branchPrefix);
	// Use JS string concatenation to avoid backtick escape issues in template literals
	const developerExample = JSON.stringify(
		{
			action: "COMPLETE",
			agentName: "developer",
			summary: "Implemented the feature",
			commentBody: "## Implementation\n\n[optional implementation notes]",
		},
		null,
		2,
	);
	// Dead code removal hint — injected when issue removes an export
	// Prevents TS2459: static import of removed symbol causes compile error
	const isDeadCodeRemoval = /dead.?code|dead export|unused export|not exported/i.test(
		`${title}
${filteredData.body}`,
	);
	const deadCodeRemovalBlock = isDeadCodeRemoval
		? `\n\n## Dead Code Removal Task\nThe issue removes an export from the module.\nTest files MUST NOT statically import (type or value) the removed symbol.\nUse only dynamic \`import()\` for verification.\n`
		: "";

	// Dockerfile awareness block — injected when issue references
	// adding/modifying external software dependencies
	const isDockerfileRelevant = hasDockerfileRelevance(title, filteredData.body);
	const dockerfileAwarenessBlock = isDockerfileRelevant ? DOCKERFILE_AWARENESS_BLOCK : "";

	// Prompt template defaults: thinking effort defaults to "medium" if not specified.
	// Uses pi's prompt template syntax \${N:-default} where available.
	return `${systemPromptPrefix}${issueBlock}\n\n## Task\nFollow your system prompt instructions.\n\n### Setup\nWork from current directory — worktree already set up by supervisor. Branch already created.\n\n⚠️ **This may be a resume after previous failure.** The worktree and branch may already contain\n   partial work from a prior attempt. Always check existing state before starting fresh:\n\n1. Run \`git status\` — if files modified/staged, a previous attempt left work behind\n2. Run \`git log --oneline ${remote}/${defaultBranch}..HEAD\` — if commits exist but unpushed,\n   previous work is sitting on the branch\n3. Run \`git stash list\` — there may be stashed changes from a prior attempt\n\n**If existing work found:** resume from it. Read existing files, check what\'s done, complete what\nremains. Do NOT start over — that wastes time and may discard partial progress.\n\n**If no existing work (clean state):** proceed with fresh implementation.\n\n${rebaseConflict}${wipResume}${gateFailure}${auditFeedback}${deadCodeRemovalBlock}${dockerfileAwarenessBlock}\n\n**Branch name:** ${branch}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\n${JSON_OUTPUT_INSTRUCTION}\n\n**Thinking effort (default: medium):** Set your thinking depth to \${1:-medium} — low for simple changes, high for complex refactors.\n\nExample output:\n\n\`\`\`json\n${developerExample}\n\`\`\``;
}
