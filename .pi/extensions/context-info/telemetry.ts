/**
 * Telemetry emission for context-info extension
 *
 * Emits JSON telemetry on first assistant response.
 */

function isJsonMode(): boolean {
	const idx = process.argv.indexOf("--mode");
	if (idx !== -1 && idx + 1 < process.argv.length) {
		return process.argv[idx + 1] === "json";
	}
	return false;
}

export function tryEmit(
	ctx: { getContextUsage: () => { tokens?: number | null; contextWindow?: number } | undefined },
	state: {
		emitted: boolean;
		footerConfig: { lastContextWindow: { value: number | undefined } };
	},
): void {
	if (state.emitted) return;
	const cw = state.footerConfig.lastContextWindow.value;
	if (!cw || cw <= 0) return;
	const usage = ctx.getContextUsage();
	if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) return;
	state.emitted = true;
	if (isJsonMode()) return;
	console.log(
		JSON.stringify({
			type: "context_info",
			contextTokens: usage.tokens,
			contextWindow: cw,
		}),
	);
}
