// Phase 9 — the operator journey: audit a repository, get interrupted, resume,
// then face a changed inventory. Real checkpoint on disk, fake model, fake gh.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CheckpointMismatchError, JsonlCheckpointStore } from "../lib/checkpoint.ts";
import { discoverTests } from "../lib/inventory.ts";
import type { CheckpointPrior, DecisionModel, IssueFiler, IssueRecord } from "../lib/ports.ts";
import { serializeReport } from "../lib/report.ts";
import { RunHaltedError, runValidation } from "../lib/run.ts";
import type { RunResult } from "../lib/run.ts";
import type { DecisionRequest, ValidatorConfig } from "../lib/types.ts";

const SOURCE = [
	'import { describe, it } from "node:test";',
	'import assert from "node:assert/strict";',
	'describe("checkout", () => {',
	'\tit("charges the total", () => {',
	"\t\tassert.equal(total(), 42);",
	"\t});",
	'\tit("logs nothing", () => {',
	"\t\tassert.ok(true);",
	"\t});",
	'\tit.skip("waits for the printer", () => {});',
	"});",
	"",
	"function total(): number {",
	"\treturn 42;",
	"}",
].join("\n");

const CONFIG: ValidatorConfig = {
	provider: "test-provider",
	model: "test-model",
	concurrency: 1,
	badConfidenceThreshold: 0.8,
	maxAttempts: 1,
	haltAfterConsecutiveFailures: 1,
};

const CRITERIA_SHA = "9".repeat(64);
const FILE = "src/checkout.test.mts";

type Step = (request: DecisionRequest) => string;

const GOOD: Step = () =>
	JSON.stringify({
		decision: "GOOD",
		confidence: 0.9,
		criteria: ["C1", "C2"],
		reason: "asserts a project-owned total",
		evidence: [],
	});

const BAD: Step = (request) =>
	JSON.stringify({
		decision: "BAD",
		confidence: 0.94,
		criteria: ["C2"],
		reason: "asserts a constant truthy value",
		evidence: [{ line: request.startLine, quote: request.slice.split("\n")[0] }],
	});

const halting =
	(message: string): Step =>
	() => {
		throw new Error(message);
	};

class JourneyModel implements DecisionModel {
	readonly calls: string[] = [];
	#script: Record<string, Step[]>;

	constructor(script: Record<string, Step[]>) {
		this.#script = script;
	}

	async decide(request: DecisionRequest): Promise<string> {
		this.calls.push(request.name);
		const steps = this.#script[request.name];
		if (!steps || steps.length === 0) throw new Error(`no script for ${request.name}`);
		return (steps.length > 1 ? steps.shift()! : steps[0])(request);
	}
}

class JourneyFiler implements IssueFiler {
	readonly creates: Array<{ title: string; body: string }> = [];
	readonly searches: string[] = [];

	async create(input: { title: string; body: string }): Promise<{ url: string }> {
		this.creates.push(input);
		return { url: "https://github.com/o/r/issues/7" };
	}

	async search(): Promise<IssueRecord | null> {
		this.searches.push("search");
		return null;
	}
}

/** Per-run scratch state: one directory (and checkpoint) across interrupted runs. */
interface State {
	dir?: string;
	prior: CheckpointPrior | null;
}

interface Journey {
	readonly result: RunResult;
	readonly model: JourneyModel;
	readonly filer: JourneyFiler;
	readonly log: string[];
	readonly reportPath: string;
	/** The three lines the operator sees, mirroring the CLI summary. */
	readonly summary: string[];
}

async function runJourney(
	state: State,
	options: {
		source?: string;
		script?: Record<string, Step[]>;
		restart?: boolean;
		expectRefusal?: boolean;
	},
): Promise<Journey | Error> {
	const dir = state.dir ?? mkdtempSync(join(tmpdir(), "test-validator-journey-"));
	state.dir = dir;
	const source = options.source ?? SOURCE;
	const inventory = discoverTests(source, FILE);
	const reportPath = join(dir, "report.json");
	const log: string[] = [];
	const model = new JourneyModel(
		options.script ?? {
			"checkout > charges the total": [GOOD],
			"checkout > logs nothing": [BAD],
		},
	);
	const filer = new JourneyFiler();
	const checkpoint = new JsonlCheckpointStore(join(dir, "checkpoint.jsonl"));

	try {
		const result = await runValidation(
			{
				model,
				checkpoint,
				filer,
				config: CONFIG,
				criteriaIds: ["C1", "C2", "C3", "C4", "C5", "C6", "C7"],
				criteriaSha256: CRITERIA_SHA,
				writeReport: (report) => {
					writeFileSync(reportPath, serializeReport(report), "utf8");
				},
				log: (line) => void log.push(line),
				now: () => new Date("2026-02-03T04:05:06.000Z"),
			},
			{
				inventory,
				sources: new Map([[FILE, source]]),
				runFingerprint: "1".repeat(64),
				headSha: "abc1234",
				restart: options.restart,
			},
		);

		const summary = [
			`counts: ${result.counts.discovered} judged (${result.counts.good} GOOD, ` +
				`${result.counts.bad} BAD, ${result.counts.pending} pending), ` +
				`${result.counts.excluded} excluded, ${result.counts.reused} reused`,
			result.report === null ? "report: none (incomplete run)" : `report: ${reportPath}`,
			result.issue === null ? "issue: none" : `issue: ${result.issue.url}`,
		];
		return { result, model, filer, log, reportPath, summary };
	} catch (error) {
		return error as Error;
	} finally {
		await checkpoint.close();
	}
}

async function withJourney(fn: (state: State) => Promise<void>): Promise<void> {
	const state: State = { prior: null };
	try {
		await fn(state);
	} finally {
		if (state.dir) rmSync(state.dir, { recursive: true, force: true });
	}
}

describe("journey: one audit, then a resume, then a changed inventory", () => {
	it("completes a 3-test fixture with one issue listing only the BAD test", async () => {
		await withJourney(async (state) => {
			const journey = await runJourney(state, {});
			assert.ok(!(journey instanceof Error), journey instanceof Error ? journey.message : "");
			const { result, filer, summary } = journey;

			assert.equal(result.complete, true);
			assert.deepEqual(
				summary[0],
				"counts: 2 judged (1 GOOD, 1 BAD, 0 pending), 1 excluded, 0 reused",
			);
			assert.match(summary[1], /report\.json$/);
			assert.deepEqual(summary[2], "issue: https://github.com/o/r/issues/7");

			const onDisk = JSON.parse(readFileSync(journey.reportPath, "utf8"));
			assert.equal(onDisk.counts.discovered, 2);
			assert.equal(onDisk.counts.excluded, 1);
			assert.deepEqual(
				onDisk.excluded.map((entry: { name: string; reason: string }) => [
					entry.name,
					entry.reason,
				]),
				[["checkout > waits for the printer", "skip"]],
			);

			assert.equal(filer.creates.length, 1);
			assert.match(filer.creates[0].title, /1 BAD tests/);
			assert.match(filer.creates[0].body, /logs nothing/);
			assert.doesNotMatch(filer.creates[0].body, /charges the total/);
			assert.match(filer.creates[0].body, /checkout\.test\.mts:\d+-\d+/);
		});
	});

	it("resumes an interrupted run without repeating decisions or issues", async () => {
		await withJourney(async (state) => {
			const interrupted = await runJourney(state, {
				script: {
					"checkout > charges the total": [GOOD],
					"checkout > logs nothing": [halting("provider went away")],
				},
			});
			assert.ok(interrupted instanceof RunHaltedError);
			assert.match(interrupted.message, /provider went away/);

			const resumed = await runJourney(state, {});
			assert.ok(!(resumed instanceof Error), resumed instanceof Error ? resumed.message : "");
			assert.deepEqual(resumed.model.calls, ["checkout > logs nothing"]);
			assert.equal(resumed.result.counts.reused, 1);
			assert.match(resumed.summary[0], /1 reused/);
			assert.equal(resumed.filer.creates.length, 1);
		});
	});

	it("halts on a changed inventory with counts and a restart hint", async () => {
		await withJourney(async (state) => {
			const first = await runJourney(state, {});
			assert.ok(!(first instanceof Error));

			// Same test name and line range, different body => "modified"; a new
			// describe/test appended at the end => "added".
			const mutated = `${SOURCE.replace("assert.ok(true);", "assert.ok(Boolean(1));")}
describe("extra", () => {
	it("is new", () => {});
});
`;
			const second = await runJourney(state, { source: mutated });

			assert.ok(second instanceof CheckpointMismatchError);
			assert.equal(second.kind, "inventory");
			assert.equal(second.added, 1);
			assert.equal(second.modified, 1);
			assert.equal(second.removed, 0);
			assert.match(second.message, /added 1, removed 0, modified 1/);
			assert.match(second.message, /--restart/);
		});
	});

	it("files nothing when the audit finds no BAD test", async () => {
		await withJourney(async (state) => {
			const journey = await runJourney(state, {
				script: {
					"checkout > charges the total": [GOOD],
					"checkout > logs nothing": [GOOD],
				},
			});
			assert.ok(!(journey instanceof Error));
			const { result, filer, summary } = journey;

			assert.equal(result.complete, true);
			assert.equal(result.issue, null);
			assert.deepEqual(summary[2], "issue: none");
			assert.equal(filer.creates.length, 0);
			assert.equal(readFileSync(journey.reportPath, "utf8").includes('"bad": 0'), true);
		});
	});
});
