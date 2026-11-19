// ─── Pi session factory ────────────────────────────────────────
// The one place a real Pi session is created for a goal generation. The
// configured model is passed explicitly and then asserted: an omitted model
// makes `createAgentSession` fall back to the settings default, which would
// silently break R6.AC2 (no silent fallback to the session model).

import { resolveModel } from "../../shared/model/model-ref.ts";

/** The subset of Pi's `AgentSession` this adapter uses. */
export interface PiSessionLike {
	prompt(text: string): Promise<void>;
	steer?(text: string): Promise<void>;
	abort?(): Promise<void>;
	dispose?(): void;
	getContextUsage?(): { tokens: number | null } | undefined;
	model?: { id?: string };
}

/** A running generation, normalized for the service. */
export interface GoalSessionHandle {
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	/** Tokens in the active context, or null when Pi cannot report them. */
	contextTokens(): number | null;
}

export interface CreateGoalSessionInput {
	cwd: string;
	/** Configured `provider/model-id`. */
	model: string;
	prompt: string;
}

/** Injected so tests never construct a real Pi session. */
export type GoalSessionFactory = (input: CreateGoalSessionInput) => Promise<GoalSessionHandle>;

export interface PiGoalAgentRuntimeOptions {
	/** Defaults to a factory that calls the real `createAgentSession`. */
	createSession?: GoalSessionFactory;
}

/**
 * Create a real Pi session for one generation.
 *
 * The configured model is passed explicitly and then asserted: an omitted model
 * makes `createAgentSession` fall back to the settings default, which would
 * silently break R6.AC2.
 */
export async function createPiSession(input: CreateGoalSessionInput): Promise<GoalSessionHandle> {
	const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
		createAgentSession(options: { cwd: string; model: unknown }): Promise<{
			session: PiSessionLike;
		}>;
	};
	const model = resolveModel(input.model);
	const created = await mod.createAgentSession({ cwd: input.cwd, model });
	const session = created.session;
	if (!session) throw new Error("createAgentSession returned no session");
	const actual = session.model?.id;
	if (actual && actual !== model.id) {
		throw new Error(
			`goal session model "${actual}" does not match the configured model "${model.id}" — ` +
				"refusing to run with a silently substituted model",
		);
	}
	await session.prompt(input.prompt);
	return {
		steer: async (text) => {
			if (!session.steer) throw new Error("the goal session does not support steering");
			await session.steer(text);
		},
		abort: async () => {
			await session.abort?.();
		},
		dispose: async () => {
			session.dispose?.();
		},
		contextTokens: () => session.getContextUsage?.()?.tokens ?? null,
	};
}
