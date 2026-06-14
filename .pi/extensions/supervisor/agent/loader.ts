// ─── Agent Loader ──────────────────────────────────────────────────
// Parse .pi/extensions/supervisor/agents/*.md files (YAML frontmatter + system prompt body).
// Prepends shared tool discipline snippet to every agent's system prompt.
//
// Uses SDK's parseFrontmatter() instead of custom regex parser for proper
// YAML parsing: multi-line values, lists, quote/escape handling.

import type { ParsedAgent, AgentFrontmatter } from "../config/types.ts";
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { buildAgentSystemPrompt } from "../config/shared-prompts.ts";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function parseAgentFile(filePath: string): ParsedAgent {
	const content = readFileSync(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter(content);

	const rawName = frontmatter.name;
	if (!rawName || typeof rawName !== "string") {
		throw new Error(`Agent file ${filePath} missing 'name' in frontmatter`);
	}

	const config: AgentFrontmatter = {
		name: rawName,
		description: frontmatter.description != null ? String(frontmatter.description) : undefined,
		tools: frontmatter.tools != null ? String(frontmatter.tools) : undefined,
		model: frontmatter.model != null ? String(frontmatter.model) : undefined,
		extensions: frontmatter.extensions != null ? String(frontmatter.extensions) : undefined,
		thinking: frontmatter.thinking != null ? String(frontmatter.thinking) : undefined,
		skills: frontmatter.skills != null ? String(frontmatter.skills) : undefined,
	};

	if (config.thinking && !VALID_THINKING_LEVELS.includes(config.thinking)) {
		throw new Error(
			`Invalid thinking level "${config.thinking}". Valid: ${VALID_THINKING_LEVELS.join(", ")}`,
		);
	}

	return { config, systemPrompt: buildAgentSystemPrompt(body, config.name) };
}
