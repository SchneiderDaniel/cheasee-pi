// ─── Goal loop extension wiring ──────────────────────────────────
// Humble object layer (R1–R7). This module translates Pi events, commands and
// tools into `GoalService` calls — it holds no policy:
//
// - decisions come from `decideBoundary` (domain),
// - state transitions come from the record entity,
// - side-effect order comes from `GoalService`.
//
// It never calls `ctx.newSession` / session replacement. Session replacement
// from a lifecycle handler can deadlock the runtime, so a context rollover is a
// new runtime generation started by the service instead.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Result } from "../shared/result.ts";
import { createDefaultBackend, type GoalLoopBackend } from "./backend.ts";
import { handleCommand, parseGoalArgs } from "./commands.ts";
import { registerGoalTools } from "./tools.ts";

/** Goal mode is exposed as `/goal` (R1). */
export const GOAL_COMMAND = "goal";

export type { GoalLoopBackend } from "./backend.ts";
export { parseGoalArgs } from "./commands.ts";

/** Wiring dependencies. Tests inject a backend resolver; production uses Pi. */
export interface GoalLoopWiringOptions {
	/** Build (or reuse) the backend for a context. Called once per session. */
	resolveBackend: (
		ctx: ExtensionContext | ExtensionCommandContext,
	) => Promise<Result<GoalLoopBackend>>;
}

/** Register `/goal`, the steering `input` handler and the settle boundary. */
export function registerGoalLoop(pi: ExtensionAPI, options: GoalLoopWiringOptions): void {
	let backend: GoalLoopBackend | null = null;
	const resolve = async (
		ctx: ExtensionContext | ExtensionCommandContext,
	): Promise<Result<GoalLoopBackend>> => {
		if (backend) return { ok: true, value: backend };
		const resolved = await options.resolveBackend(ctx);
		if (!resolved.ok) return resolved;
		backend = resolved.value;
		return resolved;
	};

	// One continuation per completed iteration, so a continuation cannot re-fire
	// for the settle it already answered (which would double-count iterations
	// and bypass the configured cap). A rollover starts a new generation, which
	// is a new key.
	const continuedKeys = new Set<string>();

	pi.registerCommand(GOAL_COMMAND, {
		description:
			"Run a verified goal loop: /goal <description> | status | stop | resume --approve | revise | cleanup --confirm",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const resolved = await resolve(ctx);
			if (!resolved.ok) {
				ctx.ui.notify(`goal: ${resolved.error}`, "error");
				return;
			}
			try {
				await handleCommand(resolved.value.service, parseGoalArgs(rawArgs), ctx, pi);
			} catch (err: unknown) {
				// A service rejection is surfaced as a UI error, never swallowed.
				const reason = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`goal: ${reason}`, "error");
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		const resolved = await resolve(ctx);
		if (!resolved.ok) return undefined;
		const { service } = resolved.value;
		const record = service.current();
		if (!record) return undefined;

		if (record.status === "clarifying") {
			const recorded = await service.recordClarificationMessage(event.text);
			if (!recorded.ok) {
				ctx.ui.notify(`goal: ${recorded.error}`, "error");
				return { action: "handled" as const };
			}
			// The clarification answer still reaches the agent as a normal prompt;
			// the record keeps a copy so a context reset cannot lose it.
			return undefined;
		}
		if (!service.hasActiveGoal()) return undefined;
		const steered = await service.steer(event.text);
		if (!steered.ok) {
			ctx.ui.notify(`goal: ${steered.error}`, "error");
			return { action: "handled" as const };
		}
		return undefined;
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		const resolved = await resolve(ctx);
		if (!resolved.ok) return undefined;
		const { service } = resolved.value;
		const record = service.current();
		// Clarification is not a work iteration: there is no worktree or verifier
		// evidence yet, so settling the clarification response must not run a boundary.
		if (!record || record.status === "clarifying" || !service.hasActiveGoal()) return undefined;

		const key = `${record.generation}:${record.iterations}`;
		if (continuedKeys.has(key)) return undefined;

		const boundary = await service.onBoundary();
		if (!boundary.ok) {
			ctx.ui.notify(`goal: ${boundary.error}`, "error");
			return undefined;
		}
		if (boundary.value.decision.kind === "continue") {
			continuedKeys.add(key);
			return { continue: true };
		}
		return undefined;
	});

	pi.on("session_compact", async () => {
		backend?.runtime?.markCompaction();
	});

	registerGoalTools(pi, resolve);
}

/** Pi extension entry point. */
export default function goalLoop(pi: ExtensionAPI): void {
	registerGoalLoop(pi, {
		resolveBackend: async (ctx) => createDefaultBackend(pi, ctx),
	});
}
