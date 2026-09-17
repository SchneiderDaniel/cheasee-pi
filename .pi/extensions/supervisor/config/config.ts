// ─── Config: loading, validation, timeout resolution ──────────────

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────

/** Default agent timeout in milliseconds (30 minutes). */
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;

/**
 * Node's maximum `setTimeout` delay (`2^31 - 1` ms). Larger delays overflow to
 * a negative 32-bit signed value, which Node clamps to 1 ms — a configured
 * long timeout would fire immediately instead of at the requested duration
 * (audit finding #3). Values are rejected at the config boundary.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** Max `agentTimeoutSec`/`agentKillGraceSec` (seconds) without timer overflow. */
export const MAX_AGENT_TIMEOUT_SEC = Math.floor(MAX_TIMER_MS / 1000);

/** Max legacy `agentTimeoutsMin` (minutes) without timer overflow. */
export const MAX_AGENT_TIMEOUT_MIN = Math.floor(MAX_TIMER_MS / 60_000);

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
	defaultBranch: z.string().default("main"),
	remote: z.string().default("origin"),
	worktreeBase: z.string().default("../"),
	branchPrefix: z.string().default("worktree-git-issue-"),
	agentTimeoutsMin: z.record(z.string(), z.number()).optional(),
	// Canonical per-agent timeout in SECONDS; 0 = no timeout (legacy
	// agentTimeoutsMin is minutes and cannot express 0). Bare schema
	// (no .default()): the kill-grace default lives in the runner
	// (agent/runner/deadline.ts) so typed config fixtures stay untouched.
	agentTimeoutSec: z
		.record(
			z.string(),
			z.number().int().nonnegative().max(MAX_AGENT_TIMEOUT_SEC, {
				message: `supervisor.agentTimeoutSec values must be ≤ ${MAX_AGENT_TIMEOUT_SEC}s (Node timer limit)`,
			}),
		)
		.optional(),
	agentKillGraceSec: z.number().int().nonnegative().max(MAX_AGENT_TIMEOUT_SEC).optional(),
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

	// Post-parse: cross-field policy for per-agent timeouts (minutes + seconds)
	const knownAgents = Object.values(parsed.statusMapping) as string[];
	const agentTimeoutsMin = validateAgentTimeouts(parsed.agentTimeoutsMin, knownAgents);
	const agentTimeoutSec = validateAgentTimeoutSec(parsed.agentTimeoutSec, knownAgents);

	return {
		...parsed,
		agentTimeoutsMin,
		agentTimeoutSec,
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
 *   (fresh clones without the maintainer's host-side `../private-pi` clone
 *   are the expected state, not an anomaly).
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
		if (value > MAX_AGENT_TIMEOUT_MIN) {
			throw new Error(
				`agentTimeoutsMin.${key} must be ≤ ${MAX_AGENT_TIMEOUT_MIN} minutes (Node timer limit), got ${value}`,
			);
		}
		result[key] = value;
	}
	return result;
}

/**
 * Validate the raw agentTimeoutSec config value (seconds, 0 = no timeout).
 * Mirrors validateAgentTimeouts but accepts 0 — the whole point of the
 * seconds field is that a configured 0 means "no timeout", never the
 * 30-minute default. Unknown agent keys warn + skip (fail-open, same
 * conscious policy as the legacy minutes field).
 */
export function validateAgentTimeoutSec(
	raw: unknown,
	knownAgents: string[],
): Record<string, number> {
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		throw new Error(`agentTimeoutSec must be an object, got ${typeof raw}`);
	}
	const record = raw as Record<string, unknown>;
	const result: Record<string, number> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!knownAgents.includes(key)) {
			console.warn(`agentTimeoutSec: unknown agent "${key}" — entry ignored`);
			continue;
		}
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
			throw new Error(
				`agentTimeoutSec.${key} must be a non-negative integer, got ${JSON.stringify(value)}`,
			);
		}
		if (value > MAX_AGENT_TIMEOUT_SEC) {
			throw new Error(
				`agentTimeoutSec.${key} must be ≤ ${MAX_AGENT_TIMEOUT_SEC}s (Node timer limit), got ${value}`,
			);
		}
		result[key] = value;
	}
	return result;
}

/** Source of a resolved per-agent timeout policy. */
type TimeoutSource = "agentTimeoutSec" | "agentTimeoutsMin" | "default";

/** Resolved per-agent timeout policy. timeoutMs null = no timeout (0 configured). */
export interface TimeoutPolicy {
	timeoutMs: number | null;
	configuredSec: number | null;
	source: TimeoutSource;
}

/**
 * Resolve the per-agent timeout policy. Precedence:
 *   agentTimeoutSec[name] (explicit 0 → null = no timeout)
 *   → agentTimeoutsMin[name] (legacy alias, minutes, lower precedence)
 *   → DEFAULT_AGENT_TIMEOUT_MS (30 min)
 *
 * Unlike the old resolveTimeoutMs, a configured 0 cannot silently collapse
 * into the default: the Record lookups distinguish "absent" from "0".
 */
export function resolveTimeoutPolicy(
	agentName: string,
	config: Pick<SupervisorConfig, "agentTimeoutSec" | "agentTimeoutsMin">,
): TimeoutPolicy {
	const sec = config.agentTimeoutSec?.[agentName];
	if (sec !== undefined) {
		return {
			timeoutMs: sec === 0 ? null : sec * 1000,
			configuredSec: sec,
			source: "agentTimeoutSec",
		};
	}
	const min = config.agentTimeoutsMin?.[agentName];
	if (min !== undefined && Number.isInteger(min) && min > 0) {
		return { timeoutMs: min * 60_000, configuredSec: min * 60, source: "agentTimeoutsMin" };
	}
	return { timeoutMs: DEFAULT_AGENT_TIMEOUT_MS, configuredSec: null, source: "default" };
}
