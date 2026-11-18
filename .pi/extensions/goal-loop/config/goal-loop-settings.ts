// ─── goalLoop settings + model resolution ────────────────────────
// R6: the goal loop's model and limits come from `.pi/settings.json` under a
// project-level `goalLoop` key, validated before anything runs. The configured
// model is authoritative — there is deliberately NO fallback to the interactive
// session model (R6.AC2/R6.AC4), because a silent fallback would make a run
// unreproducible.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { failure, type Result } from "../../shared/result.ts";
import { parseModelRef, type ModelRef } from "../../shared/model/model-ref.ts";
import type { ModelResolver, ResolvedGoalModel } from "../application/ports.ts";

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
 * Read `goalLoop` (and `compaction.reserveTokens`) from a settings file.
 *
 * Malformed JSON and a missing `goalLoop` key are distinct failures, each
 * naming `goalLoop` — a maintainer reading the error knows which one it is.
 */
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

/**
 * `compaction.reserveTokens`, defaulting to Pi's built-in 16384. An unusable
 * value falls back to the default rather than silently treating the reserve as
 * zero (which would pass the capacity gate with no room left for a response).
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

/**
 * Parse the configured model reference and resolve it through the injected
 * resolver. The resolver is called with the configured string ONLY — a session
 * model is never substituted (R6.AC2).
 */
export function resolveGoalModel(
	configuredModel: string,
	resolve: ModelResolver,
): Result<ResolvedGoalModel> {
	let ref: ModelRef;
	try {
		ref = parseModelRef(configuredModel);
	} catch (err: unknown) {
		return failure(
			`goalLoop.model "${configuredModel}" is invalid: ${
				err instanceof Error ? err.message : String(err)
			}`,
			SOURCE,
		);
	}
	let resolved: ReturnType<ModelResolver>;
	try {
		resolved = resolve(ref.ref);
	} catch (err: unknown) {
		return failure(
			`goalLoop.model "${configuredModel}" could not be resolved: ${
				err instanceof Error ? err.message : String(err)
			}`,
			SOURCE,
		);
	}
	if (!resolved || !resolved.id) {
		return failure(`goalLoop.model "${configuredModel}" could not be resolved`, SOURCE);
	}
	return { ok: true, value: { ...resolved, ref: ref.ref } };
}

/**
 * Capacity gate (R5.AC1/R6.AC4): the configured rollover threshold plus Pi's
 * response reserve must fit the model's context window, otherwise the loop
 * would be forced to compact in place exactly when it must roll over.
 *
 * Boundary equality passes: `contextWindow === rolloverTokens + reserveTokens`
 * is accepted.
 */
export function checkModelCapacity(input: {
	modelRef: string;
	contextWindow: number;
	rolloverTokens: number;
	reserveTokens: number;
}): Result<void> {
	const required = input.rolloverTokens + input.reserveTokens;
	if (input.contextWindow >= required) return { ok: true, value: undefined };
	return failure(
		`goalLoop.contextRolloverTokens ${input.rolloverTokens} plus Pi's response reserve ` +
			`${input.reserveTokens} needs a context window of at least ${required} tokens, ` +
			`but model "${input.modelRef}" reports ${input.contextWindow}`,
		SOURCE,
	);
}

/**
 * Full pre-flight for one goal run: load settings, resolve the model, and check
 * capacity. Any failure refuses goal execution.
 */
export function prepareGoalLoopConfig(input: {
	settingsPath: string;
	resolve: ModelResolver;
}): Result<{ settings: GoalLoopSettings; model: ResolvedGoalModel }> {
	const loaded = loadGoalLoopSettings(input.settingsPath);
	if (!loaded.ok) return loaded;

	const resolved = resolveGoalModel(loaded.value.settings.model, input.resolve);
	if (!resolved.ok) return resolved;

	const capacity = checkModelCapacity({
		modelRef: resolved.value.ref,
		contextWindow: resolved.value.contextWindow,
		rolloverTokens: loaded.value.settings.contextRolloverTokens,
		reserveTokens: loaded.value.reserveTokens,
	});
	if (!capacity.ok) return capacity;

	return { ok: true, value: { settings: loaded.value.settings, model: resolved.value } };
}
