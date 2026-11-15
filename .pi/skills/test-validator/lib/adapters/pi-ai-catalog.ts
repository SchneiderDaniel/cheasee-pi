// Adapter: the pi-ai catalog and credential seam.
//
// Two startup concerns that must not leak into the judge prompt or the run:
// resolving a configured model id against the provider catalog, and proving the
// provider has a credential *before* the first call. Both are adapter work, so
// the use case only ever sees `ok`/`not ok` plus a message an operator can act
// on.

import { findEnvKeys, getEnvApiKey, getModel, getModels } from "@earendil-works/pi-ai/compat";

/** Outcome of the startup API-key precondition. */
export interface ApiKeyState {
	readonly ok: boolean;
	readonly envVars: readonly string[];
	readonly message: string;
}

/** Resolved chat model, or undefined when the id is not in the catalog. */
export type ModelResolver = (provider: string, modelId: string) => unknown;

/** Minimal shape this adapter needs from a resolved model. */
export interface ChatModel {
	readonly id: string;
}

/**
 * Providers whose key variable does not follow `<PROVIDER>_API_KEY`. Only a
 * hint for the operator-facing message — the authoritative check is
 * `getEnvApiKey`, which knows every provider.
 */
const ENV_VAR_HINTS: Readonly<Record<string, string>> = {
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	"google-vertex": "GOOGLE_CLOUD_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	"github-copilot": "COPILOT_GITHUB_TOKEN",
	huggingface: "HF_TOKEN",
};

function hintedEnvVar(provider: string): string {
	return ENV_VAR_HINTS[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Catalog lookup: `getModel` throws for unknown ids, so scan as a fallback. */
export function catalogResolver(provider: string, modelId: string): unknown {
	try {
		const direct = getModel(provider as never, modelId as never) as unknown;
		if (direct) return direct;
	} catch {
		// Unknown provider/model: fall through to the catalog scan.
	}
	try {
		const models = getModels(provider as never) as unknown;
		if (!Array.isArray(models)) return undefined;
		return (models as ChatModel[]).find((candidate) => candidate.id === modelId);
	} catch {
		return undefined;
	}
}

/**
 * Startup precondition: the provider must have an API key in the environment.
 * Called by the composition root *before* the first model call, so a missing key
 * halts the run instead of being recorded as thousands of pending tests.
 */
export function assertProviderApiKey(
	provider: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): ApiKeyState {
	const providerEnv = env as Record<string, string>;
	const key = getEnvApiKey(provider as never, providerEnv);
	if (typeof key === "string" && key !== "") {
		return { ok: true, envVars: [], message: `provider ${provider} has an API key` };
	}
	// `findEnvKeys` only reports variables that are *set*; with none set, fall
	// back to the conventional name so the message stays actionable.
	const found = findEnvKeys(provider as never, providerEnv) ?? [];
	const envVars = found.length > 0 ? found : [hintedEnvVar(provider)];
	return {
		ok: false,
		envVars,
		message:
			`missing API key for provider "${provider}": set ${envVars.join(" or ")} ` +
			`(getEnvApiKey("${provider}") found no usable credential)`,
	};
}
