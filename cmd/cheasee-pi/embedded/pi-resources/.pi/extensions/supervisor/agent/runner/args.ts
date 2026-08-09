// ─── Subprocess args assembly ─────────────────────────────────────
// buildSubprocessArgs assembles CLI args for pi --mode json.
// Used by runAgentSubprocess (orchestrator) and pipeline/execute-agent.
// SAFE_TASK_CHARS co-locates with the spill creation so both halves of
// the spill decision (creation + teardown) stay in the same module pair
// (spawn/cleanup).

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ParsedAgent } from "../../config/types.ts";
import { resolveTools, resolveExtensionPaths, resolveSkillPaths } from "../../lib/extensions.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { getErrorCollector } from "../../pipeline/error-collector.ts";

// Re-export DEFAULT_AGENT_TIMEOUT_MS for backward compatibility
// (lives here so runner/index.ts can stay pure star re-exports).
export { DEFAULT_AGENT_TIMEOUT_MS } from "../../config/config.ts";

// SAFE_TASK_CHARS: max chars before we spill task to a temp file and
// pass @file instead of raw CLI arg. Linux ARG_MAX is typically 2MB.
// We keep well below that by spilling at 1.2M chars (remaining ~800KB
// for other args, env, execve overhead).
// ponytail: temp file cleanup deferred to OS (/tmp cleanup on reboot).

export const SAFE_TASK_CHARS = 1_200_000;

export function buildSubprocessArgs(
	agent: ParsedAgent,
	task: string,
	effectiveCwd: string,
	sessionPath?: string,
): { args: string[]; tools: string; skillPaths: string[]; toolSpillDir?: string } {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = resolveTools(rawTools, agent.config.extensions, effectiveCwd);
	const model = agent.config.model || "";
	const bareExtPaths = resolveExtensionPaths(agent.config.extensions, effectiveCwd);
	const extFlags = bareExtPaths.flatMap((p) => ["--extension", p]);
	const skillPaths = resolveSkillPaths(agent.config.skills, effectiveCwd);

	// If task is large, write to temp file and use @file to bypass ARG_MAX
	let toolSpillDir: string | undefined;
	const taskArg =
		task.length > SAFE_TASK_CHARS
			? (() => {
					const tmpDir = mkdtempSync(join(tmpdir(), "pi-task-"));
					toolSpillDir = tmpDir;
					const taskFile = join(tmpDir, "task.txt");
					writeFileSync(taskFile, task, "utf-8");
					return `@${taskFile}`;
				})()
			: task;

	const args: string[] = [
		"-p",
		"--mode",
		"json",
		taskArg,
		"--system-prompt",
		agent.systemPrompt,
		"--tools",
		tools,
		...extFlags,
		"--no-extensions",
		"--no-skills",
		...skillPaths.flatMap((p) => ["--skill", p]),
		"--no-context-files",
	];
	if (model) args.push("--model", model);
	if (agent.config.thinking && agent.config.thinking.trim()) {
		args.push("--thinking", agent.config.thinking.trim());
	}
	if (sessionPath) {
		args.push("--session", sessionPath);
	}
	return { args, tools, skillPaths, toolSpillDir };
}

/**
 * Warn if task is large enough to risk ARG_MAX (Linux default: 2MB).
 * Returns total arg chars for the caller's log line.
 */
export function warnIfArgsLarge(args: string[], agentName: string): number {
	const log = getDebugLogger();
	const ARG_MAX_WARN_THRESHOLD = 1_000_000; // 1MB
	const totalArgChars = args.reduce((sum, a) => sum + a.length, 0);
	if (totalArgChars > ARG_MAX_WARN_THRESHOLD) {
		log.warn(
			"agent-runner",
			`Subprocess args large (${totalArgChars} chars) — risk of ARG_MAX overflow for ${agentName}`,
		);
		getErrorCollector().push(
			"runner",
			"warn",
			`Large subprocess args: ${totalArgChars} chars for ${agentName}`,
		);
	}
	return totalArgChars;
}
