/**
 * renderer/details.ts — per-entry / per-role Markdown detail rendering.
 *
 * Extracted from the renderSessionToMarkdown conversation loop in
 * renderer.ts. Each renderer returns the exact lines the original loop
 * pushed, preserving byte-identical output (golden-characterized).
 */

import {
	escMd,
	fmtCost,
	fmtDuration,
	fmtTokens,
	resultPreview,
	THINKING_PREVIEW_CHARS,
	truncate,
} from "./format.ts";

/**
 * Render sub-agent details from a supervisor custom message.
 *
 * Expects `details` shape:
 * {
 *   agentName?: string;
 *   statusLabel?: string;
 *   toolCount?: number;
 *   tokenCount?: number;
 *   durationMs?: number;
 *   thinkingOutput?: string;
 *   hasThinking?: boolean;
 *   textOutput?: string;
 *   rawOutput?: string;
 *   hasRawOutput?: boolean;
 *   auditScore?: number;
 * }
 *
 * All fields optional — degrades gracefully via `?.` optional chaining.
 */
export function renderSupervisorDetails(details: Record<string, unknown>): string[] {
	const lines: string[] = [];

	const agentName = details?.agentName ?? "unknown-agent";
	const statusLabel = details?.statusLabel ?? "";
	const toolCount = details?.toolCount;
	const tokenCount = details?.tokenCount;
	const durationMs = details?.durationMs;
	const thinkingOutput = details?.thinkingOutput;
	const hasThinking = details?.hasThinking;
	const textOutput = details?.textOutput;
	const rawOutput = details?.rawOutput;
	const hasRawOutput = details?.hasRawOutput;
	const auditScore = details?.auditScore;

	// Agent header
	const statusPart = statusLabel ? ` -- ${statusLabel}` : "";
	lines.push(`### Agent: ${agentName}${statusPart}`);

	// Stats line
	const stats: string[] = [];
	if (toolCount != null) stats.push(`${toolCount} tools`);
	if (tokenCount != null) stats.push(`${fmtTokens(tokenCount as number)} tokens`);
	if (durationMs != null) stats.push(fmtDuration(durationMs as number));
	if (stats.length > 0) {
		lines.push(``);
		lines.push(stats.join(", "));
	}

	// Thinking blocks
	if (
		hasThinking &&
		thinkingOutput &&
		typeof thinkingOutput === "string" &&
		thinkingOutput.trim()
	) {
		lines.push(``);
		lines.push(`Thinking:`);
		for (const para of thinkingOutput.split("\n")) {
			lines.push(`  ${para}`);
		}
	}

	// Tool calls and results (textOutput)
	if (textOutput && typeof textOutput === "string" && textOutput.trim()) {
		lines.push(``);
		for (const line of textOutput.split("\n")) {
			lines.push(`  ${line}`);
		}
	}

	// Raw output — collapsed section
	if (hasRawOutput && rawOutput && typeof rawOutput === "string" && rawOutput.trim()) {
		lines.push(``);
		lines.push(`<details>`);
		lines.push(`<summary>Raw output (collapsed)</summary>`);
		lines.push(``);
		lines.push("```");
		lines.push(rawOutput);
		lines.push("```");
		lines.push(`</details>`);
	}

	// Audit score
	if (auditScore != null) {
		lines.push(``);
		lines.push(`Audit score: ${auditScore}`);
	}

	lines.push(``);
	return lines;
}

/** Pass-through `model_change` entry line. */
export function renderModelChangeEntry(entry: any): string[] {
	return [`> **Model:** \`${entry.provider}/${entry.modelId}\``, ``];
}

/** Pass-through `thinking_level_change` entry line. */
export function renderThinkingChangeEntry(entry: any): string[] {
	return [`> **Thinking:** \`${entry.thinkingLevel}\``, ``];
}

/**
 * `custom` entry — supervisor entries with non-empty details expand to
 * renderSupervisorDetails; everything else falls through to a one-liner.
 */
export function renderCustomEntry(entry: any): string[] {
	if (
		entry.customType === "supervisor" &&
		entry.details &&
		typeof entry.details === "object" &&
		Object.keys(entry.details as Record<string, unknown>).length > 0
	) {
		return renderSupervisorDetails(entry.details as Record<string, unknown>);
	}
	const data = JSON.stringify(entry.data ?? {});
	return [`> *${entry.customType}* ${data !== "{}" ? `— ${data}` : ""}`, ``];
}

/** `compaction` entry line. */
export function renderCompactionEntry(entry: any): string[] {
	return [`> **Context compacted** — ${fmtTokens(entry.tokensBefore ?? 0)} tokens summarized`, ``];
}

/** Mutable turn bookkeeping shared by the conversation renderer and message renderers. */
export interface ConversationTurnState {
	turnIdx: number;
	inTurn: boolean;
}

function renderUserMessage(msg: any, content: any[], turn: ConversationTurnState): string[] {
	const sections: string[] = [];

	// Close previous turn
	if (turn.inTurn) {
		sections.push(`---`);
		sections.push(``);
	}
	turn.turnIdx++;
	turn.inTurn = true;

	const texts = content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
	sections.push(`### Turn ${turn.turnIdx} — User`);
	sections.push(``);
	sections.push(`${texts}`);
	sections.push(``);
	return sections;
}

function renderAssistantMessage(msg: any, content: any[], turn: ConversationTurnState): string[] {
	const sections: string[] = [];

	if (!turn.inTurn) {
		turn.turnIdx++;
		turn.inTurn = true;
		sections.push(`### Turn ${turn.turnIdx} — Assistant`);
		sections.push(``);
	}

	const usage = msg.usage ?? {};
	const toks = usage.totalTokens ?? 0;
	const cost = usage.cost?.total;
	const stop = msg.stopReason ?? "";

	// Metadata line
	const metaParts: string[] = [];
	if (toks) metaParts.push(`tokens=${fmtTokens(toks)}`);
	if (cost) metaParts.push(`cost=${fmtCost(cost)}`);
	if (stop) metaParts.push(`stop=\`${stop}\``);

	// Extract parts
	const thinkBlocks = content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking);
	const textBlocks = content.filter((c: any) => c.type === "text").map((c: any) => c.text);
	const toolCalls = content.filter((c: any) => c.type === "toolCall");

	const thinkTotal = thinkBlocks.reduce((s: number, t: string) => s + t.length, 0);

	if (metaParts.length || thinkTotal) {
		const line = metaParts.join(", ");
		sections.push(`*${line}*`);
		sections.push(``);
	}

	// Thinking — collapsed
	if (thinkTotal > 0) {
		const firstLine = thinkBlocks[0].split("\n")[0].slice(0, THINKING_PREVIEW_CHARS);
		sections.push(`> 💭 ${firstLine}`);
		if (thinkTotal > THINKING_PREVIEW_CHARS) {
			sections.push(`> *(…${fmtTokens(thinkTotal)} chars thinking)*`);
		}
		sections.push(``);
	}

	// Text blocks
	for (const txt of textBlocks) {
		if (txt.trim()) {
			sections.push(txt.trim());
			sections.push(``);
		}
	}

	// Tool calls — inline
	for (const tc of toolCalls) {
		const tName = tc.name ?? "?";
		const args = tc.arguments ?? {};
		let argStr = "";
		if (typeof args === "object") {
			const parts: string[] = [];
			for (const [k, v] of Object.entries(args)) {
				const vStr = typeof v === "string" ? truncate(v, 80) : JSON.stringify(v);
				parts.push(`${k}=\`${escMd(vStr)}\``);
			}
			argStr = parts.join(", ");
		} else {
			argStr = truncate(String(args), 120);
		}
		sections.push(`- 🔧 \`${tName}(${argStr})\``);
	}
	if (toolCalls.length > 0) sections.push(``);
	return sections;
}

function renderToolResultMessage(msg: any, content: any[]): string[] {
	const sections: string[] = [];

	const tn = msg.toolName ?? "?";
	const isErr = msg.isError ?? false;
	const resultText = content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
	const errMark = isErr ? " ⚠️" : "";
	const sizeLabel = fmtTokens(resultText.length);

	sections.push(`  📥 \`${tn}\`${errMark} — ${sizeLabel}`);
	if (isErr) {
		sections.push(`  \`\`\``);
		sections.push(`  ${truncate(resultText, 300)}`);
		sections.push(`  \`\`\``);
	} else if (resultText.length > 0) {
		const preview = resultPreview(resultText);
		if (preview.includes("\n")) {
			sections.push(`  \`\`\``);
			for (const line of preview.split("\n")) {
				sections.push(`  ${line}`);
			}
			sections.push(`  \`\`\``);
		} else {
			sections.push(`  \`${truncate(escMd(resultText), 200)}\``);
		}
	}
	sections.push(``);
	return sections;
}

/**
 * `message` entry dispatcher — user / assistant / toolResult roles.
 * Unknown roles render nothing (no crash).
 */
export function renderMessageEntry(entry: any, turn: ConversationTurnState): string[] {
	const msg = entry.message ?? {};
	const role = msg.role ?? "?";
	const content = msg.content ?? [];

	if (role === "user") return renderUserMessage(msg, content, turn);
	if (role === "assistant") return renderAssistantMessage(msg, content, turn);
	if (role === "toolResult") return renderToolResultMessage(msg, content);
	return [];
}
