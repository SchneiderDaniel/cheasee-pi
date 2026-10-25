// ─── JSON output template ───────────────────────────────────────
// Every agent task ends with this block: the structured-output contract the
// pipeline parses deterministically. Split out of task.ts (issue #2033).

// ─── JSON Output Template ────────────────────────────────────────
// All agents must output a JSON object as their final message.
// The pipeline parses this as the primary completion signal.
// Text markers (e.g., ARCHITECTURE_COMPLETE) are only used as fallback if JSON is unavailable.

export const JSON_OUTPUT_INSTRUCTION = `
### Structured Output Format

Output your response as a JSON object in the following format (primary).
The pipeline parses this deterministically for status transitions, comments, and PRs.
If you absolutely cannot output JSON, fall back to the text completion marker mentioned in your system prompt.

\`\`\`json
{
  "action": "COMPLETE",
  "agentName": "<agent-name>",
  "summary": "<one-line summary of what was accomplished>",
  "commentBody": "<full comment body to post on GitHub issue>"
}
\`\`\`

> Omit \`refusal\` unless you cannot complete the task — never emit it alongside a successful \`action\`. If you refuse, set \`refusal\` to the reason instead of \`action\`; the pipeline stops and posts the reason as the issue comment, and you do not need \`action\` or \`agentName\` in that case.

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
