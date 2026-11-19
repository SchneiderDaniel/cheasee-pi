/**
 * fake-ports.mts — scriptable port fakes for the goal-loop use-case suites.
 *
 * Every fake records into one ordered call log so a test can assert side-effect
 * ORDER (record → worktree → session, record → ready → complete), not just
 * which calls happened. No `mock.module`, no timers, no network.
 */

import type {
	CheckOutcome,
	CheckRunner,
	GoalAgentRuntime,
	GoalStore,
	GoalWorkspace,
	ModelResolver,
	PullRequestPort,
	PrepareWorkspaceInput,
	StartGenerationInput,
	WorkspaceOutcome,
} from "../../application/ports.ts";
import type { AcceptanceCriterion, GoalRecord } from "../../domain/goal-record.ts";
import type { Result } from "../../../shared/result.ts";

export interface CallLog {
	readonly calls: string[];
	record(name: string): void;
	clear(): void;
}

export function createCallLog(): CallLog {
	const calls: string[] = [];
	return {
		calls,
		record(name: string) {
			calls.push(name);
		},
		clear() {
			calls.length = 0;
		},
	};
}

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = <T,>(error: string): Result<T> => ({ ok: false, error, source: "test" });

/** In-memory {@link GoalStore}. */
export class FakeGoalStore implements GoalStore {
	readonly writes: GoalRecord[] = [];
	/** Records already on disk before the test starts. */
	seed: GoalRecord[] = [];
	/** Fail every write after this many successful writes (null = never). */
	failAfterWrites: number | null = null;
	acquireError: string | null = null;
	lockAcquired = false;
	released = 0;
	private readonly log: CallLog;

	constructor(log: CallLog) {
		this.log = log;
	}

	async write(record: GoalRecord): Promise<Result<void>> {
		this.log.record("store.write");
		if (this.failAfterWrites !== null && this.writes.length >= this.failAfterWrites) {
			return fail(`disk full (${this.writes.length} writes already)`);
		}
		this.writes.push(record);
		return ok(undefined);
	}

	async read(id: string): Promise<Result<GoalRecord>> {
		const found = [...this.writes, ...this.seed].reverse().find((r) => r.id === id);
		return found ? ok(found) : fail(`no record ${id}`);
	}

	async list(): Promise<Result<GoalRecord[]>> {
		const byId = new Map<string, GoalRecord>();
		for (const record of this.seed) byId.set(record.id, record);
		for (const record of this.writes) byId.set(record.id, record);
		return ok([...byId.values()]);
	}

	async acquire(): Promise<Result<void>> {
		if (this.acquireError) return fail(this.acquireError);
		this.lockAcquired = true;
		return ok(undefined);
	}

	async release(): Promise<void> {
		this.released += 1;
		this.lockAcquired = false;
	}

	/** The most recent record written. */
	last(): GoalRecord {
		const record = this.writes.at(-1);
		if (!record) throw new Error("no record written");
		return record;
	}
}

/** Configurable {@link GoalWorkspace}. */
export class FakeGoalWorkspace implements GoalWorkspace {
	outcome: WorkspaceOutcome = {
		clean: true,
		path: "/tmp/worktrees/goal-1",
		branch: "goal/goal-1",
		head: "abc123",
	};
	prepareError: string | null = null;
	readonly prepareCalls: PrepareWorkspaceInput[] = [];
	readonly cleanupCalls: Array<{ path: string; confirmed: boolean }> = [];
	private readonly log: CallLog;

	constructor(log: CallLog) {
		this.log = log;
	}

	async prepare(input: PrepareWorkspaceInput): Promise<Result<WorkspaceOutcome>> {
		this.log.record("workspace.prepare");
		this.prepareCalls.push(input);
		if (this.prepareError) return fail(this.prepareError);
		return ok(this.outcome);
	}

	async discardGoalWorktree(input: { path: string; confirmed: boolean }): Promise<Result<void>> {
		this.log.record("workspace.discardGoalWorktree");
		this.cleanupCalls.push(input);
		if (!input.confirmed) return fail(`worktree ${input.path} retained`);
		return ok(undefined);
	}
}

/** Scriptable {@link PullRequestPort}. */
export class FakePullRequestPort implements PullRequestPort {
	openError: string | null = null;
	readyError: string | null = null;
	updateError: string | null = null;
	state: "draft" | "open" | "merged" | "closed" = "draft";
	nextNumber = 7;
	readonly readyCalls: string[] = [];
	readonly openCalls: Array<{ branch: string; base: string }> = [];
	readonly updateCalls: Array<{ number: number; body: string }> = [];
	private readonly log: CallLog;

	constructor(log: CallLog) {
		this.log = log;
	}

	async openDraft(input: {
		branch: string;
		base: string;
		title: string;
		body: string;
	}): Promise<Result<{ number: number; nodeId: string }>> {
		this.log.record("pr.openDraft");
		this.openCalls.push({ branch: input.branch, base: input.base });
		if (this.openError) return fail(this.openError);
		return ok({ number: this.nextNumber, nodeId: `node-${this.nextNumber}` });
	}

	async updateBody(input: { number: number; body: string }): Promise<Result<void>> {
		this.log.record("pr.updateBody");
		this.updateCalls.push(input);
		if (this.updateError) return fail(this.updateError);
		return ok(undefined);
	}

	async markReadyForReview(nodeId: string): Promise<Result<void>> {
		this.log.record("pr.markReadyForReview");
		this.readyCalls.push(nodeId);
		if (this.readyError) return fail(this.readyError);
		return ok(undefined);
	}

	async getState(): Promise<Result<"draft" | "open" | "merged" | "closed">> {
		this.log.record("pr.getState");
		return ok(this.state);
	}
}

/** Scriptable {@link GoalAgentRuntime}. */
export class FakeGoalRuntime implements GoalAgentRuntime {
	startError: string | null = null;
	steerError: string | null = null;
	tokens: number | null = null;
	compactionSeen = false;
	disposed = 0;
	readonly starts: StartGenerationInput[] = [];
	readonly steers: string[] = [];
	readonly aborts: string[] = [];
	private readonly log: CallLog;

	constructor(log: CallLog) {
		this.log = log;
	}

	async start(input: StartGenerationInput): Promise<Result<{ generation: number }>> {
		this.log.record("runtime.start");
		this.starts.push(input);
		if (this.startError) return fail(this.startError);
		return ok({ generation: input.generation });
	}

	async steer(text: string): Promise<Result<void>> {
		this.log.record("runtime.steer");
		this.steers.push(text);
		if (this.steerError) return fail(this.steerError);
		return ok(undefined);
	}

	async abort(): Promise<Result<void>> {
		this.log.record("runtime.abort");
		this.aborts.push("abort");
		return ok(undefined);
	}

	async dispose(): Promise<void> {
		this.disposed += 1;
	}

	/** Mirror of the real runtime's `session_compact` flag. */
	markCompaction(): void {
		this.compactionSeen = true;
	}

	contextTokens(): number | null {
		return this.tokens;
	}

	takeCompactionSeen(): boolean {
		const seen = this.compactionSeen;
		this.compactionSeen = false;
		return seen;
	}
}

/** Scriptable {@link CheckRunner}. */
export class FakeCheckRunner implements CheckRunner {
	/** criterionId → result. Missing ids default to "pass". */
	results = new Map<string, "pass" | "fail">();
	error: string | null = null;
	throwOn: string | null = null;
	readonly runs: Array<{ criterionId: string; worktree: string }> = [];
	private readonly log: CallLog;

	constructor(log: CallLog) {
		this.log = log;
	}

	async run(criterion: AcceptanceCriterion, worktree: string): Promise<Result<CheckOutcome>> {
		this.log.record(`checks.run:${criterion.id}`);
		this.runs.push({ criterionId: criterion.id, worktree });
		if (this.throwOn === criterion.id) throw new Error("check exploded");
		if (this.error) return fail(this.error);
		const result = this.results.get(criterion.id) ?? "pass";
		return ok({ result, evidenceRef: `${criterion.id}:${result}` });
	}
}

/** Deterministic {@link ModelResolver} fixture. */
export function createModelResolver(options?: { contextWindow?: number; failFor?: string[] }): {
	resolver: ModelResolver;
	calls: string[];
} {
	const calls: string[] = [];
	const contextWindow = options?.contextWindow ?? 400_000;
	const failFor = options?.failFor ?? [];
	return {
		resolver: (ref: string) => {
			calls.push(ref);
			if (failFor.includes(ref)) throw new Error(`unknown model ${ref}`);
			const slash = ref.indexOf("/");
			return {
				id: ref.slice(slash + 1),
				provider: ref.slice(0, slash),
				contextWindow,
			};
		},
		calls,
	};
}
