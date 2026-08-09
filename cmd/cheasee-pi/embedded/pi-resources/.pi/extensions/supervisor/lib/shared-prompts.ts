// ─── Shared Prompts ────────────────────────────────────────────────
// Centralized prompt snippets extracted from agent .md files.
// These were previously duplicated across 5 agent files as LLM-instructed
// rules. Now they are deterministic TypeScript constants that the agent
// loader prepends to each agent's system prompt.
//
// Per-agent overrides are injected after the shared discipline block.

/** Per-agent tool discipline overrides (injected after shared discipline block). */
interface AgentDisciplineOverrides {
	/** Additional discipline rules specific to this agent. */
	extra: string[];
	/** Whether to inject investigation efficiency guidance. */
	investigation?: boolean;
}

/** Registry of per-agent discipline overrides. */
const AGENT_OVERRIDES: Record<string, AgentDisciplineOverrides> = {
	developer: {
		extra: [
			"- **structural_search for code:** When touching ≥3 code files, use `structural_search` first to find relevant structures — more precise than text grep.",
		],
		investigation: true,
	},
	auditor: {
		extra: ["- **View diff:** Use `git diff` via bash — this is correct"],
	},
	researcher: {
		extra: ["- **Web search:** Use `web_crawl` — NOT `bash curl`, `bash wget`, or any HTTP tool"],
	},
	architect: {
		extra: [
			"- **Explore code structure:** Use `structural_search` for AST-aware discovery (function defs, class declarations, method calls, try/catch) — NOT `bash | grep`. AST queries find patterns across files without noise from comments/strings.",
		],
	},
	"test-designer": {
		extra: [
			"- **Explore code structure:** Use `structural_search` to find test patterns (describe/it blocks, test functions) — NOT `bash | grep`. AST queries find test suites across files precisely.",
		],
		investigation: true,
	},
};

/**
 * The shared tool discipline snippet that all agents receive.
 * This was previously duplicated across 5 agent .md files.
 */
export const TOOL_DISCIPLINE_SNIPPET = `🛠 Tool Discipline — Shared Rules

- **Read files:** Use \`read(path, offset?, limit?)\` — NOT \`bash cat\`, \`bash head\`
- **Search codebase:** Use \`ripgrep_search\` for text, \`structural_search\` for AST patterns — NOT \`bash | grep\`, \`bash | rg\`
- **Find symbols/file overview:** Use \`ripgrep_search\` for text, \`structural_search\` for AST-based symbol queries — NOT \`bash | grep\` for class/function names
- **Edit files:** Use \`edit\` for precise text replacement — NOT \`bash sed\`, \`write\` (full overwrite)
- **Error means rethink:** If tool errors, change approach — different args, different tool, or ask user. Do NOT retry same tool+args.
- **Batch same-tool calls:** 3+ consecutive same tool → merge into one (bash with \`&&\`, read larger region)
- **Read once:** Use \`offset\`/\`limit\` to page through large files. Do NOT re-read same file within 3 turns.`;

/**
 * Language-agnostic error handling principles injected into every agent's
 * system prompt after the tool discipline snippet. These ensure that all
 * code written by agents (across TypeScript, Python, Go, Rust, shell, etc.)
 * fails visibly and never silently swallows errors.
 */
export const ERROR_HANDLING_PRINCIPLES = `## Error Handling Principles — Apply to ALL code you write

1. **Every error path user-visible** — Never log-only. Surface to user.
2. **Never empty catch/except/recover** — Surface, re-throw, or return error.
3. **Check every return code** — Check subprocess/API returns.
4. **Clean up in finally/defer** — Clean temp state in finally/defer.
5. **Fail closed** — Precondition fail = stop. Surface/halt.
6. **Never return partial success** — Partial result as success hides problems.`;

/**
 * Investigation efficiency guidance injected into developer and test-designer
 * system prompts after the error handling principles block.
 */
export const INVESTIGATION_EFFICIENCY = `## Investigation Efficiency — When debugging test failures

1. **Isolate first** — Run \`node --experimental-strip-types --test <file> --test-name-pattern="<subtest-name>"\` before reading any source code. Use the subtest name from failure output, not the parent describe-block. After filtering, verify at least 1 test ran — 0 means regex matched nothing.
2. **Read the test first** — Understand what the test expects before reading implementation.
3. **Trace only the relevant path** — Once you know which assertion fails, trace only the code path producing actual vs expected.`;

/**
 * Instruction for researcher deduplication scan.
 * Previously embedded in researcher.md, now a shared constant.
 */
const DEDUPLICATION_SCAN_INSTRUCTION = `### 1. Deduplication Scan
Scan the provided issue data for an existing comment containing \`## Research Findings\`. If one exists, skip all research and output a JSON object with \`"action": "COMPLETE", "agentName": "researcher"\` (see Structured Output Format in your task). Fallback: if you cannot output JSON, output \`RESEARCH_COMPLETE\` on its own line. Do nothing else.`;

/**
 * Centralized comment format templates.
 * Previously defined in individual agent .md files, now code-generated.
 */
const COMMENT_FORMAT_TEMPLATES = {
	researcher: `## Research Findings

### Best Practices
- <finding> — <source link>
- ...

### Recent Libraries
- <library> <version> — <why relevant> — <source link>
- ...

### Common Pitfalls
- <pitfall> — <why it matters> — <source link>
- ...

### Security Considerations
- <vulnerability or hardening pattern> — <source link>
- ...`,

	architect: `## Architecture

**Approach:** <patterns, what changes, 1-2 sentences>
**Components affected:** <qualified names, 1 line each>
**API/Data changes:** <new interfaces, shapes, 1 line each>
**Boundaries:** <where, which layer owns what, 1 line each>
**Trade-offs:** <what we accept, what we reject, why, 1 sentence each>
**Test strategy:** <which layers test without infra, which need integration>`,

	"test-designer":
		`## Test Plan

### Phase 1: <goal>
- <layer> — <scenario> → <expected outcome>
- ...

### Infrastructure
- Test framework: <framework and command>
- Fixtures: <what test data is needed>
- Mocking: <which modules to mock>

### Runnable Test Command
` + "```bash\n<exact test command>\n```",

	auditor: {
		approved: `## Audit Approved

**Score:** <passing>/6 — <summary>

**Checklist:**
- Architecture compliance: ✓
- Ticket fulfillment: ✓
- Tests passed: ✓
- Test quality: ✓
- Correctness & Safety: ✓
- Code quality: ✓
- Completeness: ✓`,

		rejected: `## Audit Rejected

**Score:** <passing>/6 — <summary>

### Findings
- **<severity> — <dimension>** — <symptom> → <consequence> → <remedy> (\`<location>\`)`,
	},
} as const;

/**
 * Build a complete system prompt for an agent by prepending the shared
 * tool discipline snippet and injecting per-agent overrides.
 *
 * @param basePrompt - The agent-specific behavior prompt from the .md file
 * @param agentName - The agent name (e.g., "developer", "auditor")
 * @returns The complete system prompt with shared discipline prepended
 */
export function buildAgentSystemPrompt(basePrompt: string, agentName: string): string {
	const parts: string[] = [TOOL_DISCIPLINE_SNIPPET];

	// Add shared error handling principles after tool discipline
	parts.push("");
	parts.push(ERROR_HANDLING_PRINCIPLES);

	// Add investigation efficiency guidance (for agents that execute tests)
	const overrides = AGENT_OVERRIDES[agentName];
	if (overrides?.investigation) {
		parts.push("");
		parts.push(INVESTIGATION_EFFICIENCY);
	}

	// Add per-agent overrides
	if (overrides && overrides.extra.length > 0) {
		parts.push("");
		parts.push(overrides.extra.join("\n"));
	}

	// Add separator and base prompt
	parts.push("");
	parts.push(basePrompt);

	return parts.join("\n");
}
