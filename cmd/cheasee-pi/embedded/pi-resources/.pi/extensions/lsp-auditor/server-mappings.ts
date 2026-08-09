/**
 * Server mapping configuration for LSP Auditor.
 *
 * Pure config logic — zero I/O. Defines default LSP server mappings
 * and merges user settings with defaults.
 */

import type { ServerMapping } from "./types.ts";
import type { LspAuditorSettings } from "./settings.ts";

// ─── Defaults ────────────────────────────────────────────────────────

/** Default LSP server mappings baked into the extension.
 *  NOTE: TypeScript/JavaScript use `typescript-language-server --stdio`,
 *  NOT raw `tsserver` (which speaks a custom protocol, not LSP).
 */
export const DEFAULT_SERVER_MAPPINGS: ServerMapping[] = [
	{
		extensions: [".ts", ".tsx", ".js", ".jsx"],
		command: "typescript-language-server",
		args: ["--stdio"],
		severityThreshold: "warning",
	},
	{
		extensions: [".py"],
		command: "pyright-langserver",
		args: ["--stdio"],
		severityThreshold: "warning",
	},
	{ extensions: [".rs"], command: "rust-analyzer", args: [], severityThreshold: "warning" },
	{ extensions: [".go"], command: "gopls", args: [], severityThreshold: "warning" },
];

// ─── Builder ─────────────────────────────────────────────────────────

/**
 * Build the final server mapping list from user settings merged with defaults.
 * User config overrides/extends defaults.
 *
 * The input is already runtime-validated by readSettings() against the
 * typebox schema — no ad-hoc typeof/Array.isArray guards needed here.
 * Schema guarantees: extensions (string[], minItems 1), command (string, minLength 1),
 * args (string[] | undefined), severityThreshold (enum value | undefined).
 */
export function buildServerMappings(config: LspAuditorSettings | undefined): ServerMapping[] {
	if (!config?.servers?.length) return [...DEFAULT_SERVER_MAPPINGS];

	const merged = [...DEFAULT_SERVER_MAPPINGS];

	for (const srv of config.servers) {
		const exts = [...new Set(srv.extensions.map((e) => e.toLowerCase()))];

		const threshold: "error" | "warning" | "info" = srv.severityThreshold ?? "warning";

		const newMapping: ServerMapping = {
			extensions: exts,
			command: srv.command.trim(),
			args: srv.args ?? [],
			severityThreshold: threshold,
		};

		// Remove overlapping defaults
		const overlapExts = new Set(exts);
		for (let i = merged.length - 1; i >= 0; i--) {
			if (merged[i]!.extensions.some((e) => overlapExts.has(e.toLowerCase()))) {
				merged.splice(i, 1);
			}
		}

		merged.push(newMapping);
	}

	return merged;
}
