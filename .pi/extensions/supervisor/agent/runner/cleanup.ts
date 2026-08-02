// ─── Result assembly + failure results ────────────────────────────
// Turns raw state + stdio into AgentRunResult. Also the designated home
// for a future spill-dir teardown (rmSync / tmp) once OS deferral is no
// longer acceptable.
// ponytail: temp file cleanup deferred to OS (/tmp cleanup on reboot).

import type { AgentRunResult, AgentRunState } from "../../config/types.ts";
import { pushLog } from "../state-helpers.ts";
import { formatDuration, extractSummaryLine } from "../../lib/formatting.ts";
import { filterStderr } from "../../event/adapter.ts";

/** Push trailing liveText/liveThinking into the output lines before assembly. */
export function finalizeState(state: AgentRunState): void {
	if (state.liveText.trim()) {
		state.textOutputLines.push(state.liveText.trim());
	}
	if (state.liveThinking.trim()) {
		state.thinkingOutputLines.push(state.liveThinking.trim());
	}
}

export function assembleResult(opts: {
	state: AgentRunState;
	agentName: string;
	startedAt: number;
	rawStdout: string;
	stderr: string;
	code: number | null;
	signal: string | null;
}): AgentRunResult {
	const durationMs = Date.now() - opts.startedAt;
	const textOutput = opts.state.fullLog.join("\n").trim();
	const textOnly = opts.state.textOutputLines.join("\n").trim();
	const rawOutput = opts.rawStdout + (opts.stderr ? "\n[STDERR]\n" + opts.stderr : "");
	const killed = opts.signal !== null;
	const success = opts.code === 0 && !killed;
	if (killed) {
		pushLog(
			opts.state,
			`[Timeout: ${opts.agentName} killed by ${opts.signal} after ${formatDuration(durationMs)}]`,
		);
	}

	const thinkingOutput =
		opts.state.thinkingOutputLines.length > 0
			? opts.state.thinkingOutputLines.join("\n\n")
			: undefined;

	const summaryLine = extractSummaryLine(
		textOutput,
		success,
		opts.agentName,
		new Set(opts.state.toolCalls),
	);

	return {
		output: rawOutput,
		success,
		agentName: opts.agentName,
		toolCount: opts.state.toolCount,
		thinkingLevel: opts.state.thinkingLevel,
		failedToolCount: opts.state.failedToolCount ?? undefined,
		tokenCount: opts.state.tokenCount,
		durationMs,
		textOutput,
		textOnly,
		summaryLine,
		errorOutput: filterStderr(opts.stderr),
		thinkingOutput,
		toolCalls: opts.state.toolCalls,
		budgetExceeded: opts.state.budgetExceeded || undefined,
	};
}

/**
 * Shared failure shape for the setup-guard, existsSync-guard, and
 * spawn-'error' paths — replaces three near-identical 20-line blocks.
 */
export function failResult(opts: {
	agentName: string;
	startedAt: number;
	errorMessage: string;
	summaryLine: string;
	output: string;
}): AgentRunResult {
	return {
		output: opts.output,
		success: false,
		agentName: opts.agentName,
		toolCount: 0,
		failedToolCount: undefined,
		tokenCount: 0,
		durationMs: Date.now() - opts.startedAt,
		textOutput: "",
		textOnly: "",
		summaryLine: opts.summaryLine,
		errorOutput: opts.errorMessage,
		budgetExceeded: undefined,
	};
}
