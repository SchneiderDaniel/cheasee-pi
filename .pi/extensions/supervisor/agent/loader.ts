// ─── Agent Loader ──────────────────────────────────────────────────
// Parse .pi/extensions/supervisor/agents/*.md files (YAML frontmatter + system prompt body).
// Prepends shared tool discipline snippet to every agent's system prompt.

import type { ParsedAgent, AgentFrontmatter } from "../config/types.ts";
import { readFileSync } from "node:fs";
import { buildAgentSystemPrompt } from "../lib/shared-prompts.ts";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function parseAgentFile(filePath: string): ParsedAgent {
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		throw new Error(`Agent file ${filePath} missing YAML frontmatter`);
	}
	const config: AgentFrontmatter = { name: "" };
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
		if (kv) {
			let val = kv[2]!.trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			config[kv[1]!] = val;
		}
	}
	if (!config.name) throw new Error(`Agent file ${filePath} missing 'name'`);
	if (config.thinking && !VALID_THINKING_LEVELS.includes(config.thinking)) {
		throw new Error(
			`Invalid thinking level "${config.thinking}". Valid: ${VALID_THINKING_LEVELS.join(", ")}`,
		);
	}
	return { config, systemPrompt: buildAgentSystemPrompt(match[2]!.trim(), config.name) };
}
