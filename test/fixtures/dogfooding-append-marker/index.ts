/**
 * Marker extension for the APPEND_SYSTEM.md global-availability test (#1517).
 *
 * In before_agent_start (fires BEFORE the LLM call — the container run passes
 * no API key, so the model call fails only AFTER this hook; pi's exit code is
 * tolerated, the hook is what the test counts), asserts that the assembled
 * prompt carries the global cheasee-pi operating instructions:
 *   - systemPromptOptions.appendSystemPrompt is non-empty and contains
 *     <tool_routing_matrix> + execution rule 5 (INVESTIGATION EFFICIENCY) —
 *     the instructions are present even in a non-cheasee-pi repo (bug fix:
 *     previously they lived only in the repo-scoped AGENTS.md)
 *   - <tool_routing_matrix> appears exactly once in the assembled systemPrompt
 *     (single-load invariant — the stub AGENTS.md has no matrix, the global
 *     append has it once; no double-load)
 *
 * Writes one line per before_agent_start to $APPEND_MARKER_LOG
 * (default /tmp/append-marker.log):
 *   `append:ok:<len>:<matrixCount>` or `append:bad:<facts...>`
 */
import { appendFileSync } from "node:fs";

export default function dogfoodingAppendMarker(pi: unknown): void {
	const api = pi as {
		on?: (
			event: string,
			handler: (event: {
				systemPrompt?: string;
				systemPromptOptions?: { appendSystemPrompt?: string };
			}) => void,
		) => void;
	};
	api.on?.("before_agent_start", (event) => {
		const append = event.systemPromptOptions?.appendSystemPrompt ?? "";
		const hasMatrix = append.includes("<tool_routing_matrix>");
		const hasRule5 = append.includes("INVESTIGATION EFFICIENCY");
		const matrixInPrompt = (event.systemPrompt?.match(/<tool_routing_matrix>/g) ?? []).length;
		const ok = append.length > 0 && hasMatrix && hasRule5 && matrixInPrompt === 1;
		const facts = `len=${append.length}:matrix=${hasMatrix}:rule5=${hasRule5}:promptMatrixCount=${matrixInPrompt}`;
		appendFileSync(
			process.env.APPEND_MARKER_LOG ?? "/tmp/append-marker.log",
			`append:${ok ? "ok" : "bad"}:${facts}\n`,
		);
	});
}
