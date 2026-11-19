// ─── goalLoop pre-flight ─────────────────────────────────────────
// One entry point for the service's `loadConfig` port: load settings, resolve
// the configured model, then gate its context window. Any failure refuses goal
// execution (R6.AC4) — there is no partial configuration.

import type { GoalRuntimeConfig, ModelResolver } from "../application/ports.ts";
import type { Result } from "../../shared/result.ts";
import { loadGoalLoopSettings } from "./goal-loop-settings.ts";
import { checkModelCapacity, resolveGoalModel } from "./goal-model.ts";

/**
 * Full pre-flight for one goal run: load settings, resolve the model, check
 * capacity. Any failure refuses goal execution.
 */
export function prepareGoalLoopConfig(input: {
	settingsPath: string;
	resolve: ModelResolver;
}): Result<GoalRuntimeConfig> {
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
