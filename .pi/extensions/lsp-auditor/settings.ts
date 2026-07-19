/**
 * Settings loader for LSP Auditor.
 *
 * Sync I/O (readFileSync/existsSync) acceptable — only called once per
 * audit start, not on hot path.
 *
 * Uses typebox schema for runtime validation at the config boundary.
 * This is the outermost adapter: depends on node:fs and typebox.
 * Returns validated domain shapes to all inner consumers.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// ─── Schema ──────────────────────────────────────────────────────────

/** Schema for a single LSP server entry. Enforces types at runtime. */
const ServerEntrySchema = Type.Object({
	extensions: Type.Array(Type.String(), { minItems: 1 }),
	command: Type.String({ minLength: 1 }),
	args: Type.Optional(Type.Array(Type.String())),
	severityThreshold: Type.Optional(
		Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
	),
});

/** Schema for the full lspAuditor settings block. */
const LspAuditorSettingsSchema = Type.Object({
	servers: Type.Optional(Type.Array(ServerEntrySchema)),
});

// ─── Types ───────────────────────────────────────────────────────────

/** Runtime-validated LSP auditor settings type, derived from schema. */
export type LspAuditorSettings = Static<typeof LspAuditorSettingsSchema>;

export interface PiSettings {
	supervisor?: unknown;
	lspAuditor?: LspAuditorSettings;
}

// ─── Reader ──────────────────────────────────────────────────────────

/**
 * Read and parse .pi/settings.json from the worktree.
 * Returns null if file doesn't exist or is unparseable.
 *
 * Validates the lspAuditor block at load time: malformed server entries
 * are filtered out with console.warn, and structurally invalid lspAuditor
 * values (non-object types) are dropped silently. Never throws for
 * config shape issues — always returns a safe shape or null.
 */
export function readSettings(worktreePath: string): PiSettings | null {
	try {
		const settingsPath = resolvePath(worktreePath, ".pi/settings.json");
		if (!existsSync(settingsPath)) return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const parsed: any = JSON.parse(readFileSync(settingsPath, "utf-8"));

		if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "lspAuditor" in parsed) {
			const la = parsed.lspAuditor;
			if (la && typeof la === "object" && !Array.isArray(la)) {
				if ("servers" in la && Array.isArray(la.servers)) {
					const validServers: unknown[] = [];
					for (const srv of la.servers) {
						if (Value.Check(ServerEntrySchema, srv)) {
							validServers.push(srv);
						} else {
							console.warn(
								`[lsp-auditor] Dropped malformed server entry: ${JSON.stringify(srv)}`,
							);
						}
					}
					parsed.lspAuditor = { servers: validServers };
				}
				// If no "servers" key, keep lspAuditor as-is (empty object is valid per schema)
			} else {
				console.warn("[lsp-auditor] lspAuditor settings ignored: not a valid object");
				delete parsed.lspAuditor;
			}
		}

		return parsed as PiSettings;
	} catch {
		return null;
	}
}
