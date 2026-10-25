// ── Cascade advice table ────────────────────────────────────────
// The suggestion appended to a same-tool cascade block. Split out of
// agent-harness.ts (issue #2033).

const BATCH_ADVICE: Record<string, string | ((cmd: string) => string)> = {
	bash: (cmd: string) =>
		cmd.includes("&&")
			? "Reduce per-turn call count — commands already use && for batching"
			: "Combine bash calls with && or use a script file",
	read: "Batch reads — read larger portions in one call",
};

const defaultAdvice = (t: string) => `Batch ${t} calls to reduce turns`;

/** Suggestion text for a cascade block on `toolName`. */
export function cascadeSuggestion(toolName: string, command: string): string {
	const entry = BATCH_ADVICE[toolName];
	return typeof entry === "function" ? entry(command) : (entry ?? defaultAdvice(toolName));
}
