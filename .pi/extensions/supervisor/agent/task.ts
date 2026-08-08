// ─── Agent Task Builder ────────────────────────────────────────────
// Builds task prompts per agent type. Generates branch names.
// Structured output protocol: agents output JSON in a ```json code fence.
// Pipeline parses JSON deterministically via parseAgentOutput() — no text
// markers, no regex fallback. Agents never run gh/git commands themselves.

import type { FilteredIssueData } from "../config/types.ts";

// ─── Constants ─────────────────────────────────────────────────────

// No constants needed — agents always see the full picture.

// ─── Dockerfile Awareness ──────────────────────────────────────────
// Trigger words that suggest the issue involves adding/modifying external
// dependencies requiring Dockerfile updates.
const DOCKERFILE_TRIGGER_REGEX =
	/\b(add|install|dependency|tool|npm|apt|pip|binary|cli|gitleaks|osv-scanner|Dockerfile|docker)\b/i;

/**
 * Check whether an issue title or body references adding external
 * software dependencies that would require Dockerfile updates.
 * Uses word-boundary regex to avoid false positives (e.g. "installation"
 * does NOT match trigger word "install").
 */
export function hasDockerfileRelevance(title: string, body: string): boolean {
	const text = `${title}\n${body}`;
	return DOCKERFILE_TRIGGER_REGEX.test(text);
}

/**
 * Dockerfile awareness instruction block injected into developer agent
 * tasks when the issue references adding/modifying external dependencies.
 */
const DOCKERFILE_AWARENESS_BLOCK = `\n\n### Dockerfile Awareness\n\nWhen the change involves adding, removing, or modifying external software dependencies (system packages, npm global tools, Go binaries, Python packages, or any CLI tool installed via RUN commands), update the corresponding Dockerfile(s):\n\n1. **Identify** which Dockerfile(s) need updating based on where the dependency is used.\n2. **Update** the Dockerfile to install the dependency in the correct layer.\n3. **Follow conventions** — pinned versions, layer separation, apt cleanup (\`rm -rf /var/lib/apt/lists/*\`).\n\n**Determining the correct Dockerfile:**\n- Pi agent dependencies (tools, CLIs, runtimes) → \`docker/Dockerfile\`\n- Development-only dependencies → consider whether Dockerfile is appropriate\n\n**Existing Dockerfile conventions to follow:**\n- **Pinned versions** — use specific version tags for packages (apt, pip, npm)\n- **Layer separation** — group related installs in the same RUN layer (minimize layers)\n- **apt cleanup** — chain \`rm -rf /var/lib/apt/lists/*\` in same RUN as apt-get install\n- **npm cache cleanup** — chain \`npm cache clean --force && rm -rf /tmp/*\`\n- **pip --no-cache-dir** — use \`--no-cache-dir\` flag with pip install\n- **Alpine** — use \`apk add --no-cache\` for Alpine-based Dockerfiles`;

export function generateBranchName(
	issueNum: number,
	title: string,
	prefix: string = "worktree-git-issue-",
): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 50);
	return `${prefix}${issueNum}-${slug}`;
}

// ─── JSON Output Template ────────────────────────────────────────
// All agents must output a JSON object as their final message.
// The pipeline parses this as the primary completion signal.
// Text markers (e.g., ARCHITECTURE_COMPLETE) are only used as fallback if JSON is unavailable.

const JSON_OUTPUT_INSTRUCTION = `
### Structured Output Format

Output your response as a JSON object in the following format (primary).
The pipeline parses this deterministically for status transitions, comments, and PRs.
If you absolutely cannot output JSON, fall back to the text completion marker mentioned in your system prompt.

\`\`\`json
{
  "action": "COMPLETE",
  "agentName": "<agent-name>",
  "summary": "<one-line summary of what was accomplished>",
  "commentBody": "<full comment body to post on GitHub issue>",
  "refusal": "<if you cannot complete the task, explain why here>"
}
\`\`\`

**IMPORTANT — AUDITOR MUST NOT USE "COMPLETE":**
For auditors, the action MUST be "APPROVED" or "REJECTED" (not "COMPLETE").
"COMPLETE" has no valid pipeline transition for the audit step.

For the **auditor** agent, use approval/rejection fields:

\`\`\`json
{
  "action": "APPROVED" | "REJECTED",
  "agentName": "auditor",
  "summary": "<one-line summary>",
  "commentBody": "<audit comment body>",
  "prTitle": "feat(#N): title (optional, for approval)",
  "prBody": "<PR description (optional, for approval)>",
  "auditScore": { "passing": N, "total": M },
  "findings": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "dimension": "<dimension-name>",
      "symptom": "<what is the issue>",
      "consequence": "<why it matters>",
      "remedy": "<how to fix>",
      "location": "<file path or reference (optional)>"
    }
  ]
}
\`\`\`

Place the JSON in a \`\`\`json\`\`\` code fence or as the last JSON object in your response.
The pipeline extracts it automatically.
`;

/**
 * Format all trusted comments verbatim with labels.
 * Every comment from every trusted author is included in full.
 * No truncation, no summarization, no size caps — agents always see the full picture.
 */
export function summarizeComments(comments: Array<{ author: string; body: string }>): string {
	if (comments.length === 0) return "(no trusted comments)";

	return comments
		.map((c, i) => `--- Comment #${i + 1} by @${c.author} ---\n${c.body}`)
		.join("\n\n");
}

/**
 * Build audit dimensions checklist for the auditor prompt.
 */
function buildAuditChecklist(dimensionCount: number): string {
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
function buildSystemPromptSection(options?: SystemPromptOptions): string {
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
): string {
	// Build trusted comments block
	// If summarizedRejections is provided, use it (pre-summarized by pipeline).
	// Otherwise, build from raw comments (backward compatible).
	let commentsBlock: string;
	if (summarizedRejections !== undefined) {
		commentsBlock = summarizedRejections;
	} else if (filteredData.comments.length > 0) {
		// All trusted comments verbatim — no truncation. Agents need full text.
		commentsBlock = summarizeComments(filteredData.comments);
	} else {
		commentsBlock = "(no trusted comments)";
	}

	// Build the pre-filtered issue data block that agents must use
	const issueBlock = [
		`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
		`**Title:** ${title}`,
		`**Repository:** ${repo}`,
		``,
		`### Body`,
		filteredData.body,
		``,
		`### Trusted Comments`,
		commentsBlock,
	]
		.filter(Boolean)
		.join("\n");

	// Build the research findings block (injected for architect from issue comments)
	const researchBlock = researchFindings ? `\n### Research Findings\n\n${researchFindings}\n` : "";

	// Build the gate failure context block (injected for developer when a pre-transition
	// hook — CI, TSC checkpoint, LSP pre-audit — blocked the Implementation→Audit
	// transition). Wrapped in XML tags for higher salience per Anthropic context engineering
	// guidelines. Includes action items for git status/log to handle stale partial edits.
	const gateFailureBlock = gateFailureContext
		? `<previous_gate_failure>
⚠️ THE PREVIOUS IMPLEMENTATION ATTEMPT WAS BLOCKED BY AUTOMATED CHECKS.
The following automated checks failed and blocked the transition to Audit.
You MUST address every item below before completing the implementation.
${gateFailureContext}
Action items:
1. Run \`git status\` — check for partial changes from the previous attempt
2. Run \`git log --oneline ${remote}/${defaultBranch}..HEAD\` — check for unpushed commits
3. Fix every issue listed above
4. Do NOT redo work that passed these checks — only fix what failed
</previous_gate_failure>
`
		: "";

	// Build the audit feedback block (injected for developer when looping back from Audit rejection)
	// This is a prominent section that tells the developer what the auditor found wrong.
	// It appears BEFORE the generic task instructions so the developer cannot miss it.
	const auditFeedbackBlock = auditFeedback
		? `🔴 **AUDITOR REJECTED YOUR PREVIOUS IMPLEMENTATION — FIX THESE ISSUES**

The previous audit found problems with your implementation. You MUST fix every issue listed below
before marking the task complete. Do NOT ignore or defer any critical or warning finding.

${auditFeedback}\n`
		: "";

	// Build the system prompt options section (injected from ctx.getSystemPromptOptions())
	// This passes relevant tool/skill/context info to sub-agents so they don't
	// rediscover resources independently.
	const systemPromptSection = buildSystemPromptSection(systemPromptOptions);
	const systemPromptPrefix = systemPromptSection ? systemPromptSection + "\n\n" : "";

	// Build the rebase conflict block (injected for developer when the
	// pre-Implementation rebase conflicted and was aborted — issue #1473).
	// The aborted rebase discards conflict markers, so the developer gets
	// explicit merge-reintegration steps instead. Mirrors the proven devTask
	// in pipeline/merge.ts; git push stays pipeline-owned.
	const rebaseConflictBlock = rebaseConflictContext
		? (() => {
				const files = rebaseConflictContext
					.split("\n")
					.map((p) => p.trim())
					.filter((p) => p.length > 0);
				return `\n\n### Reintegrate main\n\n⚠️ YOUR BRANCH CONFLICTS WITH THE LATEST \`${defaultBranch}\`. The pipeline attempted to rebase your worktree onto \`${remote}/${defaultBranch}\` before this implementation run, but ${files.length} file(s) conflicted:\n\n${files.map((p) => `- \`${p}\``).join("\n")}\n\nResolve these conflicts BEFORE implementing the issue:\n1. Fetch base: \`git fetch ${remote} ${defaultBranch}\`\n2. Merge base: \`git merge ${remote}/${defaultBranch}\`\n3. Resolve conflicts in the files listed above — keep your work, integrate main's changes\n4. Stage resolved files: \`git add -A\`\n5. Commit merge: \`git commit -m "fix: resolve conflicts with ${defaultBranch}"\`\n\nDo NOT run \`git push\` — the pipeline owns pushing.\n`;
			})()
			: "";

	switch (agentName) {
		case "architect":
			return `${systemPromptPrefix}${issueBlock}${researchBlock}\n\n## Task\nFollow your system prompt instructions.\n\n${JSON_OUTPUT_INSTRUCTION}\n\n⚠️ **STRICT FORMAT REQUIREMENT:** Your response MUST include the JSON block with \`commentBody\` or the \`## Architecture\` section heading. Plain text without structured format is silently skipped — no comment appears on the issue. Always include \`commentBody\` in your JSON.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;

		case "test-designer":
			return `${systemPromptPrefix}${issueBlock}\n\n## Task\nFollow your system prompt instructions.\n\n${JSON_OUTPUT_INSTRUCTION}\n\n⚠️ **STRICT FORMAT REQUIREMENT:** Your response MUST include the JSON block with \`commentBody\` or the \`## Test Plan\` section heading. Plain text without structured format is silently skipped — no comment appears on the issue. Always include \`commentBody\` in your JSON.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;

		case "developer": {
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
			return `${systemPromptPrefix}${issueBlock}\n\n## Task\nFollow your system prompt instructions.\n\n### Setup\nWork from current directory — worktree already set up by supervisor. Branch already created.\n\n⚠️ **This may be a resume after previous failure.** The worktree and branch may already contain\n   partial work from a prior attempt. Always check existing state before starting fresh:\n\n1. Run \`git status\` — if files modified/staged, a previous attempt left work behind\n2. Run \`git log --oneline ${remote}/${defaultBranch}..HEAD\` — if commits exist but unpushed,\n   previous work is sitting on the branch\n3. Run \`git stash list\` — there may be stashed changes from a prior attempt\n\n**If existing work found:** resume from it. Read existing files, check what\'s done, complete what\nremains. Do NOT start over — that wastes time and may discard partial progress.\n\n**If no existing work (clean state):** proceed with fresh implementation.\n\n${rebaseConflictBlock}${gateFailureBlock}${auditFeedbackBlock}${deadCodeRemovalBlock}${dockerfileAwarenessBlock}\n\n**Branch name:** ${branch}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\n${JSON_OUTPUT_INSTRUCTION}\n\n**Thinking effort (default: medium):** Set your thinking depth to \${1:-medium} — low for simple changes, high for complex refactors.\n\nExample output:\n\n\`\`\`json\n${developerExample}\n\`\`\``;
		}

		case "auditor": {
			const branch = generateBranchName(issueNum, title, branchPrefix);

			// Worktree path and branch name for cwd verification
			const wtBlock = worktreePath
				? `\n### Worktree Context\nYour current working directory IS the worktree at \`${worktreePath}\`.\nBefore any bash command, verify: \`pwd\` and \`git branch --show-current\`.\nWhen running shell commands, prepend: \`cd ${worktreePath} && <command>\`\nThe worktree branch is ${branchName || branch}.\n`
				: "";

			// Pre-audit duplicate code context — injected when pipeline found duplicates
			const dupBlock = duplicateCodeContext
				? `\n### ⚠️ Duplicate Code Detected (Pre-Audit Gate)\nThe automated duplicate code check found potential clones involving your changed files.\nPlease verify these findings and include them in your audit if confirmed.\n\n${duplicateCodeContext}\n`
				: "";

			// Pre-audit dead code context — injected when pipeline found dead code
			const deadBlock = deadCodeContext
				? `\n### ⚠️ Dead Code Detected (Pre-Audit Gate)\nThe automated dead code check found potential dead code in your changed files.\nPlease verify these findings and include them in your audit if confirmed.\n\n${deadCodeContext}\n`
				: "";

			// Pre-audit OSV vulnerability context — injected when pipeline found CVEs
			const vulnBlock = vulnContext
				? `\n### ⚠️ Vulnerabilities Detected (Pre-Audit Gate)\nThe automated OSV vulnerability scan found known CVEs in project dependencies.\nPlease verify these findings and include them in your audit if confirmed.\n\n${vulnContext}\n`

				: "";

			const checklist = buildAuditChecklist(8);

			return `${systemPromptPrefix}${issueBlock}\n\n## Task\nFollow your system prompt instructions.\n${wtBlock}${dupBlock}${deadBlock}${vulnBlock}\n\n\n${JSON_OUTPUT_INSTRUCTION}\n\n**IF APPROVE:**\n\n\`\`\`json\n{\n  \"action\": \"APPROVED\",\n  \"agentName\": \"auditor\",\n  \"summary\": \"Approved implementation\",\n  \"commentBody\": \"## Audit Approved\\n\\n### Summary\\n[1-2 sentences: what changed, why]\\n\\n### Review Findings\\n[Non-blocking notes]\\n\\n### Checklist\\n${checklist.replace(/\n/g, "\\n")}\\n\\n### Audit Score\\nAUDIT_SCORE: <passing>/10\",\n  \"prTitle\": \"feat(#${issueNum}): ${title}\",\n  \"prBody\": \"## PR Description\\n\\n[details]\",\n  \"auditScore\": { \"passing\": 10, \"total\": 10 },\n  \"findings\": []\n}\n\`\`\`\n\n**IF REJECT:**\n\n\`\`\`json\n{\n  \"action\": \"REJECTED\",\n  \"agentName\": \"auditor\",\n  \"summary\": \"Rejected - issues found\",\n  \"commentBody\": \"## Audit Rejected\\n\\n[list specific issues with Symptom → Consequence → Remedy → Location]\",\n  \"findings\": [\n    {\n      \"severity\": \"critical\",\n      \"dimension\": \"code-quality\",\n      \"symptom\": \"<what is the issue>\",\n      \"consequence\": \"<why it matters>\",\n      \"remedy\": \"<how to fix>\",\n      \"location\": \"<file path>\"\n    }\n  ]\n}\n\`\`\`\n\nThe pipeline will:\n1. Create a PR in ${repo} with the prBody as description\n2. Post a GitHub issue comment with the commentBody\n\n⚠️ **STRICT FORMAT REQUIREMENT:** Your response MUST include the JSON block shown above, or at minimum start with "AUDIT_DECISION: APPROVED/REJECTED" followed by "COMMENT_BODY:". If you output plain text without either JSON or AUDIT_DECISION: text markers, the pipeline silently skips posting your review — no comment appears on the PR. Your review is invisible without structured output. Always include commentBody in your JSON or provide COMMENT_BODY: after AUDIT_DECISION:.


**NOTE:** This strict format requirement also applies to architect, test-designer, and researcher agents. Every agent must include structured JSON with commentBody or a proper section heading.

**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		case "researcher": {
			// Trimmed issue block for researcher — issue body only.
			// No architecture comment exists yet (researcher runs before architect).
			const researcherBlock = [
				`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
				`**Title:** ${title}`,
				`**Repository:** ${repo}`,
				``,
				`### Body`,
				filteredData.body,
			]
				.filter(Boolean)
				.join("\n");
			return `${systemPromptPrefix}${researcherBlock}\n\n## Task\nFollow your system prompt instructions.

${JSON_OUTPUT_INSTRUCTION}\n\n**IMPORTANT:** You MUST always include a \`commentBody\` field in your JSON output.\nEven if you find no relevant results, set \`commentBody\` to \`## Research Findings — No relevant results found for this topic.\`\nand \`summary\` to a brief note about why nothing was found.\nDo NOT omit \`commentBody\` — a missing \`commentBody\` causes the pipeline to emit a warning\nand post a generic fallback comment instead of your actual findings.\n\n⚠️ **STRICT FORMAT REQUIREMENT:** Your response MUST include the JSON block with \`commentBody\` or the \`## Research Findings\` section heading. Plain text without structured format is silently skipped — no comment appears on the issue. Always include \`commentBody\` in your JSON.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		default:
			return `${systemPromptPrefix}${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
	}
}
