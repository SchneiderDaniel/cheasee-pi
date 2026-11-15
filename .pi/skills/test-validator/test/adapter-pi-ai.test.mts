// Phase 7a — the pi-ai adapter is a translation seam only: build the prompt,
// make one call, return the raw text. All policy lives in `decision.ts`.
// Uses a faux provider: no network, no credentials.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";

import {
	DecisionModelError,
	assertProviderApiKey,
	buildDecisionPrompt,
	createPiAiDecisionModel,
} from "../lib/adapters/decision-model-pi-ai.ts";
import type { DecisionRequest } from "../lib/types.ts";

const REQUEST: DecisionRequest = {
	file: "src/a.test.mts",
	name: "suite > b-bad",
	startLine: 5,
	endLine: 7,
	header: "suite",
	imports: 'import { describe, it } from "node:test";\nimport { thing } from "./thing.ts";',
	slice: ['\tit("b-bad", () => {', "\t\tassert.ok(true);", "\t});"].join("\n"),
};

const CRITERIA_TEXT = "# Criteria\n\n- C1 project-owned behaviour\n- C2 observable assertion\n";

function options(resolveModel?: () => unknown) {
	return {
		provider: "faux",
		model: "faux-1",
		criteriaText: CRITERIA_TEXT,
		criteriaIds: ["C1", "C2", "C3", "C4", "C5", "C6", "C7"],
		...(resolveModel ? { resolveModel: resolveModel as never } : {}),
	};
}

describe("adapter: pi-ai decision model", () => {
	it("returns the raw model text from a single call", async () => {
		const registration = registerFauxProvider();
		try {
			registration.setResponses([fauxAssistantMessage('{"decision":"GOOD","confidence":0.9}')]);
			const model = createPiAiDecisionModel(options(() => registration.getModel()));

			const raw = await model.decide(REQUEST);

			assert.equal(raw, '{"decision":"GOOD","confidence":0.9}');
			assert.equal(registration.state.callCount, 1);
		} finally {
			registration.unregister();
		}
	});

	it("passes prose and fenced answers through unmodified", async () => {
		const registration = registerFauxProvider();
		try {
			const answer = 'Sure!\n```json\n{"decision":"GOOD"}\n```\n';
			registration.setResponses([fauxAssistantMessage(answer)]);
			const model = createPiAiDecisionModel(options(() => registration.getModel()));

			assert.equal(await model.decide(REQUEST), answer);
		} finally {
			registration.unregister();
		}
	});

	it("surfaces a provider error as a failure", async () => {
		const registration = registerFauxProvider();
		try {
			registration.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
			]);
			const model = createPiAiDecisionModel(options(() => registration.getModel()));

			await assert.rejects(
				() => model.decide(REQUEST),
				(err: unknown) => {
					assert.ok(err instanceof DecisionModelError);
					assert.match(err.message, /provider exploded/);
					return true;
				},
			);
		} finally {
			registration.unregister();
		}
	});

	it("sends the slice, the describe header, and the file imports", async () => {
		const registration = registerFauxProvider();
		try {
			let prompt = "";
			registration.setResponses([
				(context) => {
					prompt = JSON.stringify(context);
					return fauxAssistantMessage('{"decision":"GOOD"}');
				},
			]);
			const model = createPiAiDecisionModel(options(() => registration.getModel()));

			await model.decide(REQUEST);

			assert.ok(prompt.includes("assert.ok(true);"), "slice must be in the prompt");
			assert.ok(prompt.includes("suite"), "describe header must be in the prompt");
			assert.ok(prompt.includes("./thing.ts"), "file imports must be in the prompt");
			assert.ok(prompt.includes("C1"), "criteria must be in the prompt");
		} finally {
			registration.unregister();
		}
	});

	it("does not leak other tests into the prompt", () => {
		const prompt = buildDecisionPrompt(REQUEST, CRITERIA_TEXT, ["C1", "C2"]);

		assert.ok(prompt.includes(REQUEST.slice));
		assert.equal(prompt.includes("c-good"), false);
		assert.match(prompt, /JSON/);
	});

	it("reports an unresolvable model instead of calling", async () => {
		const model = createPiAiDecisionModel(options(() => undefined));

		await assert.rejects(() => model.decide(REQUEST), DecisionModelError);
	});

	it("reports a missing provider key with the env var name", () => {
		const state = assertProviderApiKey("openai", {});

		assert.equal(state.ok, false);
		assert.deepEqual(state.envVars, ["OPENAI_API_KEY"]);
		assert.match(state.message, /OPENAI_API_KEY/);

		const configured = assertProviderApiKey("openai", { OPENAI_API_KEY: "sk-test" });
		assert.equal(configured.ok, true);
	});
});
