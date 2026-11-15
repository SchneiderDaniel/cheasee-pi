// Use case: run one audit to completion.
//
// Owns what must not be duplicated elsewhere: the resume gate, the completion
// gate (no report and no issue until every discovered test is decided), and the
// rule that exactly one cleanup issue is filed. The pool lives in
// `run-pool.ts`, the filing transaction in `run-filing.ts`.
//
// Nothing here imports fs, a network client, or a model SDK: the ports in
// `ports.ts` are supplied by the composition root.

import { configFingerprint, inventoryFingerprint } from "./fingerprint.ts";
import type { CheckpointStore, DecisionModel, IssueFiler, IssueRecord } from "./ports.ts";
import type { RunReport } from "./report.ts";
import { buildReport } from "./report.ts";
import { fileCleanupIssue } from "./run-filing.ts";
import { RunHaltedError } from "./run-error.ts";
import { judgeQueue, type PoolState } from "./run-pool.ts";
import type { RunLogger } from "./ports.ts";
import { testKey } from "./types.ts";
import type { InventoryResult, TestDefinition, ValidatorConfig, Verdict } from "./types.ts";

export { RunHaltedError } from "./run-error.ts";

/** Everything the use case needs, all as ports. */
interface RunDeps {
	readonly model: DecisionModel;
	readonly checkpoint: CheckpointStore;
	readonly filer: IssueFiler;
	readonly config: ValidatorConfig;
	/** Criterion ids defined by the criteria file. */
	readonly criteriaIds: readonly string[];
	/** sha256 of the criteria file, part of the resume fingerprint. */
	readonly criteriaSha256: string;
	/** Report sink (the CLI writes the JSON artifact). */
	readonly writeReport: (report: RunReport) => void | Promise<void>;
	readonly log?: RunLogger;
	readonly now?: () => Date;
}

interface RunOptions {
	readonly inventory: InventoryResult;
	/** Source text by repository-relative path, for slices and import context. */
	readonly sources: ReadonlyMap<string, string>;
	/** Fingerprint of this audit, embedded in the report and the issue marker. */
	readonly runFingerprint: string;
	readonly headSha: string | null;
	/** Archive the previous checkpoint and judge everything again. */
	readonly restart?: boolean;
}

interface RunCounts {
	readonly discovered: number;
	readonly good: number;
	readonly bad: number;
	readonly pending: number;
	readonly excluded: number;
	/** Tests whose decision came from the checkpoint instead of the model. */
	readonly reused: number;
}

export interface RunResult {
	/** True only when every discovered test is GOOD or BAD. */
	readonly complete: boolean;
	readonly counts: RunCounts;
	/** Null while the run is incomplete: a partial audit writes no report. */
	readonly report: RunReport | null;
	readonly issue: { readonly url: string } | null;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Split the inventory into "already decided" and "still to judge". */
function partition(
	definitions: readonly TestDefinition[],
	verdicts: ReadonlyMap<string, Verdict>,
): { queue: TestDefinition[]; reused: number } {
	const queue: TestDefinition[] = [];
	let reused = 0;
	for (const def of definitions) {
		if (verdicts.has(testKey(def))) reused += 1;
		else queue.push(def);
	}
	return { queue, reused };
}

export async function runValidation(deps: RunDeps, options: RunOptions): Promise<RunResult> {
	const log = deps.log ?? (() => {});
	const now = deps.now ?? (() => new Date());
	const config = deps.config;

	const prior = await deps.checkpoint.open({
		restart: options.restart,
		inventoryFingerprint: inventoryFingerprint(options.inventory.tests),
		configFingerprint: configFingerprint(config, deps.criteriaSha256),
		criteriaSha256: deps.criteriaSha256,
		definitions: options.inventory.tests,
		now,
	});

	const state: PoolState = {
		verdicts: new Map<string, Verdict>(prior.verdicts),
		attempts: new Map<string, number>(prior.attempts),
		consecutiveFailures: 0,
		halted: null,
		cursor: 0,
	};
	const { queue, reused } = partition(options.inventory.tests, state.verdicts);
	if (prior.resumed) {
		log(`resuming: ${reused} decision(s) reused from the checkpoint, ${queue.length} to judge`);
	}

	await judgeQueue({ ...deps, sources: options.sources }, queue, state);

	if (state.halted !== null) {
		throw new RunHaltedError(
			`run halted after ${config.haltAfterConsecutiveFailures} consecutive model failures: ${errorMessage(state.halted)}`,
			state.halted,
		);
	}

	const draft = buildReport({
		inventory: options.inventory,
		verdicts: state.verdicts,
		runFingerprint: options.runFingerprint,
		headSha: options.headSha,
		generatedAt: now().toISOString(),
		issue: null,
	});

	const counts: RunCounts = { ...draft.counts, reused };
	if (counts.pending > 0) {
		log(
			`incomplete: ${counts.pending} test(s) still pending after ${config.maxAttempts} attempt(s); no report and no issue`,
		);
		return { complete: false, counts, report: null, issue: null };
	}

	const issue: IssueRecord | null = await fileCleanupIssue(deps, {
		runFingerprint: options.runFingerprint,
		draft,
		priorIssue: prior.issue,
		hadIntent: prior.issueIntent !== null,
	});
	if (issue !== null) log(`filed cleanup issue: ${issue.url}`);

	const report: RunReport = { ...draft, issue: issue === null ? null : { url: issue.url } };
	await deps.writeReport(report);

	return { complete: true, counts, report, issue };
}
