// ─── Config: loading, validation, timeout resolution ──────────────

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────

/** Default agent timeout in milliseconds (30 minutes). */
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;

// ─── Schema ─────────────────────────────────────────────────────────

/** Schema for supervisor settings from .pi/settings.json */
export const SupervisorConfigSchema = z.object({
	repo: z.string().min(1, { message: "supervisor.repo is required" }),
	projectNumber: z
		.number()
		.int({ message: "supervisor.projectNumber must be an integer" })
		.positive({ message: "supervisor.projectNumber must be a positive integer" }),
	statusField: z.string().default("Status"),
	statusMapping: z
		.record(z.string(), z.string())
		.refine((val) => Object.keys(val).length > 0, {
			message: "supervisor.statusMapping is required",
		}),
	maxRejections: z.number().int().nonnegative().default(3),
	codeowners: z
		.array(z.string())
		.nonempty({ message: "supervisor.codeowners must be a non-empty list" }),
	submodules: z.array(z.object({ path: z.string(), repo: z.string() })).optional(),
	defaultBranch: z.string().default("main"),
	remote: z.string().default("origin"),
	worktreeBase: z.string().default("../"),
	branchPrefix: z.string().default("worktree-git-issue-"),
	agentTimeoutsMin: z.record(z.string(), z.number()).optional(),
	ciGatingTimeoutSec: z.number().int().nonnegative().default(300),
	bellOnComplete: z.boolean().default(false),
	agentTokenBudget: z.number().int().nonnegative().optional(),
	maxToolCalls: z.number().int().nonnegative().optional(),
	enableExperimentalFeatures: z.boolean().default(false),
	auditScoreThreshold: z.number().min(0).max(1).default(0.75),
	vulnGateBlocking: z.boolean().default(false),
	vulnGateTimeoutSec: z.number().int().nonnegative().default(60),
});

/** Inferred config type from schema — fields with .default() are non-optional. */
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse .gitmodules into submodule entries. Only returns entries with GitHub URLs. */
function parseGitmodules(): Array<{ path: string; repo: string }> {
	const gitmodulesPath = ".gitmodules";
	if (!existsSync(gitmodulesPath)) return [];
	const content = readFileSync(gitmodulesPath, "utf-8");
	const subs: Array<{ path: string; repo: string }> = [];
	const sectionRe = /\[submodule\s+"(.+?)"\]/g;
	let match: RegExpExecArray | null;
	while ((match = sectionRe.exec(content)) !== null) {
		const name = match[1];
		const sectionStart = match.index + match[0].length;
		const nextSection = content.indexOf("[", sectionStart);
		const sectionBody =
			nextSection === -1 ? content.slice(sectionStart) : content.slice(sectionStart, nextSection);
		const pathMatch = sectionBody.match(/^\s*path\s*=\s*(.+)$/m);
		const urlMatch = sectionBody.match(/^\s*url\s*=\s*(.+)$/m);
		if (!pathMatch || !urlMatch) continue;
		const path = pathMatch[1].trim();
		const url = urlMatch[1].trim();
		const ghMatch = url.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/);
		if (!ghMatch) continue;
		const repo = `${ghMatch[1]}/${ghMatch[2]}`;
		subs.push({ path, repo });
	}
	return subs;
}

// ─── Config loading ──────────────────────────────────────────────────

export function loadConfig(): SupervisorConfig {
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) {
		throw new Error("No .pi/settings.json found. Add a 'supervisor' key.");
	}
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	const cfg = settings.supervisor;
	if (!cfg) throw new Error("No 'supervisor' key in .pi/settings.json.");

	// Schema-driven validation — replaces ~50 lines of manual if/throw checks
	const parsed = SupervisorConfigSchema.parse(cfg);

	// Post-parse: submodules fallback to .gitmodules
	const submodules =
		parsed.submodules && parsed.submodules.length > 0
			? parsed.submodules
			: parseGitmodules();

	// Post-parse: cross-field policy for agentTimeoutsMin
	const knownAgents = Object.values(parsed.statusMapping) as string[];
	const agentTimeoutsMin = validateAgentTimeouts(parsed.agentTimeoutsMin, knownAgents);

	return {
		...parsed,
		submodules,
		agentTimeoutsMin,
	};
}

// ─── Skill roots ──────────────────────────────────────────────────────

/**
 * Read the `skills` array from `.pi/settings.json` and return absolute
 * skill-root paths in declared order.
 *
 * - Pattern-prefixed entries (`!foo`, `+foo`, `-foo`) are SDK override
 *   patterns over auto-discovered skills, not roots — filtered out.
 * - Non-string / empty entries are ignored.
 * - Base dir rule: `../`-prefixed entries resolve against the settings dir
 *   (`<cwd>/.pi`), everything else against `cwd`. This makes both
 *   `.pi/skills` and `../private-pi/skills` land where the CLI loads them
 *   (`<repo>/.pi/skills` and `<repo>/private-pi/skills`).
 * - Fail-open: missing/unreadable settings or missing `skills` key → `[]`
 *   (worktrees stripped of submodule roots by init.go are the expected
 *   state, not an anomaly).
 */
export function loadSkillsRoots(cwd: string): string[] {
	const settingsPath = resolvePath(cwd, ".pi/settings.json");
	let settings: Record<string, unknown> | null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
		settings = (typeof parsed === "object" && parsed !== null ? parsed : null) as Record<
			string,
			unknown
		> | null;
	} catch {
		return [];
	}
	const entries = settings?.skills;
	if (!Array.isArray(entries)) return [];

	const settingsDir = resolvePath(cwd, ".pi");
	const roots: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || /^[!+-]/.test(trimmed)) continue;
		const base = trimmed.startsWith("..") ? settingsDir : cwd;
		roots.push(resolvePath(base, trimmed));
	}
	return roots;
}

// ─── Timeout validation ──────────────────────────────────────────────

/**
 * Validate the raw agentTimeoutsMin config value.
 * Returns a sanitized Record<string, number>.
 */
export function validateAgentTimeouts(raw: unknown, knownAgents: string[]): Record<string, number> {
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		throw new Error(`agentTimeoutsMin must be an object, got ${typeof raw}`);
	}
	const record = raw as Record<string, unknown>;
	const result: Record<string, number> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!knownAgents.includes(key)) {
			console.warn(`agentTimeoutsMin: unknown agent "${key}" — entry ignored`);
			continue;
		}
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			throw new Error(
				`agentTimeoutsMin.${key} must be a positive integer, got ${JSON.stringify(value)}`,
			);
		}
		result[key] = value;
	}
	return result;
}

/**
 * Resolve the timeout in milliseconds for a given agent.
 */
export function resolveTimeoutMs(
	agentName: string,
	agentTimeoutsMin: Record<string, number> | undefined,
	defaultMs: number = DEFAULT_AGENT_TIMEOUT_MS,
): number {
	if (!agentTimeoutsMin || typeof agentTimeoutsMin !== "object") {
		return defaultMs;
	}
	const minutes = agentTimeoutsMin[agentName];
	if (
		minutes !== undefined &&
		typeof minutes === "number" &&
		Number.isInteger(minutes) &&
		minutes > 0
	) {
		return minutes * 60_000;
	}
	return defaultMs;
}
