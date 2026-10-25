// ─── Issue data + Dockerfile awareness ──────────────────────────
// How raw issue data becomes the prompt's issue block, and whether the issue
// implies an external dependency change. Split out of task.ts (issue #2033).

import type { FilteredIssueData } from "../config/types.ts";

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
export const DOCKERFILE_AWARENESS_BLOCK = `\n\n### Dockerfile Awareness\n\nWhen the change involves adding, removing, or modifying external software dependencies (system packages, npm global tools, Go binaries, Python packages, or any CLI tool installed via RUN commands), update the corresponding Dockerfile(s):\n\n1. **Identify** which Dockerfile(s) need updating based on where the dependency is used.\n2. **Update** the Dockerfile to install the dependency in the correct layer.\n3. **Follow conventions** — pinned versions, layer separation, apt cleanup (\`rm -rf /var/lib/apt/lists/*\`).\n\n**Determining the correct Dockerfile:**\n- Pi agent dependencies (tools, CLIs, runtimes) → \`cmd/cheasee-pi/embedded/docker/Dockerfile\`\n- Development-only dependencies → consider whether Dockerfile is appropriate\n\n**Existing Dockerfile conventions to follow:**\n- **Pinned versions** — use specific version tags for packages (apt, pip, npm)\n- **Layer separation** — group related installs in the same RUN layer (minimize layers)\n- **apt cleanup** — chain \`rm -rf /var/lib/apt/lists/*\` in same RUN as apt-get install\n- **npm cache cleanup** — chain \`npm cache clean --force && rm -rf /tmp/*\`\n- **pip --no-cache-dir** — use \`--no-cache-dir\` flag with pip install\n- **Alpine** — use \`apk add --no-cache\` for Alpine-based Dockerfiles`;

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
 * The pre-filtered issue block agents must use instead of fetching from GitHub.
 * Every trusted comment appears verbatim — no truncation, no summarization.
 */
export function buildIssueBlock(
	title: string,
	repo: string,
	body: string,
	commentsBlock: string,
): string {
	return [
		`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
		`**Title:** ${title}`,
		`**Repository:** ${repo}`,
		``,
		`### Body`,
		body,
		``,
		`### Trusted Comments`,
		commentsBlock,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Trimmed issue block for the researcher: body only, because no architecture
 * comment exists yet (the researcher runs before the architect).
 */
export function buildResearcherIssueBlock(title: string, repo: string, body: string): string {
	return [
		`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
		`**Title:** ${title}`,
		`**Repository:** ${repo}`,
		``,
		`### Body`,
		body,
	]
		.filter(Boolean)
		.join("\n");
}

/** Trusted-comments block: pre-summarized text wins, else the raw comments. */
export function commentsBlockFor(
	summarizedRejections: string | undefined,
	comments: FilteredIssueData["comments"],
): string {
	if (summarizedRejections !== undefined) return summarizedRejections;
	if (comments.length > 0) return summarizeComments(comments);
	return "(no trusted comments)";
}
