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
import type {
	CompactionEntry,
	CustomEntry,
	ModelChangeEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";

/** Open-ended member for on-disk blocks the parser passes through untyped. */
interface UnknownContentBlock {
	type: string;
	[key: string]: unknown;
}

/** Content block shapes consumed by the detail renderers. */
type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent | UnknownContentBlock;

/** Single narrowing site: filter content blocks by discriminant. */
function blocksOf<T extends ContentBlock["type"]>(
	content: ContentBlock[],
	type: T,
): Extract<ContentBlock, { type: T }>[] {
	return content.filter((c): c is Extract<ContentBlock, { type: T }> => c.type === type);
}

/** Supervisor `custom` entries carry `details`; upstream CustomEntry does not declare it. */
type SupervisorCustomEntry = CustomEntry & { details?: Record<string, unknown> };

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
 *
 * Module-private by design: only `renderCustomEntry` calls it, so the `export`
 * was dead (knip unused-export) and removed — see
 * test/session-logger-details-content-blocks.test.mts.
 */
function renderSupervisorDetails(details: Record<string, unknown>): string[] {
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
export function renderModelChangeEntry(entry: ModelChangeEntry): string[] {
	return [`> **Model:** \`${entry.provider}/${entry.modelId}\``, ``];
}

/** Pass-through `thinking_level_change` entry line. */
export function renderThinkingChangeEntry(entry: ThinkingLevelChangeEntry): string[] {
	return [`> **Thinking:** \`${entry.thinkingLevel}\``, ``];
}

/**
 * `custom` entry — supervisor entries with non-empty details expand to
 * renderSupervisorDetails; everything else falls through to a one-liner.
 */
export function renderCustomEntry(entry: SupervisorCustomEntry): string[] {
	if (
		entry.customType === "supervisor" &&
		entry.details &&
		typeof entry.details === "object" &&
		Object.keys(entry.details).length > 0
	) {
		return renderSupervisorDetails(entry.details);
	}
	const data = JSON.stringify(entry.data ?? {});
	return [`> *${entry.customType}* ${data !== "{}" ? `— ${data}` : ""}`, ``];
}

/** `compaction` entry line. */
export function renderCompactionEntry(entry: CompactionEntry): string[] {
	return [`> **Context compacted** — ${fmtTokens(entry.tokensBefore ?? 0)} tokens summarized`, ``];
}

/** Mutable turn bookkeeping shared by the conversation renderer and message renderers. */
export interface ConversationTurnState {
	turnIdx: number;
	inTurn: boolean;
}

function renderUserMessage(
	msg: UserMessage,
	content: ContentBlock[],
	turn: ConversationTurnState,
): string[] {
	const sections: string[] = [];

	// Close previous turn
	if (turn.inTurn) {
		sections.push(`---`);
		sections.push(``);
	}
	turn.turnIdx++;
	turn.inTurn = true;

	const texts = blocksOf(content, "text")
		.map((c) => c.text)
		.join("\n");
	sections.push(`### Turn ${turn.turnIdx} — User`);
	sections.push(``);
	sections.push(`${texts}`);
	sections.push(``);
	return sections;
}

function renderAssistantMessage(
	msg: AssistantMessage,
	content: ContentBlock[],
	turn: ConversationTurnState,
): string[] {
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
	const thinkBlocks = blocksOf(content, "thinking").map((c) => c.thinking);
	const textBlocks = blocksOf(content, "text").map((c) => c.text);
	const toolCalls = blocksOf(content, "toolCall");

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

function renderToolResultMessage(msg: ToolResultMessage, content: ContentBlock[]): string[] {
	const sections: string[] = [];

	const tn = msg.toolName ?? "?";
	const isErr = msg.isError ?? false;
	const resultText = blocksOf(content, "text")
		.map((c) => c.text)
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
export function renderMessageEntry(
	entry: SessionMessageEntry,
	turn: ConversationTurnState,
): string[] {
	const msg = entry.message;
	if (!msg) return [];

	if (msg.role === "user") {
		// UserMessage.content is `string | (TextContent | ImageContent)[]`; string
		// content is malformed and throws at the `.filter` in renderUserMessage,
		// which report.ts:119 catches. One boundary assertion at dispatch.
		return renderUserMessage(msg, (msg.content ?? []) as ContentBlock[], turn);
	}
	if (msg.role === "assistant") return renderAssistantMessage(msg, msg.content ?? [], turn);
	if (msg.role === "toolResult") return renderToolResultMessage(msg, msg.content ?? []);
	return [];
}
