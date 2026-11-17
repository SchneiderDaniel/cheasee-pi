/**
 * Streaming token-estimate policy for the context-info footer (issue #2136).
 *
 * Pure: no pi, no TUI, no formatting, no clock. The footer renderer turns the
 * returned count into a rate; `FooterState.sampleTps` puts it on the timeline.
 *
 * ── Why the estimate is content-derived ────────────────────────
 * The old sampler read `assistantMessageEvent.partial.usage.output`. Providers
 * that only populate output usage when a response completes left that number
 * frozen at 0 for the whole stream, so the rolling estimator had a zero token
 * delta and the footer showed `-- t/s` from first token to last.
 *
 * Streamed `message.content` always grows while the model generates, so
 * counting its characters gives a monotonically increasing proxy. Four
 * characters per token is the usual English approximation; it over- and
 * under-counts for code, JSON and non-Latin scripts, which is exactly why the
 * footer marks the value with `~`.
 *
 * The estimate deliberately ignores `usage` entirely: mixing provider output
 * counts into the same window would make the rate jump whenever a provider
 * flushed a partial completion count.
 */

/** Characters per token. Coarse on purpose — tokenizers are too heavy for a display metric. */
const CHARS_PER_TOKEN = 4;

/** The slice of `pi-ai`'s `AssistantMessage` this policy reads. Untrusted. */
export interface StreamedMessage {
	content?: unknown;
}

/**
 * Estimated output tokens streamed so far, or 0 when nothing countable is
 * present. Never throws: a partially built message can have content blocks
 * without their payload yet.
 */
export function estimateStreamedTokens(message: StreamedMessage | null | undefined): number {
	if (message === null || message === undefined || typeof message !== "object") return 0;

	const content = message.content;
	if (!Array.isArray(content)) return 0;

	let chars = 0;
	for (const block of content) {
		chars += countBlockChars(block);
	}

	if (chars <= 0) return 0;
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Characters contributed by one content block; 0 for anything unreadable. */
function countBlockChars(block: unknown): number {
	if (block === null || typeof block !== "object") return 0;
	const candidate = block as {
		type?: unknown;
		text?: unknown;
		thinking?: unknown;
		arguments?: unknown;
	};

	switch (candidate.type) {
		case "text":
			return typeof candidate.text === "string" ? candidate.text.length : 0;
		case "thinking":
			return typeof candidate.thinking === "string" ? candidate.thinking.length : 0;
		case "toolCall":
			return countArgumentsChars(candidate.arguments);
		default:
			return 0;
	}
}

/** Tool-call arguments are streamed as JSON, so measure their encoded size. */
function countArgumentsChars(args: unknown): number {
	if (args === null || args === undefined) return 0;
	try {
		const encoded = JSON.stringify(args);
		return typeof encoded === "string" ? encoded.length : 0;
	} catch {
		// Circular or BigInt-containing arguments: not measurable, count nothing
		// rather than letting a display metric tear down the event handler.
		return 0;
	}
}
