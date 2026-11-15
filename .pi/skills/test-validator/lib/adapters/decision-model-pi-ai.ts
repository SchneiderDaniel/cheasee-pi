// Adapter: the pi-ai-backed decision model.
//
// One isolated, tool-less call per test with a fresh context — the "subagent"
// the issue asks for, without a session or a tool surface. The adapter builds
// the prompt, makes the call, and returns the model's raw text: parsing and the
// BAD gate belong to `decision.ts`, so a prose-wrapped answer reaches the parser
// verbatim and is rejected there. Catalog resolution and the credential
// precondition live in `pi-ai-catalog.ts`, the other file of this adapter.

import { completeSimple } from "@earendil-works/pi-ai/compat";

import { assistantText, buildDecisionPrompt } from "../decision-prompt.ts";
import type { DecisionModel } from "../ports.ts";
import type { DecisionRequest } from "../types.ts";
import { catalogResolver, type ChatModel, type ModelResolver } from "./pi-ai-catalog.ts";

export { assertProviderApiKey } from "./pi-ai-catalog.ts";
export { buildDecisionPrompt } from "../decision-prompt.ts";

/** The model call failed (transport, provider error, unresolvable model). */
export class DecisionModelError extends Error {
	readonly code = "DECISION_MODEL_FAILED";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "DecisionModelError";
	}
}

interface PiAiDecisionModelOptions {
	readonly provider: string;
	readonly model: string;
	/** Criteria markdown as written in `criteria.md`. */
	readonly criteriaText: string;
	readonly criteriaIds: readonly string[];
	/** Override catalog resolution (custom providers, tests). */
	readonly resolveModel?: ModelResolver;
}

interface ModelMessage {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly stopReason: string;
	readonly errorMessage?: string;
}

/** One call, no retries: the use case owns retry policy. */
async function callModel(
	model: ChatModel,
	prompt: string,
	request: DecisionRequest,
): Promise<ModelMessage> {
	try {
		return (await completeSimple(
			model as never,
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
				],
			},
			{},
		)) as unknown as ModelMessage;
	} catch (err) {
		throw new DecisionModelError(
			`model call failed for ${request.file}:${request.startLine}: ${
				err instanceof Error ? err.message : String(err)
			}`,
			{ cause: err },
		);
	}
}

/**
 * Create the pi-ai backed decision model. One call per `decide()`; no retries,
 * no parsing, no checkpoint awareness (the use case owns all three).
 */
export function createPiAiDecisionModel(options: PiAiDecisionModelOptions): DecisionModel {
	const resolveModel = options.resolveModel ?? catalogResolver;

	return {
		async decide(request: DecisionRequest): Promise<string> {
			const model = resolveModel(options.provider, options.model) as ChatModel | undefined;
			if (!model) {
				throw new DecisionModelError(
					`unknown model "${options.model}" for provider "${options.provider}"`,
				);
			}

			const prompt = buildDecisionPrompt(request, options.criteriaText, options.criteriaIds);
			const message = await callModel(model, prompt, request);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new DecisionModelError(
					`model call ended with ${message.stopReason}: ${message.errorMessage ?? "no error message"}`,
				);
			}

			return assistantText(message);
		},
	};
}
