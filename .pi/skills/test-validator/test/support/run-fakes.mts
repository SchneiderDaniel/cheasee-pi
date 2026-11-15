// Shared fakes and fixtures for the `runValidation` use-case tests.
//
// These are ports, not policy: every fake records calls so the tests can assert
// ordering, concurrency, and idempotency without a mocking library. Kept in a
// support module (never a `*.test.mts`) so both halves of the run suite share
// one definition of each port.

import type {
	CheckpointOpenOptions,
	CheckpointPrior,
	CheckpointStore,
	DecisionModel,
	IssueFiler,
	IssueIntent,
	IssueRecord,
} from "../../lib/ports.ts";
import { discoverTests } from "../../lib/inventory.ts";
import type { RunReport } from "../../lib/report.ts";
import { RunHaltedError, runValidation } from "../../lib/run.ts";
import type { DecisionRequest, TestDefinition, Verdict, ValidatorConfig } from "../../lib/types.ts";

export const RUN_FINGERPRINT = "a".repeat(64);
export const HEAD_SHA = "deadbeef";

export function config(overrides: Partial<ValidatorConfig> = {}): ValidatorConfig {
	return {
		provider: "test-provider",
		model: "test-model",
		concurrency: 2,
		badConfidenceThreshold: 0.8,
		maxAttempts: 3,
		haltAfterConsecutiveFailures: 5,
		...overrides,
	};
}

export const SOURCE = [
	'import { describe, it } from "node:test";',
	'describe("suite", () => {',
	'\tit("a-good", () => {',
	"\t\tassert.equal(1, 1);",
	"\t});",
	'\tit("b-bad", () => {',
	"\t\tassert.ok(true);",
	"\t});",
	'\tit("c-good", () => {',
	"\t\tassert.equal(2, 2);",
	"\t});",
	'\tit("d-good", () => {',
	"\t\tassert.equal(3, 3);",
	"\t});",
	'\tit("e-good", () => {',
	"\t\tassert.equal(4, 4);",
	"\t});",
	"});",
].join("\n");

export function fixture(source = SOURCE, file = "src/a.test.mts") {
	const inventory = discoverTests(source, file);
	return { inventory, sources: new Map([[file, source]]) };
}

export type Step = (request: DecisionRequest) => string;
export type Script = Record<string, Step[]>;

/** A GOOD verdict: project-owned behaviour, observed assertion. */
export const GOOD_STEP: Step = () =>
	JSON.stringify({
		decision: "GOOD",
		confidence: 0.9,
		criteria: ["C1", "C2"],
		reason: "asserts a project-owned observable",
		evidence: [],
	});

/** A BAD verdict that satisfies the gate: in-range, verbatim first line. */
export const BAD_STEP: Step = (request) =>
	JSON.stringify({
		decision: "BAD",
		confidence: 0.92,
		criteria: ["C2"],
		reason: "assertion only restates a literal",
		evidence: [{ line: request.startLine, quote: request.slice.split("\n")[0] }],
	});

/** A withheld decision: the parser must keep this PENDING. */
export const PENDING_STEP: Step = () =>
	JSON.stringify({
		decision: "AMBIGUOUS",
		confidence: 0.4,
		criteria: [],
		reason: "",
		evidence: [],
	});

/** A provider-level failure. */
export const throwing =
	(message: string): Step =>
	() => {
		throw new Error(message);
	};

export class FakeModel implements DecisionModel {
	readonly calls: string[] = [];
	inFlight = 0;
	maxInFlight = 0;
	#script: Script;
	#gate: (() => Promise<void>) | undefined;

	constructor(script: Script, gate?: () => Promise<void>) {
		this.#script = script;
		this.#gate = gate;
	}

	async decide(request: DecisionRequest): Promise<string> {
		this.calls.push(request.name);
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.#gate) await this.#gate();
			const steps = this.#script[request.name];
			if (!steps || steps.length === 0) throw new Error(`unscripted test ${request.name}`);
			const step = steps.length > 1 ? steps.shift()! : steps[0];
			return step(request);
		} finally {
			this.inFlight -= 1;
		}
	}
}

export class FakeCheckpoint implements CheckpointStore {
	readonly appends: string[] = [];
	prior: {
		resumed: boolean;
		archivePath: string | null;
		verdicts: Map<string, Verdict>;
		attempts: Map<string, number>;
		issueIntent: IssueIntent | null;
		issue: IssueRecord | null;
		rejected: Array<{ key: string; reason: string }>;
	};
	readonly verdictsWritten: Verdict[] = [];
	openOptions: CheckpointOpenOptions | null = null;
	refuse: Error | null = null;

	constructor(prior: Partial<CheckpointPrior> = {}) {
		this.prior = {
			resumed: false,
			archivePath: null,
			verdicts: new Map(),
			attempts: new Map(),
			issueIntent: null,
			issue: null,
			rejected: [],
			...prior,
		} as FakeCheckpoint["prior"];
	}

	async open(options: CheckpointOpenOptions): Promise<CheckpointPrior> {
		this.openOptions = options;
		if (this.refuse) throw this.refuse;
		this.appends.push("header");
		return this.prior;
	}

	async appendVerdict(_def: TestDefinition, verdict: Verdict): Promise<void> {
		this.appends.push("verdict");
		this.verdictsWritten.push(verdict);
	}

	async appendPending(): Promise<void> {
		this.appends.push("pending");
	}

	async recordIssueIntent(intent: IssueIntent): Promise<void> {
		this.appends.push("issue-intent");
		this.prior.issueIntent ??= intent;
	}

	async recordIssue(issue: IssueRecord): Promise<void> {
		this.appends.push("issue");
		this.prior.issue = issue;
	}

	async close(): Promise<void> {}
}

export class FakeFiler implements IssueFiler {
	readonly creates: Array<{ title: string; body: string }> = [];
	readonly searches: string[] = [];
	createThrows = false;
	searchThrows = false;
	searchResult: IssueRecord | null = null;
	readonly url = "https://example.test/issues/7";

	async create(input: { title: string; body: string }): Promise<{ url: string }> {
		if (this.createThrows) throw new Error("gh issue create failed");
		this.creates.push(input);
		return { url: this.url };
	}

	async search(input: { runFingerprint: string }): Promise<IssueRecord | null> {
		this.searches.push(input.runFingerprint);
		if (this.searchThrows) throw new Error("gh issue list failed");
		return this.searchResult;
	}
}

export interface Harness {
	deps: {
		model: FakeModel;
		checkpoint: FakeCheckpoint;
		filer: FakeFiler;
		config: ValidatorConfig;
		criteriaIds: string[];
		criteriaSha256: string;
		writeReport: (report: RunReport) => void;
		log: (line: string) => void;
	};
	reports: RunReport[];
	logs: string[];
}

export function harness(
	script: Script,
	options: {
		cfg?: Partial<ValidatorConfig>;
		prior?: Partial<CheckpointPrior>;
		gate?: () => Promise<void>;
	} = {},
): Harness {
	const reports: RunReport[] = [];
	const logs: string[] = [];
	return {
		reports,
		logs,
		deps: {
			model: new FakeModel(script, options.gate),
			checkpoint: new FakeCheckpoint(options.prior),
			filer: new FakeFiler(),
			config: config(options.cfg),
			criteriaIds: ["C1", "C2", "C3", "C4", "C5", "C6", "C7"],
			criteriaSha256: "5".repeat(64),
			writeReport: (report) => void reports.push(report),
			log: (line) => void logs.push(line),
		},
	};
}

export const ALL_GOOD: Script = {
	"suite > a-good": [GOOD_STEP],
	"suite > b-bad": [GOOD_STEP],
	"suite > c-good": [GOOD_STEP],
	"suite > d-good": [GOOD_STEP],
	"suite > e-good": [GOOD_STEP],
};

export function testKeyOf(def: TestDefinition): string {
	return `${def.file}:${def.startLine}-${def.endLine}:${def.name}`;
}
