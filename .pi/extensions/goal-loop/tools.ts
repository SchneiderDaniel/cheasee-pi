// ─── Agent-facing goal tools ────────────────────────────────────
// The agent never writes the record: it submits a clarification or an iteration
// report and the loop owns the file (R2, R4.AC1). Completion is never claimed
// through a tool — the harness verifies every criterion itself.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Result } from "../shared/result.ts";
import type {
	ClarificationSubmission,
	GoalService,
	IterationReport,
} from "./application/goal-service.ts";
import type { Verifier } from "./domain/goal-record.ts";

/** The backend a tool call needs (structurally the extension's backend). */
export interface ToolBackend {
	service: GoalService;
	runtime?: { markCompaction(): void };
}

/** Backend resolver shared with the command wiring. */
export type ResolveBackend = (
	ctx: ExtensionContext | ExtensionCommandContext,
) => Promise<Result<ToolBackend>>;

/** Normalize a tool-supplied verifier into the domain union. */
export function toVerifier(input: {
	kind: "command" | "inspect";
	argv?: string[];
	pinned?: Array<{ path: string; sha256: string }>;
	expectExit?: number;
	instruction?: string;
}): Verifier {
	if (input.kind === "command") {
		return {
			kind: "command",
			argv: input.argv ?? [],
			pinned: input.pinned ?? [],
			expectExit: input.expectExit ?? 0,
		};
	}
	return { kind: "inspect", instruction: input.instruction ?? "" };
}

/** Tool error payload. */
function toolText(text: string): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
} {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Register `goal_submit_clarification` and `goal_report_iteration`. */
export function registerGoalTools(pi: ExtensionAPI, resolve: ResolveBackend): void {
	pi.registerTool({
		name: "goal_submit_clarification",
		label: "Submit Goal Clarification",
		description:
			"Submit the clarified goal and its acceptance criteria. Use ready=false with questions while the goal is ambiguous, unreachable or unverifiable. Every criterion needs a command or inspect verifier.",
		parameters: Type.Object({
			ready: Type.Boolean(),
			clarifiedGoal: Type.Optional(Type.String()),
			questions: Type.Optional(Type.Array(Type.String())),
			reachable: Type.Optional(Type.Boolean()),
			criteria: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						text: Type.String(),
						verifier: Type.Object({
							kind: Type.Union([Type.Literal("command"), Type.Literal("inspect")]),
							argv: Type.Optional(Type.Array(Type.String())),
							pinned: Type.Optional(
								Type.Array(Type.Object({ path: Type.String(), sha256: Type.String() })),
							),
							expectExit: Type.Optional(Type.Number()),
							instruction: Type.Optional(Type.String()),
						}),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = await resolve(ctx);
			if (!resolved.ok) return toolText(`goal: ${resolved.error}`);
			const submission: ClarificationSubmission = {
				ready: params.ready,
				clarifiedGoal: params.clarifiedGoal,
				questions: params.questions,
				reachable: params.reachable,
				criteria: params.criteria?.map((c) => ({
					id: c.id,
					text: c.text,
					verifier: toVerifier(c.verifier),
				})),
			};
			const outcome = await resolved.value.service.submitClarification(submission);
			if (!outcome.ok) return toolText(`goal: ${outcome.error}`);
			const value = outcome.value;
			if (value.started) {
				return toolText(
					`goal ${value.record.id} started in ${value.record.worktree} on branch ${value.record.branch}`,
				);
			}
			return toolText(
				`clarification incomplete:\n${value.questions.map((q) => `- ${q}`).join("\n")}`,
			);
		},
	});

	pi.registerTool({
		name: "goal_report_iteration",
		label: "Report Goal Iteration",
		description:
			"Report the outcome of one work iteration: a short summary, the single next action, and an optional blocker. The loop verifies every acceptance criterion itself — do not claim completion.",
		parameters: Type.Object({
			summary: Type.String(),
			nextAction: Type.String(),
			blocker: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = await resolve(ctx);
			if (!resolved.ok) return toolText(`goal: ${resolved.error}`);
			const report: IterationReport = {
				summary: params.summary,
				nextAction: params.nextAction,
				blocker: params.blocker ?? null,
			};
			const recorded = await resolved.value.service.reportIteration(report);
			if (!recorded.ok) return toolText(`goal: ${recorded.error}`);
			return toolText(`iteration recorded (${recorded.value.iterations} completed)`);
		},
	});
}
