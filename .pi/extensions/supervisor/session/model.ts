// ─── Session Model Resolution ────────────────────────────────────
// Model resolution from agent config string via ModelRegistry + AuthStorage.
// Extracted from agent-session-runner.ts to keep files modular.

import { resolveTools } from "../lib/extensions.ts";
import type { ParsedAgent } from "../config/types.ts";

// ─── Model Resolution ───────────────────────────────────────────────

/**
 * Parse a model string (e.g. "opencode-go/deepseek-v4-flash") into
 * provider and modelId components. Returns null if invalid.
 */
function resolveModelString(modelString: string): { provider: string; modelId: string } | null {
	if (!modelString || !modelString.trim()) return null;
	const parts = modelString.split("/");
	if (parts.length !== 2) return null;
	return { provider: parts[0]!, modelId: parts[1]! };
}

/**
 * Resolve a model from agent config via ModelRegistry + AuthStorage.
 * Falls back to first available model if the specified model is not found.
 */
export async function resolveModel(
	modelString: string,
): Promise<{ provider: string; modelId: string } | undefined> {
	const parsed = resolveModelString(modelString);
	if (!parsed) return undefined;

	try {
		const { ModelRegistry, AuthStorage } = await import("@earendil-works/pi-coding-agent");
		const authStorage = AuthStorage.create();
		const registry = ModelRegistry.create(authStorage);
		const model = registry.find(parsed.provider, parsed.modelId);
		if (model) return parsed;
	} catch {
		// Model not found or auth issue — fall back to first available
	}

	// Try to find first available model
	try {
		const { ModelRegistry, AuthStorage } = await import("@earendil-works/pi-coding-agent");
		const authStorage = AuthStorage.create();
		const registry = ModelRegistry.create(authStorage);
		const models = registry.getAll();
		if (models && models.length > 0) {
			const first = models[0];
			const id = first.id || "";
			const prov = first.provider || "";
			if (prov && id) return { provider: prov, modelId: id };
		}
	} catch {
		// No models available
	}

	return undefined;
}

// ─── Tool List Building ─────────────────────────────────────────────

/**
 * Build a deduplicated array of tool names from agent config.
 * Uses resolveTools from extensions module for consistency.
 */
export function buildToolList(agent: ParsedAgent, cwd: string): string[] {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const toolsStr = resolveTools(rawTools, agent.config.extensions, cwd);
	return toolsStr
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
