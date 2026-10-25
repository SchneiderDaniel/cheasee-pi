// ─── JSON event kind table — streaming deltas (VBA god module split #2036) ───
// Split from normalize.ts: thinking/text start/delta/end extractors, including
// the pi 0.80.2 `assistantMessageEvent` shape and the legacy top-level wrapper.

import type { KindEntry } from "./normalize-types.ts";

export const deltaKindTable: Record<string, KindEntry> = {
	thinking_start: {
		json: () => ({ kind: "thinking_start" }),
	},

	thinking_delta: {
		json: (ev) => {
			const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent) {
				return { kind: "thinking_delta", delta: (assistantEvent.delta as string) || "" };
			}
			// Legacy: top-level delta wrapper
			const delta = ev.delta as Record<string, unknown> | undefined;
			return { kind: "thinking_delta", delta: (delta?.thinking_delta as string) || "" };
		},
	},

	thinking_end: {
		json: () => ({ kind: "thinking_end" }),
	},

	text_start: {
		json: () => ({ kind: "text_start" }),
	},

	text_delta: {
		json: (ev) => {
			const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent) {
				return { kind: "text_delta", delta: (assistantEvent.delta as string) || "" };
			}
			// Legacy: top-level delta wrapper
			const delta = ev.delta as Record<string, unknown> | undefined;
			return { kind: "text_delta", delta: (delta?.text_delta as string) || "" };
		},
	},

	text_end: {
		json: (ev) => {
			const assistantEvent = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent) {
				// Pi 0.80.2: usage inside assistantMessageEvent.partial.usage
				const partial = assistantEvent.partial as Record<string, unknown> | undefined;
				return { kind: "text_end", usage: (partial?.usage as any) || undefined };
			}
			// Legacy: top-level event
			return { kind: "text_end", usage: ev.usage as any };
		},
	},
};
