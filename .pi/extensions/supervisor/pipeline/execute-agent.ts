// ─── Execute Agent ────────────────────────────────────────────────
// Promoted subprocess path: calls runAgentSubprocess directly,
// followed by replaySessionFile for persistent chat message.
// Removed in-process subagent tool dispatch and onUpdate delta dispatch.

import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, ParsedAgent } from "../config/types.ts";
import { runAgentSubprocess } from "../agent/runner.ts";
import { convertAgentRunToToolResult } from "../session/result.ts";
import { validateAgentResult } from "./output.ts";
import { replaySessionFile } from "./replay-session.ts";

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
	runner?: typeof runAgentSubprocess,
): Promise<{ result: AgentRunResult; usedRetry: boolean }> {
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
	const result = await (runner ?? runAgentSubprocess)(
		agent,
		task,
		ctx,
		timeoutMs,
		agentCwd,
		maxToolCalls,
		agentTokenBudget,
		sessionPath,
	);

	// ── 4. Replay session file for persistent chat message ───────
	if (result.success) {
		await replaySessionFile(sessionPath, pi, agentName);
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

	// ── 6. Validate and return ──────────────────────────────────
	validateAgentResult(result);

	// Budget exceeded notification
	if (result.budgetExceeded) {
		ctx.ui.notify(`Agent ${agentName} exceeded budget — not retrying`, "warning");
	} else if (!result.success) {
		ctx.ui.notify(`Agent ${agentName} failed`, "warning");
	}

	return { result, usedRetry: false };
}
