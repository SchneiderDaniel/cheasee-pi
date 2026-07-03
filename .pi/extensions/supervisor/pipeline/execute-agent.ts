// ─── Execute Agent ────────────────────────────────────────────────
// Promoted subprocess path: calls runAgentSubprocess directly,
// followed by replaySessionFile for persistent chat message.
// Removed in-process subagent tool dispatch and onUpdate delta dispatch.

import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, AgentRunner, ParsedAgent } from "../config/types.ts";
import { runAgent } from "../agent/runner.ts";
import { convertAgentRunToToolResult } from "../session/result.ts";
import { replaySessionFile } from "./replay-session.ts";
import { detectThinkingLevelMismatch } from "./thinking-mismatch.ts";

// ─── executeAgent — primary subprocess execution ───────────────────
// Signature unchanged for backward compatibility with handler.ts callers.

export async function executeAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	timeoutMs: number,
	agentCwd: string | undefined,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	issueTitle?: string,
	// ponytail: test hook for injecting mock runner; external callers omit this
	runner?: AgentRunner,
): Promise<{ result: AgentRunResult }> {
	const agentName = agent.config.name;

	// ── 1. Send start message ──────────────────────────────────
	const taskPreview = issueTitle || task.split("\n")[0]?.slice(0, 120) || "";
	pi.sendMessage({
		customType: "supervisor",
		content: `subagent ${agentName} — ${taskPreview}`,
		display: true,
		details: { eventType: "phase-change", agentName, phase: "starting" },
	});

	// ── 2. Generate session path for replay ─────────────────────
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-session-"));
	const sessionPath = join(sessionDir, `${agentName}-${Date.now()}.jsonl`);

	// ── 3. Run subprocess (handles widget lifecycle internally) ──
	const result = await (runner ?? runAgent)(
		agent,
		task,
		ctx,
		timeoutMs,
		agentCwd,
		maxToolCalls,
		agentTokenBudget,
		sessionPath,
		pi,
	);

	// ── 4. Replay session file for persistent chat message ───────
	if (result.success) {
		await replaySessionFile(sessionPath, pi, agentName);

		// ── 4a. Detect thinking level mismatch ──────────────────
		const mismatch = detectThinkingLevelMismatch(sessionPath, agent.config.thinking);
		if (mismatch) {
			const msg = `Agent '${agentName}' configured thinking=${mismatch.configured} but model clamps to ${mismatch.effective}. Running at thinking=${mismatch.effective}.`;
			console.warn(`[${agentName}] Warning: ${msg}`);
			pi.sendMessage({
				customType: "supervisor",
				content: `⚠️ ${msg}`,
				display: true,
				details: {
					eventType: "thinking-mismatch",
					agentName,
					configured: mismatch.configured,
					effective: mismatch.effective,
				},
			});
		}
	}

	// ── 5. Send final result message ────────────────────────────
	const finalStatus = result.success ? "✅" : result.budgetExceeded ? "⚠" : "❌";
	const statusLabel = result.success
		? "SUCCESS"
		: result.budgetExceeded
			? "BUDGET_EXCEEDED"
			: "FAILED";
	const toolResult = convertAgentRunToToolResult(result, task);
	pi.sendMessage({
		customType: "supervisor",
		content: `${finalStatus} ${agentName} — ${statusLabel}\n\n${result.summaryLine || ""}`,
		display: true,
		details: {
			eventType: "subagent-result",
			agentName,
			content: toolResult.content,
			details: toolResult.details,
		},
	});

	// ── 6. Return result ────────────────────────────────────────
	return { result };
}
