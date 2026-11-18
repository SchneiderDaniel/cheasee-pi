// ─── Pi goal runtime: one agent session per context generation ──
// A rollover calls `start` again with a fresh session in the same worktree
// instead of replacing the user's session from a lifecycle handler (which can
// deadlock). The runtime holds plain data between generations: the session
// handle, a compaction flag and a token reader. Harness verification is a
// separate adapter (`goal-checks.ts`).

import { failure, type Result } from "../../shared/result.ts";
import type { GoalAgentRuntime, StartGenerationInput } from "../application/ports.ts";
import {
	createPiSession,
	type GoalSessionFactory,
	type GoalSessionHandle,
	type PiGoalAgentRuntimeOptions,
} from "./pi-session.ts";

export type {
	CreateGoalSessionInput,
	GoalSessionFactory,
	GoalSessionHandle,
	PiSessionLike,
} from "./pi-session.ts";

const RUNTIME_SOURCE = "goal-runtime";

/**
 * Generation-scoped {@link GoalAgentRuntime}.
 *
 * `markCompaction()` is called by the extension's `session_compact` handler so
 * the next boundary forces a rollover: in-place compaction must not replace the
 * configured fresh-session rollover (R5.AC4).
 */
export class PiGoalAgentRuntime implements GoalAgentRuntime {
	private readonly factory: GoalSessionFactory;
	private session: GoalSessionHandle | null = null;
	private compactionSeen = false;

	constructor(options: PiGoalAgentRuntimeOptions = {}) {
		this.factory = options.createSession ?? createPiSession;
	}

	/** Record that Pi compacted the active context in place. */
	markCompaction(): void {
		this.compactionSeen = true;
	}

	/**
	 * Start a new generation. Fails closed when the worktree or model is
	 * missing — a session must never be created without both (R3.AC3, R6.AC2).
	 */
	async start(input: StartGenerationInput): Promise<Result<{ generation: number }>> {
		if (!input.worktree) {
			return failure("a goal session requires the goal worktree as its cwd", RUNTIME_SOURCE);
		}
		if (!input.model) {
			return failure("a goal session requires the configured goal model", RUNTIME_SOURCE);
		}
		try {
			this.session = await this.factory({
				cwd: input.worktree,
				model: input.model,
				prompt: input.prompt,
			});
			return { ok: true, value: { generation: input.generation } };
		} catch (err: unknown) {
			this.session = null;
			return failure(describeFailure("cannot start the goal session", err), RUNTIME_SOURCE);
		}
	}

	async steer(text: string): Promise<Result<void>> {
		if (!this.session) return failure("no goal session is running", RUNTIME_SOURCE);
		try {
			await this.session.steer(text);
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			return failure(describeFailure("cannot steer the goal session", err), RUNTIME_SOURCE);
		}
	}

	async abort(): Promise<Result<void>> {
		if (!this.session) return { ok: true, value: undefined };
		try {
			await this.session.abort();
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			return failure(describeFailure("cannot abort the goal session", err), RUNTIME_SOURCE);
		}
	}

	async dispose(): Promise<void> {
		if (!this.session) return;
		const session = this.session;
		this.session = null;
		await session.dispose();
	}

	contextTokens(): number | null {
		return this.session?.contextTokens() ?? null;
	}

	takeCompactionSeen(): boolean {
		const seen = this.compactionSeen;
		this.compactionSeen = false;
		return seen;
	}
}

/** `prefix: message` for any thrown value. */
function describeFailure(prefix: string, err: unknown): string {
	return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}
