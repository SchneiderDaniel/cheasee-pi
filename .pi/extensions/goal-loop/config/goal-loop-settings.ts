// ─── goalLoop settings: schema and loader ────────────────────────
// R6: the goal loop's limits come from `.pi/settings.json` under a project-level
// `goalLoop` key, validated before anything runs. Malformed JSON and a missing
// `goalLoop` key are distinct failures, so a maintainer reading the error knows
// which one it is.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { failure, type Result } from "../../shared/result.ts";

/** Default rollover threshold (tokens of active context). */
export const DEFAULT_CONTEXT_ROLLOVER_TOKENS = 150_000;

/** Default maximum completed work iterations (R7.AC1). */
export const DEFAULT_MAX_ITERATIONS = 50;

/** Pi's default response reserve (`compaction.reserveTokens`). */
export const DEFAULT_RESERVE_TOKENS = 16_384;

const SOURCE = "goalLoop";

/**
 * Project-level `goalLoop` settings. Numeric fields are positive integers: a
 * `0` or negative threshold would disable the rollover, and a fractional value
 * is not a token count.
 */
export const GoalLoopSettingsSchema = z.object({
	model: z.string().min(1),
	contextRolloverTokens: z.number().int().positive().default(DEFAULT_CONTEXT_ROLLOVER_TOKENS),
	maxIterations: z.number().int().positive().default(DEFAULT_MAX_ITERATIONS),
});

/** Validated `goalLoop` settings with defaults applied. */
export type GoalLoopSettings = z.infer<typeof GoalLoopSettingsSchema>;

/** Validated settings plus the response reserve they must fit alongside. */
export interface GoalLoopSettingsFile {
	settings: GoalLoopSettings;
	/** `compaction.reserveTokens` from the same settings source. */
	reserveTokens: number;
}

/** Render a zod failure with `goalLoop.`-prefixed field paths (R6.AC4). */
function formatIssues(error: z.ZodError): string {
	const parts = error.issues.map((issue) => {
		const path = issue.path.length > 0 ? `${SOURCE}.${issue.path.join(".")}` : SOURCE;
		return `${path}: ${issue.message}`;
	});
	return parts.join("; ");
}

/** Validate a raw `goalLoop` value. */
export function parseGoalLoopSettings(raw: unknown): Result<GoalLoopSettings> {
	const parsed = GoalLoopSettingsSchema.safeParse(raw);
	if (!parsed.success) return failure(formatIssues(parsed.error), SOURCE);
	return { ok: true, value: parsed.data };
}

/**
 * `compaction.reserveTokens`, defaulting to Pi's built-in 16384.
 *
 * An unusable value falls back to the default rather than silently treating the
 * reserve as zero, which would pass the capacity gate with no room left for a
 * response.
 */
function readReserveTokens(settings: Record<string, unknown>): number {
	const compaction = settings.compaction;
	if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction)) {
		return DEFAULT_RESERVE_TOKENS;
	}
	const value = (compaction as Record<string, unknown>).reserveTokens;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		return DEFAULT_RESERVE_TOKENS;
	}
	return value;
}

/** Read `goalLoop` plus `compaction.reserveTokens` from a settings file. */
export function loadGoalLoopSettings(settingsPath: string): Result<GoalLoopSettingsFile> {
	let text: string;
	try {
		text = readFileSync(settingsPath, "utf-8");
	} catch (err: unknown) {
		return failure(
			`cannot read settings file ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
			SOURCE,
		);
	}

	let settings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return failure(`${settingsPath} must contain a JSON object`, SOURCE);
		}
		settings = parsed as Record<string, unknown>;
	} catch (err: unknown) {
		return failure(
			`malformed JSON in ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
			SOURCE,
		);
	}

	if (!("goalLoop" in settings)) {
		return failure(`no "goalLoop" key in ${settingsPath}`, SOURCE);
	}
	const parsedSettings = parseGoalLoopSettings(settings.goalLoop);
	if (!parsedSettings.ok) return parsedSettings;

	return {
		ok: true,
		value: {
			settings: parsedSettings.value,
			reserveTokens: readReserveTokens(settings),
		},
	};
}
