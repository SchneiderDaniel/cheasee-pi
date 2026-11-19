// ─── `/goal` argument parsing and command dispatch ───────────────
// Pure translation from raw command text to a service call. Every failure is
// surfaced through `ctx.ui.notify` — a service rejection is never swallowed.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildClarificationPrompt } from "./application/goal-prompts.ts";
import type { GoalService } from "./application/goal-service.ts";

/** `/goal` subcommands; anything else is goal text to start. */
const SUBCOMMANDS = ["status", "stop", "resume", "revise", "cleanup"] as const;

export type GoalSubcommand = "start" | (typeof SUBCOMMANDS)[number];

export interface ParsedGoalArgs {
	subcommand: GoalSubcommand;
	rest: string;
	flags: Set<string>;
}

function isSubcommand(value: string): value is (typeof SUBCOMMANDS)[number] {
	return (SUBCOMMANDS as readonly string[]).includes(value);
}

/** Parse `/goal <sub> ...`; anything unrecognised is goal text to start. */
export function parseGoalArgs(args: string): ParsedGoalArgs {
	const trimmed = args.trim();
	if (trimmed === "") return { subcommand: "status", rest: "", flags: new Set() };
	const [head = "", ...tail] = trimmed.split(/\s+/);
	const flags = new Set(tail.filter((token) => token.startsWith("--")));
	if (!isSubcommand(head)) return { subcommand: "start", rest: trimmed, flags };
	return { subcommand: head, rest: trimmed.slice(head.length).trim(), flags };
}

/** Dispatch one `/goal` invocation. Errors are the caller's to surface. */
export async function handleCommand(
	service: GoalService,
	parsed: ParsedGoalArgs,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	switch (parsed.subcommand) {
		case "start":
			return await startGoal(service, parsed.rest, ctx, pi);
		case "status":
			ctx.ui.notify(service.status(), "info");
			return;
		case "stop":
			return await stopGoal(service, ctx);
		case "resume":
			return await resumeGoal(service, parsed.flags.has("--approve"), ctx);
		case "revise":
			return reviseGoal(ctx, pi);
		case "cleanup":
			return await cleanupGoal(service, parsed.flags.has("--confirm"), ctx);
	}
}

/** `/goal <text>`: record the goal and ask the agent to clarify it. */
async function startGoal(
	service: GoalService,
	request: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const started = await service.start(request);
	if (!started.ok) {
		ctx.ui.notify(`goal: ${started.error}`, "error");
		return;
	}
	const record = started.value;
	ctx.ui.notify(
		`goal ${record.id} recorded as clarifying — no worktree or branch created yet`,
		"info",
	);
	pi.sendUserMessage(buildClarificationPrompt(record.request), { expandPromptTemplates: false });
}

/** `/goal stop`: abort the loop and print the final status. */
async function stopGoal(service: GoalService, ctx: ExtensionCommandContext): Promise<void> {
	const stopped = await service.stop();
	if (!stopped.ok) {
		ctx.ui.notify(`goal: ${stopped.error}`, "error");
		return;
	}
	ctx.ui.notify(`goal stopped\n${service.status()}`, "info");
}

/** `/goal resume [--approve]`: continue after a pause. */
async function resumeGoal(
	service: GoalService,
	approve: boolean,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const resumed = await service.resume({ approve });
	if (!resumed.ok) {
		ctx.ui.notify(`goal: ${resumed.error}`, "error");
		return;
	}
	ctx.ui.notify(`goal resumed\n${service.status()}`, "info");
}

/** `/goal revise`: reopen clarification without changing criteria yet. */
function reviseGoal(ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	pi.sendUserMessage(
		"Revise the goal's acceptance criteria with the user. Criteria change only through " +
			"goal_submit_clarification; the goal returns to clarification and must be re-validated.",
		{ expandPromptTemplates: false },
	);
	ctx.ui.notify(
		"goal reopened for clarification — criteria are unchanged until resubmitted",
		"info",
	);
}

/** `/goal cleanup --confirm`: remove the worktree after explicit confirmation. */
async function cleanupGoal(
	service: GoalService,
	confirmed: boolean,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const cleaned = await service.cleanup({ confirmed });
	if (!cleaned.ok) {
		ctx.ui.notify(`goal: ${cleaned.error}`, "error");
		return;
	}
	ctx.ui.notify("goal worktree removed", "info");
}
