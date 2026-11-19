/**
 * builders.mts — shared goal fixtures for the use-case suites.
 *
 * Keeps the phase suites from re-declaring criteria/record/config shapes, so a
 * contract change is one edit.
 */

import { createGoalRecord } from "../../domain/goal-record-id.ts";
import type {
	AcceptanceCriterion,
	GoalConfigSnapshot,
	GoalRecord,
} from "../../domain/goal-record.ts";
import type { GoalServiceDeps, GoalRuntimeConfig } from "../../application/goal-service.ts";
import {
	createCallLog,
	FakeCheckRunner,
	FakeGoalRuntime,
	FakeGoalStore,
	FakeGoalWorkspace,
	FakePullRequestPort,
} from "./fake-ports.mts";
import { createModelResolver } from "./fake-ports.mts";
import type { Result } from "../../../shared/result.ts";

export const DEFAULT_CONFIG: GoalConfigSnapshot = {
	model: "provider/model-id",
	rolloverTokens: 150_000,
	maxIterations: 50,
};

/** A command criterion (`npm test`, expecting exit 0). */
export function commandCriterion(
	id = "c1",
	argv: string[] = ["npm", "test"],
	overrides: Partial<AcceptanceCriterion> = {},
): AcceptanceCriterion {
	return {
		id,
		text: `criterion ${id}`,
		verifier: { kind: "command", argv, pinned: [], expectExit: 0 },
		...overrides,
	};
}

/** An inspect criterion with no executable form. */
export function inspectCriterion(
	id = "c2",
	instruction = "the diff adds a test",
): AcceptanceCriterion {
	return { id, text: `criterion ${id}`, verifier: { kind: "inspect", instruction } };
}

/** A fresh `clarifying` record. */
export function buildRecord(
	overrides: Partial<GoalRecord> = {},
	config: GoalConfigSnapshot = DEFAULT_CONFIG,
): GoalRecord {
	const base = createGoalRecord({
		id: overrideId(overrides),
		request: "add a feature",
		config,
		now: new Date("2026-01-02T03:04:05.000Z"),
	});
	return { ...base, ...overrides };
}

function overrideId(overrides: Partial<GoalRecord>): string {
	return overrides.id ?? "20260102-030405-add-a-feature-abcd";
}

/** One fake-port bundle plus a ready `GoalServiceDeps`. */
export interface Harness {
	log: ReturnType<typeof createCallLog>;
	store: FakeGoalStore;
	workspace: FakeGoalWorkspace;
	pr: FakePullRequestPort;
	runtime: FakeGoalRuntime;
	checks: FakeCheckRunner;
	modelCalls: string[];
	deps: GoalServiceDeps;
	config: GoalRuntimeConfig;
}

/** Build a harness; `overrides` customizes the deps (config loader, clock, ...). */
export function createHarness(
	overrides: Partial<GoalServiceDeps> & {
		contextWindow?: number;
		modelFailFor?: string[];
		settings?: GoalRuntimeConfig["settings"];
		now?: () => Date;
	} = {},
): Harness {
	const log = createCallLog();
	const store = new FakeGoalStore(log);
	const workspace = new FakeGoalWorkspace(log);
	const pr = new FakePullRequestPort(log);
	const runtime = new FakeGoalRuntime(log);
	const checks = new FakeCheckRunner(log);
	const { resolver, calls: modelCalls } = createModelResolver({
		contextWindow: overrides.contextWindow ?? 400_000,
		failFor: overrides.modelFailFor ?? [],
	});
	const config: GoalRuntimeConfig = {
		settings: overrides.settings ?? {
			model: DEFAULT_CONFIG.model,
			contextRolloverTokens: DEFAULT_CONFIG.rolloverTokens,
			maxIterations: DEFAULT_CONFIG.maxIterations,
		},
		model: {
			ref: DEFAULT_CONFIG.model,
			id: "model-id",
			provider: "provider",
			contextWindow: overrides.contextWindow ?? 400_000,
		},
	};
	const deps: GoalServiceDeps = {
		store,
		workspace,
		pr,
		runtime,
		checks,
		loadConfig: (): Result<GoalRuntimeConfig> => ({ ok: true, value: config }),
		baseBranch: async () => ({ ok: true, value: "main" }),
		repo: "owner/repo",
		...overrides,
	};
	return { log, store, workspace, pr, runtime, checks, modelCalls, deps, config };
}
