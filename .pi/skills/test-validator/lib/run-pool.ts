// Use case: the bounded worker pool that judges the queue.
//
// Workers hand every result back to this coordinator, which is the only code
// that appends. That is why appends are ordered per test and never interleaved,
// and why the circuit breaker can stop the whole pool from one counter: a
// provider outage must not burn the budget on thousands of doomed calls.

import { isDecided, parseVerdict, verdictTargetFor } from "./decision.ts";
import { describeHeader, extractImports } from "./inventory-parse.ts";
import type { CheckpointStore, DecisionModel } from "./ports.ts";
import { RunHaltedError } from "./run-error.ts";
import type { DecisionRequest, TestDefinition, ValidatorConfig, Verdict } from "./types.ts";
import { testKey } from "./types.ts";

/** Everything the pool needs; a subset of the run's dependencies. */
interface JudgeDeps {
	readonly model: DecisionModel;
	readonly checkpoint: CheckpointStore;
	readonly config: ValidatorConfig;
	readonly sources: ReadonlyMap<string, string>;
	readonly criteriaIds: readonly string[];
}

/** Build the isolated judge request: slice, describe header, file imports. */
function decisionRequest(def: TestDefinition, source: string): DecisionRequest {
	const target = verdictTargetFor(def, source);
	return {
		file: def.file,
		name: def.name,
		startLine: def.startLine,
		endLine: def.endLine,
		header: describeHeader(def),
		imports: extractImports(source, def.file),
		slice: target.text,
	};
}

/** Mutable per-run state the workers share with the coordinator. */
export interface PoolState {
	verdicts: Map<string, Verdict>;
	attempts: Map<string, number>;
	consecutiveFailures: number;
	halted: unknown;
	cursor: number;
}

function sourceOf(deps: JudgeDeps, def: TestDefinition): string {
	const source = deps.sources.get(def.file);
	if (source === undefined) {
		throw new RunHaltedError(`no source loaded for ${def.file}; the inventory is incomplete`);
	}
	return source;
}

/** One attempt at one test; records a decision as soon as it is reached. */
async function attemptTest(deps: JudgeDeps, state: PoolState, def: TestDefinition): Promise<void> {
	const key = testKey(def);
	const source = sourceOf(deps, def);
	const request = decisionRequest(def, source);
	const target = verdictTargetFor(def, source);
	let attempt = state.attempts.get(key) ?? 0;

	while (attempt < deps.config.maxAttempts) {
		attempt += 1;
		let raw: string;
		try {
			raw = await deps.model.decide(request);
		} catch (err) {
			state.consecutiveFailures += 1;
			if (state.consecutiveFailures >= deps.config.haltAfterConsecutiveFailures) {
				state.halted = err;
				return;
			}
			continue;
		}
		state.consecutiveFailures = 0;

		const verdict = parseVerdict(raw, target, deps.criteriaIds, deps.config);
		if (isDecided(verdict)) {
			await deps.checkpoint.appendVerdict(def, verdict);
			state.verdicts.set(key, verdict);
			state.attempts.set(key, attempt);
			return;
		}
		await deps.checkpoint.appendPending(def, {
			attempts: attempt,
			pendingReason: verdict.pendingReason,
		});
		state.attempts.set(key, attempt);
	}
}

/** Judge every queued test, up to `config.concurrency` calls in flight. */
export async function judgeQueue(
	deps: JudgeDeps,
	queue: readonly TestDefinition[],
	state: PoolState,
): Promise<void> {
	const worker = async (): Promise<void> => {
		while (state.halted === null) {
			const next = state.cursor;
			state.cursor += 1;
			if (next >= queue.length) return;
			await attemptTest(deps, state, queue[next]);
		}
	};

	const width = Math.max(1, deps.config.concurrency);
	await Promise.all(Array.from({ length: width }, () => worker()));
}
