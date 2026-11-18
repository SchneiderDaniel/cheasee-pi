// ─── Pi goal runtime + harness verification ──────────────────────
// Two Pi-facing adapters that must not be confused with policy:
//
// 1. `PiGoalAgentRuntime` — one agent session per CONTEXT GENERATION. A
//    rollover calls `start` again with a fresh session in the same worktree
//    instead of replacing the user's session from a lifecycle handler (which
//    can deadlock). It holds only plain data between generations: the session
//    handle, a compaction flag and a token reader.
//
// 2. `HarnessCheckRunner` — executes a criterion's verifier. Command verifiers
//    run as an argv array (never a shell string) in the goal worktree, after
//    every pinned file hash is re-verified. Inspect verifiers receive
//    harness-produced evidence only: the record's stored evidence never counts,
//    because a fabricated record must not satisfy the completion gate.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { failure, type Result } from "../../shared/result.ts";
import { resolveModel } from "../../shared/model/model-ref.ts";
import type { ExecLike } from "../../shared/git/worktree.ts";
import type { AcceptanceCriterion, PinnedFile } from "../domain/goal-record.ts";
import type {
	CheckOutcome,
	CheckRunner,
	GoalAgentRuntime,
	StartGenerationInput,
} from "../application/ports.ts";

const RUNTIME_SOURCE = "goal-runtime";
const CHECK_SOURCE = "goal-check";

// ─── Generation sessions ─────────────────────────────────────────

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
async function createPiSession(input: CreateGoalSessionInput): Promise<GoalSessionHandle> {
	const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
		createAgentSession(options: {
			cwd: string;
			model: unknown;
		}): Promise<{ session: PiSessionLike }>;
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
			return failure(
				`cannot start the goal session: ${err instanceof Error ? err.message : String(err)}`,
				RUNTIME_SOURCE,
			);
		}
	}

	async steer(text: string): Promise<Result<void>> {
		if (!this.session) return failure("no goal session is running", RUNTIME_SOURCE);
		try {
			await this.session.steer(text);
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			return failure(
				`cannot steer the goal session: ${err instanceof Error ? err.message : String(err)}`,
				RUNTIME_SOURCE,
			);
		}
	}

	async abort(): Promise<Result<void>> {
		if (!this.session) return { ok: true, value: undefined };
		try {
			await this.session.abort();
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			return failure(
				`cannot abort the goal session: ${err instanceof Error ? err.message : String(err)}`,
				RUNTIME_SOURCE,
			);
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

// ─── Harness verification ────────────────────────────────────────

/** Verdict from a nested inspect call. */
export interface InspectVerdict {
	pass: boolean;
	/** Short justification quoted into the record's evidence. */
	note: string;
}

/** Runs an `inspect` verifier over harness-produced evidence. */
export type InspectRunner = (instruction: string, evidence: string) => Promise<InspectVerdict>;

export interface HarnessCheckRunnerOptions {
	exec: ExecLike;
	/** Nested fresh-context judgement; absent means inspect criteria fail closed. */
	inspect?: InspectRunner;
	/** Read a file's bytes for pinned-hash verification (injectable for tests). */
	readFile?: (path: string) => Buffer;
}

/** SHA-256 hex digest of a file's bytes. */
function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Execute verifiers from the harness side.
 *
 * A command verifier cannot run before every pinned hash matches, so a fix that
 * rewrites the check script cannot pass. Inspect verifiers see `git diff` /
 * `git status` produced here, never the record's own claims.
 */
export class HarnessCheckRunner implements CheckRunner {
	private readonly exec: ExecLike;
	private readonly inspect?: InspectRunner;
	private readonly readFile: (path: string) => Buffer;

	constructor(options: HarnessCheckRunnerOptions) {
		this.exec = options.exec;
		this.inspect = options.inspect;
		this.readFile = options.readFile ?? ((path) => readFileSync(path));
	}

	async run(criterion: AcceptanceCriterion, worktree: string): Promise<Result<CheckOutcome>> {
		if (!worktree) {
			return failure(`criterion ${criterion.id} has no worktree to verify against`, CHECK_SOURCE);
		}
		const verifier = criterion.verifier;
		if (verifier.kind === "command") {
			const pinnedFailure = this.checkPinned(verifier.pinned, worktree);
			if (pinnedFailure) {
				return { ok: true, value: { result: "fail", evidenceRef: pinnedFailure } };
			}
			return await this.runCommand(verifier.argv, verifier.expectExit, worktree);
		}
		return await this.runInspect(criterion, verifier.instruction, worktree);
	}

	/** Why a pinned file no longer matches, or null when all match. */
	private checkPinned(pinned: PinnedFile[], worktree: string): string | null {
		for (const file of pinned) {
			const absolute = isAbsolute(file.path) ? file.path : join(worktree, file.path);
			let bytes: Buffer;
			try {
				bytes = this.readFile(absolute);
			} catch {
				return `pinned file ${file.path} is missing — verifier not executed`;
			}
			const actual = sha256(bytes);
			if (actual !== file.sha256) {
				return `pinned hash mismatch for ${file.path} (expected ${file.sha256.slice(0, 12)}, got ${actual.slice(0, 12)}) — verifier not executed`;
			}
		}
		return null;
	}

	private async runCommand(
		argv: string[],
		expectExit: number,
		worktree: string,
	): Promise<Result<CheckOutcome>> {
		const [command, ...args] = argv;
		if (!command) {
			return failure("command verifier has an empty argv", CHECK_SOURCE);
		}
		let result;
		try {
			result = await this.exec(command, args, { cwd: worktree, timeout: 600_000 });
		} catch (err: unknown) {
			return failure(
				`cannot execute ${argv.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
				CHECK_SOURCE,
			);
		}
		const passed = result.code === expectExit;
		return {
			ok: true,
			value: {
				result: passed ? "pass" : "fail",
				evidenceRef: `\`${argv.join(" ")}\` exited ${result.code} (expected ${expectExit})`,
			},
		};
	}

	private async runInspect(
		criterion: AcceptanceCriterion,
		instruction: string,
		worktree: string,
	): Promise<Result<CheckOutcome>> {
		if (!this.inspect) {
			return failure(
				`criterion ${criterion.id} needs an inspect verifier but none is configured`,
				CHECK_SOURCE,
			);
		}
		const evidence = await this.collectEvidence(worktree);
		if (!evidence.ok) return evidence;
		let verdict: InspectVerdict;
		try {
			verdict = await this.inspect(instruction, evidence.value);
		} catch (err: unknown) {
			return failure(
				`inspect verifier for ${criterion.id} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
				CHECK_SOURCE,
			);
		}
		return {
			ok: true,
			value: {
				result: verdict.pass ? "pass" : "fail",
				evidenceRef: `inspect: ${verdict.note}`,
			},
		};
	}

	/** Harness-produced evidence: the worktree diff and status, never the record. */
	private async collectEvidence(worktree: string): Promise<Result<string>> {
		const status = await this.exec("git", ["status", "--porcelain"], {
			cwd: worktree,
			timeout: 60_000,
		});
		if (status.code !== 0) {
			return failure(`cannot read the goal worktree status: ${status.stderr}`, CHECK_SOURCE);
		}
		const diff = await this.exec("git", ["diff", "HEAD"], { cwd: worktree, timeout: 120_000 });
		if (diff.code !== 0) {
			return failure(`cannot read the goal worktree diff: ${diff.stderr}`, CHECK_SOURCE);
		}
		return {
			ok: true,
			value: `## git status --porcelain\n${status.stdout}\n## git diff HEAD\n${diff.stdout}`,
		};
	}
}
