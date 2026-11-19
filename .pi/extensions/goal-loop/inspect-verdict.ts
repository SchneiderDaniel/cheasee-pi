// ─── Nested inspect verdict ─────────────────────────────────────
// R4.AC1: an `inspect` verifier is model judgement, so it must read only
// harness-produced evidence (never the record's stored claims) and must reply
// in a parseable shape. An unparseable reply fails closed.

import { readFileSync } from "node:fs";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InspectRunner, InspectVerdict } from "./adapters/goal-checks.ts";

/** The configured goal model ref, read fresh from the settings file. */
function catalogGoalModel(settingsPath: string): string {
	const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
	const goalLoop = (parsed as Record<string, unknown> | null)?.goalLoop;
	const model =
		typeof goalLoop === "object" && goalLoop !== null
			? (goalLoop as Record<string, unknown>).model
			: undefined;
	if (typeof model !== "string" || !model.trim()) {
		throw new Error(`no "goalLoop.model" in ${settingsPath}`);
	}
	return model;
}

/** Parse `{"pass":bool,"note":string}` out of a model reply. */
export function parseInspectVerdict(text: string): InspectVerdict | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.pass !== "boolean") return undefined;
		return { pass: record.pass, note: typeof record.note === "string" ? record.note : "" };
	} catch {
		return undefined;
	}
}

/** Collect every text delta a stream emits. */
async function readStream(stream: unknown): Promise<string> {
	let text = "";
	const events = stream as AsyncIterable<{ delta?: string; text?: string }>;
	for await (const event of events) {
		if (typeof event.delta === "string") text += event.delta;
		else if (typeof event.text === "string") text += event.text;
	}
	return text;
}

/** The inspect prompt: evidence first, verdict shape last. */
function buildInspectPrompt(instruction: string, evidence: string): string {
	return [
		"The evidence below was produced by the harness, not by the agent.",
		"Decide only from it.",
		"",
		`Criterion: ${instruction}`,
		"",
		evidence,
		"",
		'Reply with JSON only: {"pass": true|false, "note": "<short reason>"}',
	].join("\n");
}

/** Nested fresh-context judgement over harness-produced evidence (R4.AC1). */
export function createInspectRunner(
	ctx: ExtensionContext | ExtensionCommandContext,
	settingsPath: string,
): InspectRunner | undefined {
	const registry = ctx.modelRegistry;
	if (!registry || typeof registry.streamSimple !== "function") return undefined;

	return async (instruction, evidence) => {
		const ref = catalogGoalModel(settingsPath);
		const slash = ref.indexOf("/");
		const model = registry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (!model) throw new Error(`inspect verifier model "${ref}" is unavailable`);
		const stream = registry.streamSimple(model, {
			messages: [{ role: "user", content: buildInspectPrompt(instruction, evidence) }],
		} as never);
		const verdict = parseInspectVerdict(await readStream(stream));
		if (!verdict) throw new Error("inspect verifier returned no parseable verdict");
		return verdict;
	};
}
