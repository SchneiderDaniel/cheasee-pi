/**
 * llm-advisor.ts — LLM-powered advice generation + signal review
 *
 * Two LLM roles:
 * 1. Advice: takes WasteSignal[] → actionable advice for agent
 * 2. Reviewer: validates signal quality → keep/remove verdict + new signal ideas
 *
 * Pi-dependent: requires Model + ModelRegistry for API call.
 */

import type { SessionAnalysis, WasteSignal } from "./types.ts";

// ── System prompt options interface ──

/** Options from the system prompt configuration that can enrich advice. */
export interface SystemPromptOptions {
	selectedTools?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string; description: string; prompt: string }>;
}

// ── Types ──

export interface AdviceAction {
	action: string;
	expectedSavings: number;
	expectedSavingsLabel: string;
	effort: "Low" | "Medium" | "High";
	signal: string;
	code?: string;
}

export interface AdviceResult {
	sessionId: string;
	summary: string;
	actions: AdviceAction[];
	rawContent: string;
}

/** LLM verdict on a pure detector signal. */
export interface SignalVerdict {
	signal: string;
	label: string;
	verdict: "keep" | "remove" | "refine";
	reason: string;
	falsePositiveRisk: "low" | "medium" | "high";
	/** For refine: what to change */
	refinementSuggestion?: string;
}

/** LLM-proposed new detector. */
export interface NewSignalProposal {
	signal: string;
	label: string;
	description: string;
	reason: string;
	estimatedValue: string;
	detectionApproach: string;
}

/** Full LLM review of the detector suite. */
export interface SignalReview {
	verdicts: SignalVerdict[];
	newSignals: NewSignalProposal[];
	summary: string;
}

// ── Prompt templates ──

const ADVICE_SYSTEM_PROMPT = `You are a session advisor for a coding agent. Your job: analyze waste signals from a session and produce specific, actionable advice to reduce token waste and improve efficiency.

Each waste signal shows how many tokens were wasted (from actual LLM usage data — not estimates). Your advice must be concrete and implementable by the agent.

RULES:
1. Each action must be specific — "Use ripgrep_search instead of bash | grep" not "Be more efficient"
2. Expected savings should be realistic — base it on the wasted tokens shown
3. Effort: Low = simple habit change, Medium = needs tooling/config, High = needs code change
4. Code examples optional but helpful
5. If signal already handled by harness at runtime, note it but still suggest if agent keeps triggering it

OUTPUT FORMAT (JSON only, no markdown):
{
  "summary": "2-3 sentence summary of the main waste patterns",
  "actions": [
    {
      "action": "imperative description",
      "expectedSavings": <number>,
      "expectedSavingsLabel": "~X tokens (~Y% of session waste)",
      "effort": "Low|Medium|High",
      "signal": "signal-key",
      "code": "optional code snippet"
    }
  ]
}`;

const REVIEW_SYSTEM_PROMPT = `You are a signal reviewer for a coding agent analytics system. Your job: evaluate the quality of pure-function waste detectors by analyzing their output across real sessions.

Each detector produces WasteSignal objects with:
- signal: machine key
- label: human label
- wastedTokens: tokens wasted (from actual LLM usage data)
- occurrences: how many times it fired
- details: per-occurrence descriptions

EVALUATE each detector on:
1. Actionability — Can the agent actually do something about this? Or is it just informational noise?
2. False positive rate — Does it fire in situations where the behavior was actually correct?
3. Signal-to-noise ratio — Is the waste significant enough to warrant attention?
4. Duplication — Does this overlap with another detector?

OUTPUT FORMAT (JSON only, no markdown):
{
  "verdicts": [
    {
      "signal": "signal-key",
      "label": "human label",
      "verdict": "keep|remove|refine",
      "reason": "explanation",
      "falsePositiveRisk": "low|medium|high",
      "refinementSuggestion": "only if verdict=refine, explain what to change"
    }
  ],
  "newSignals": [
    {
      "signal": "proposed-signal-key",
      "label": "Proposed detector label",
      "description": "What it detects",
      "reason": "Why this would be valuable",
      "estimatedValue": "Expected waste savings per session",
      "detectionApproach": "How to implement (what to look for in session data)"
    }
  ],
  "summary": "2-3 sentence overall assessment of the detector suite"
}`;

// ── Prompt builders ──

function buildAdvicePrompt(
	analysis: SessionAnalysis,
	systemPromptOptions?: SystemPromptOptions,
): string {
	const lines: string[] = [];
	lines.push(`Session: ${analysis.sessionId}`);
	lines.push(`Total tokens: ${analysis.totalTokens.toLocaleString()}`);
	lines.push(
		`Total waste: ${analysis.totalWasteTokens.toLocaleString()} tokens (${(analysis.wasteFraction * 100).toFixed(0)}%)`,
	);
	lines.push(`Total cost: $${analysis.totalCost.toFixed(6)}`);
	lines.push(``);

	// Enrich with system prompt options if available
	if (systemPromptOptions) {
		lines.push(`### System Prompt Configuration`);
		lines.push(``);
		if (systemPromptOptions.selectedTools && systemPromptOptions.selectedTools.length > 0) {
			lines.push(`Active tools (${systemPromptOptions.selectedTools.length}):`);
			for (const tool of systemPromptOptions.selectedTools) {
				lines.push(`- ${tool}`);
			}
			lines.push(``);
		}
		if (systemPromptOptions.contextFiles && systemPromptOptions.contextFiles.length > 0) {
			lines.push(
				`Context files (${systemPromptOptions.contextFiles.length}): ${systemPromptOptions.contextFiles.map((f) => f.path).join(", ")}`,
			);
			lines.push(``);
		}
		if (systemPromptOptions.skills && systemPromptOptions.skills.length > 0) {
			lines.push(
				`Skills loaded (${systemPromptOptions.skills.length}): ${systemPromptOptions.skills.map((s) => s.name).join(", ")}`,
			);
			lines.push(``);
		}
	}

	lines.push(`Waste signals:`);
	lines.push(``);

	for (const s of analysis.wasteBySignal) {
		const pct =
			analysis.totalWasteTokens > 0
				? ` (${((s.wastedTokens / analysis.totalWasteTokens) * 100).toFixed(0)}% of waste)`
				: "";
		lines.push(`### ${s.label} [${s.signal}]`);
		lines.push(
			`Wasted: ${s.wastedTokens.toLocaleString()} tokens ($${s.wastedCost.toFixed(6)})${pct}`,
		);
		lines.push(`Occurrences: ${s.occurrences}`);
		for (const d of s.details) {
			lines.push(`- ${d}`);
		}
		lines.push(``);
	}

	return lines.join("\n");
}

function buildReviewPrompt(sessions: SessionAnalysis[]): string {
	const lines: string[] = [];
	lines.push(`Reviewing ${sessions.length} sessions.`);
	lines.push(``);

	// Aggregate signals across sessions
	const agg = new Map<
		string,
		{
			wastedTokens: number;
			wastedCost: number;
			occurrences: number;
			sessions: string[];
			details: string[];
			label: string;
		}
	>();
	for (const sa of sessions) {
		for (const s of sa.wasteBySignal) {
			if (!agg.has(s.signal))
				agg.set(s.signal, {
					...s,
					wastedTokens: 0,
					wastedCost: 0,
					occurrences: 0,
					sessions: [],
					details: [],
				});
			const a = agg.get(s.signal)!;
			a.wastedTokens += s.wastedTokens;
			a.wastedCost += s.wastedCost;
			a.occurrences += s.occurrences;
			if (!a.sessions.includes(sa.sessionId)) a.sessions.push(sa.sessionId);
			a.details.push(...s.details);
		}
	}

	lines.push(`## Aggregated Detector Output`);
	lines.push(``);
	lines.push(`| Detector | Total Waste | Sessions | Occurrences |`);
	lines.push(`|----------|-------------|----------|-------------|`);
	for (const [key, a] of [...agg.entries()].sort((a, b) => b[1].wastedTokens - a[1].wastedTokens)) {
		lines.push(
			`| ${key} | ${a.wastedTokens.toLocaleString()} | ${a.sessions.length}/${sessions.length} | ${a.occurrences} |`,
		);
	}
	lines.push(``);

	// Per-session detail
	lines.push(`## Per-Session Detail`);
	for (const sa of sessions) {
		lines.push(``);
		lines.push(`### Session ${sa.sessionId.slice(0, 8)}`);
		lines.push(
			`Tokens: ${sa.totalTokens.toLocaleString()} | Waste: ${sa.totalWasteTokens.toLocaleString()} (${(sa.wasteFraction * 100).toFixed(0)}%)`,
		);
		if (sa.wasteBySignal.length === 0) {
			lines.push(`No signals fired.`);
		} else {
			for (const s of sa.wasteBySignal) {
				lines.push(
					`- ${s.signal}: ${s.wastedTokens} tokens, ${s.occurrences}x — ${s.details[0] ?? ""}`,
				);
			}
		}
	}

	return lines.join("\n");
}

// ── Shared LLM caller ──

/** Minimal model interface (matches pi Model structurally). */
export interface ModelLike {
	id: string;
	api: string;
	provider: string;
	baseUrl: string;
	headers?: Record<string, string>;
}

/** Minimal model registry interface. */
export interface ModelRegistryLike {
	getApiKeyAndHeaders(
		model: ModelLike,
	): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

async function callLLM(
	model: ModelLike,
	modelRegistry: ModelRegistryLike,
	systemPrompt: string,
	userPrompt: string,
	signal?: AbortSignal,
	maxTokens: number = 2000,
): Promise<string> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(`Auth error for model ${model.provider}/${model.id}: ${auth.error}`);
	}

	const body = buildRequestBody(model, systemPrompt, userPrompt, maxTokens);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...auth.headers,
	};
	if (!headers["Authorization"] && auth.apiKey) {
		headers["Authorization"] = `Bearer ${auth.apiKey}`;
	}

	const baseUrl = model.baseUrl.replace(/\/+$/, "");
	const url = `${baseUrl}/chat/completions`;

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => "unknown");
		throw new Error(`LLM call failed (${response.status}): ${errText.slice(0, 500)}`);
	}

	const data = await response.json();
	const content = data.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error("LLM returned empty response");
	}
	return content;
}

// ── Public API ──

/**
 * Generate advice from waste signals (per-session).
 */
export async function generateAdvice(
	analysis: SessionAnalysis,
	model: ModelLike,
	modelRegistry: ModelRegistryLike,
	signal?: AbortSignal,
	systemPromptOptions?: SystemPromptOptions,
): Promise<AdviceResult> {
	const prompt = buildAdvicePrompt(analysis, systemPromptOptions);
	const content = await callLLM(model, modelRegistry, ADVICE_SYSTEM_PROMPT, prompt, signal);
	return parseAdviceResponse(content, analysis.sessionId);
}

/**
 * Review detector signal quality across sessions.
 * Returns verdicts on each detector (keep/remove/refine) and proposals for new detectors.
 */
export async function reviewSignals(
	sessions: SessionAnalysis[],
	model: ModelLike,
	modelRegistry: ModelRegistryLike,
	signal?: AbortSignal,
): Promise<SignalReview> {
	if (sessions.length === 0) {
		return { verdicts: [], newSignals: [], summary: "No sessions to review." };
	}
	const prompt = buildReviewPrompt(sessions);
	const content = await callLLM(model, modelRegistry, REVIEW_SYSTEM_PROMPT, prompt, signal, 3000);
	return parseReviewResponse(content);
}

/**
 * Generate advice for cross-session report.
 * Also includes signal review if enough sessions (>=3).
 */
export async function generateReportAdvice(
	sessions: SessionAnalysis[],
	model: ModelLike,
	modelRegistry: ModelRegistryLike,
	signal?: AbortSignal,
	systemPromptOptions?: SystemPromptOptions,
): Promise<{ reportMd: string; review?: SignalReview }> {
	const totalTokens = sessions.reduce((s, a) => s + a.totalTokens, 0);
	const totalWaste = sessions.reduce((s, a) => s + a.totalWasteTokens, 0);
	const totalCost = sessions.reduce((s, a) => s + a.totalCost, 0);

	const agg = new Map<
		string,
		{ wastedTokens: number; wastedCost: number; occurrences: number; sessions: string[] }
	>();
	for (const sa of sessions) {
		for (const s of sa.wasteBySignal) {
			const key = s.signal;
			if (!agg.has(key))
				agg.set(key, { wastedTokens: 0, wastedCost: 0, occurrences: 0, sessions: [] });
			const a = agg.get(key)!;
			a.wastedTokens += s.wastedTokens;
			a.wastedCost += s.wastedCost;
			a.occurrences += s.occurrences;
			if (!a.sessions.includes(sa.sessionId)) a.sessions.push(sa.sessionId);
		}
	}

	const aggLines: string[] = [];
	aggLines.push(`Total sessions: ${sessions.length}`);
	aggLines.push(`Total tokens: ${totalTokens.toLocaleString()}`);
	aggLines.push(
		`Total waste: ${totalWaste.toLocaleString()} tokens (${totalTokens > 0 ? ((totalWaste / totalTokens) * 100).toFixed(1) : 0}%)`,
	);
	aggLines.push(`Total cost: $${totalCost.toFixed(4)}`);
	aggLines.push(``);
	aggLines.push(`Aggregated signals:`);
	aggLines.push(``);

	const sorted = [...agg.entries()].sort((a, b) => b[1].wastedTokens - a[1].wastedTokens);
	for (const [signal, a] of sorted) {
		const pct = totalWaste > 0 ? ((a.wastedTokens / totalWaste) * 100).toFixed(0) : "0";
		aggLines.push(`### ${signal} — ${a.wastedTokens.toLocaleString()} tokens (${pct}%)`);
		aggLines.push(`Across ${a.sessions.length} sessions, ${a.occurrences} occurrences`);
		aggLines.push(``);
	}

	// Build system prompt options context if available
	let spoContext = "";
	if (systemPromptOptions) {
		const parts: string[] = [];
		if (systemPromptOptions.selectedTools && systemPromptOptions.selectedTools.length > 0) {
			parts.push(
				`Active tools (${systemPromptOptions.selectedTools.length}): ${systemPromptOptions.selectedTools.join(", ")}`,
			);
		}
		if (systemPromptOptions.contextFiles && systemPromptOptions.contextFiles.length > 0) {
			parts.push(
				`Context files (${systemPromptOptions.contextFiles.length}): ${systemPromptOptions.contextFiles.map((f) => f.path).join(", ")}`,
			);
		}
		if (systemPromptOptions.skills && systemPromptOptions.skills.length > 0) {
			parts.push(
				`Skills loaded (${systemPromptOptions.skills.length}): ${systemPromptOptions.skills.map((s) => s.name).join(", ")}`,
			);
		}
		if (parts.length > 0) {
			spoContext = `\n\nSystem Prompt Configuration:\n${parts.join("\n")}`;
		}
	}

	const prompt = `Produce a cross-session advice report. Analyze these aggregated waste signals across ${sessions.length} sessions and recommend top actions to reduce waste.${spoContext}\n\n${aggLines.join("\n")}`;
	const content = await callLLM(model, modelRegistry, ADVICE_SYSTEM_PROMPT, prompt, signal);

	// Also run signal review if >= 3 sessions
	let review: SignalReview | undefined;
	if (sessions.length >= 3) {
		try {
			review = await reviewSignals(sessions, model, modelRegistry, signal);
		} catch {
			// review is optional — don't fail report if review fails
		}
	}

	return { reportMd: content, review };
}

// ── Build request body ──

function buildRequestBody(
	model: ModelLike,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number = 2000,
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		model: model.id,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
		max_tokens: maxTokens,
		temperature: 0.3,
	};

	if (model.api === "anthropic-messages") {
		return {
			model: model.id,
			system: systemPrompt,
			messages: [{ role: "user", content: userPrompt }],
			max_tokens: maxTokens,
			temperature: 0.3,
		};
	}

	if (model.api === "google-generative-ai") {
		return {
			contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
			generationConfig: {
				maxOutputTokens: maxTokens,
				temperature: 0.3,
			},
		};
	}

	return base;
}

// ── Response parsers ──

function stripCodeFence(text: string): string {
	let s = text.trim();
	if (s.startsWith("```")) {
		s = s.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
	}
	return s.trim();
}

function parseAdviceResponse(content: string, sessionId: string): AdviceResult {
	try {
		const parsed = JSON.parse(stripCodeFence(content));
		return {
			sessionId,
			summary: parsed.summary ?? "No summary generated.",
			actions: (parsed.actions ?? []).map((a: Record<string, unknown>) => ({
				action: String(a.action ?? "Unknown action"),
				expectedSavings: Number(a.expectedSavings ?? 0),
				expectedSavingsLabel: String(a.expectedSavingsLabel ?? `~${a.expectedSavings ?? 0} tokens`),
				effort: (a.effort as "Low" | "Medium" | "High") ?? "Medium",
				signal: String(a.signal ?? "unknown"),
				code: a.code ? String(a.code) : undefined,
			})),
			rawContent: content,
		};
	} catch {
		return {
			sessionId,
			summary: content.slice(0, 300),
			actions: [],
			rawContent: content,
		};
	}
}

function parseReviewResponse(content: string): SignalReview {
	try {
		const parsed = JSON.parse(stripCodeFence(content));
		return {
			verdicts: (parsed.verdicts ?? []).map((v: Record<string, unknown>) => ({
				signal: String(v.signal ?? ""),
				label: String(v.label ?? ""),
				verdict: (v.verdict as "keep" | "remove" | "refine") ?? "keep",
				reason: String(v.reason ?? ""),
				falsePositiveRisk: (v.falsePositiveRisk as "low" | "medium" | "high") ?? "low",
				refinementSuggestion: v.refinementSuggestion ? String(v.refinementSuggestion) : undefined,
			})),
			newSignals: (parsed.newSignals ?? []).map((n: Record<string, unknown>) => ({
				signal: String(n.signal ?? ""),
				label: String(n.label ?? ""),
				description: String(n.description ?? ""),
				reason: String(n.reason ?? ""),
				estimatedValue: String(n.estimatedValue ?? ""),
				detectionApproach: String(n.detectionApproach ?? ""),
			})),
			summary: String(parsed.summary ?? ""),
		};
	} catch {
		return {
			verdicts: [],
			newSignals: [],
			summary: "Failed to parse LLM review response.",
		};
	}
}
