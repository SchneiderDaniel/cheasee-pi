/**
 * Tests: supervisor ↔ context-info issue-data bus (issue #2091)
 *
 * The supervisor pipeline used to push footer data through a dynamic import of
 * `context-info`, which builds a second module instance (jiti vs native ESM) —
 * so the write silently missed the live state. The shared `pi.events` bus is
 * the one supported path now, and the topic + payload shape live in a neutral
 * contract module (`lib/issue-data-event.ts`) imported by both sides.
 *
 * These assertions cover the producer side (the real preflight phase, executed
 * against fake ports, plus no duplicated wire literal) and a full producer →
 * bus → footer round trip. Consumer unit behaviour lives in
 * `context-info/test/issue-data-event.test.mts`.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-footer-integration.test.mts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ISSUE_DATA_EVENT,
	parseIssueDataEvent,
	type IssueDataEvent,
} from "../../lib/issue-data-event.ts";
import type { ExecFn, ExecResult } from "../../lib/port-types.ts";
import { fetchIssueAndEmit } from "../pipeline/handler/preflight.ts";
import type { RunContext } from "../pipeline/handler/shared.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";
import type { SupervisorConfig } from "../config/types.ts";
import type { GitHubPort } from "../github/ports.ts";
import { FooterState } from "../../context-info/footer-state.ts";
import { applyIssueDataEvent } from "../../context-info/events-data.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXTENSIONS_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const PRODUCER_FINALLY = join(EXTENSIONS_ROOT, "supervisor", "pipeline", "handler", "index.ts");

function read(file: string): string {
	return readFileSync(file, "utf8");
}

/** Production sources under `.pi/extensions/**`; test dirs excluded. */
function productionSources(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "test" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) productionSources(full, acc);
		else if (/\.(ts|mts)$/.test(entry.name)) acc.push(full);
	}
	return acc;
}

/** Fake `pi.events` bus: `on` stores handlers, `emit` dispatches to them. */
function createFakeBus(): {
	on: (topic: string, handler: (payload: unknown) => void) => () => void;
	emit: (topic: string, payload: unknown) => void;
	topics: string[];
} {
	const topics: string[] = [];
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	return {
		topics,
		on: (topic, handler) => {
			topics.push(topic);
			const list = handlers.get(topic) ?? [];
			list.push(handler);
			handlers.set(topic, list);
			return () => {};
		},
		emit: (topic, payload) => {
			for (const handler of handlers.get(topic) ?? []) handler(payload);
		},
	};
}

// ---------------------------------------------------------------------------
// Bus round-trip
// ---------------------------------------------------------------------------

describe("issue-data bus — subscriber receives the producer payload", () => {
	it("emit on the contract topic reaches a subscriber registered on it", () => {
		const bus = createFakeBus();
		const received: unknown[] = [];
		bus.on(ISSUE_DATA_EVENT, (payload) => received.push(payload));

		const payload: IssueDataEvent = {
			issueNumber: 862,
			issueRepo: "owner/repo",
			issueTitle: "Add feature",
		};
		bus.emit(ISSUE_DATA_EVENT, payload);

		assert.equal(received.length, 1);
		assert.deepEqual(received[0], payload);
	});

	it("emitting with no listener registered does not throw", () => {
		const bus = createFakeBus();
		assert.doesNotThrow(() => bus.emit(ISSUE_DATA_EVENT, null));
		assert.deepEqual(bus.topics, []);
	});

	it("the clear sentinel and a payload are distinguishable through the guard", () => {
		assert.equal(parseIssueDataEvent(null), null);
		assert.deepEqual(parseIssueDataEvent({ issueNumber: 1, issueRepo: "o/r", issueTitle: "t" }), {
			issueNumber: 1,
			issueRepo: "o/r",
			issueTitle: "t",
		});
	});
});

// ---------------------------------------------------------------------------
// Producer — the real preflight phase, executed
// ---------------------------------------------------------------------------
// Source text cannot show what the pipeline actually publishes, so these run
// `fetchIssueAndEmit` (the phase that opens the run) with fake ports and
// capture the bus traffic.

const MOCK_ISSUE = {
	number: 7,
	title: "Add feature",
	body: "Body text",
	author: { login: "alice" },
	comments: [],
};

interface IssueRun {
	runCtx: RunContext;
	/** Every `pi.events.emit` the phase performed, in order. */
	emits: Array<{ topic: string; payload: unknown }>;
	issueMessages: string[];
	notifyErrors: string[];
}

/** Build a RunContext whose only real part is the phase under test. */
function createIssueRun(
	opts: { execResult?: ExecResult | Error; issue?: Record<string, unknown>; repo?: string } = {},
): IssueRun {
	const emits: Array<{ topic: string; payload: unknown }> = [];
	const issueMessages: string[] = [];
	const notifyErrors: string[] = [];
	const repo = opts.repo ?? "acme/widgets";
	const issue = opts.issue ?? MOCK_ISSUE;

	const exec: ExecFn = async () => {
		if (opts.execResult instanceof Error) throw opts.execResult;
		return opts.execResult ?? { code: 0, stdout: JSON.stringify(issue), stderr: "" };
	};
	const pi = {
		events: {
			emit: (topic: string, payload: unknown) => {
				emits.push({ topic, payload });
			},
		},
		sendMessage: (m: { content: string }) => {
			issueMessages.push(m.content);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: { notify: () => {}, setStatus: () => {} },
	} as unknown as ExtensionCommandContext;
	const runCtx = {
		ctx,
		pi,
		exec,
		notify: {
			info: () => {},
			error: (msg: string) => {
				notifyErrors.push(msg);
			},
		},
		collector: new ErrorCollector(),
		config: { repo, codeowners: ["alice"], projectNumber: 1 } as unknown as SupervisorConfig,
		port: { getAuthenticatedLogin: async () => "cheasee-bot" } as unknown as GitHubPort,
		issueNum: 42,
		issueTitle: "",
	} as unknown as RunContext;

	return { runCtx, emits, issueMessages, notifyErrors };
}

function issuePayloadOf(run: IssueRun): {
	issueNumber: number;
	issueRepo: string;
	issueTitle: string;
} {
	const dataEmit = run.emits.find((e) => e.topic === ISSUE_DATA_EVENT);
	assert.ok(dataEmit, "the phase must publish on ISSUE_DATA_EVENT");
	return dataEmit.payload as { issueNumber: number; issueRepo: string; issueTitle: string };
}

describe("supervisor producer — preflight publishes the issue under work", () => {
	it("success path emits the exact payload once, on the contract topic", async () => {
		const run = createIssueRun();

		const ok = await fetchIssueAndEmit(run.runCtx);

		assert.equal(ok, true, "phase continues after a successful fetch");
		assert.deepEqual(
			run.emits,
			[
				{
					topic: ISSUE_DATA_EVENT,
					payload: { issueNumber: 42, issueRepo: "acme/widgets", issueTitle: "Add feature" },
				},
			],
			"exactly one emit, with the full payload",
		);
		assert.equal(run.issueMessages.length, 1, "issue header message still sent");
		assert.match(run.issueMessages[0]!, /\[#42\] Add feature/, "header names the issue");
	});

	it("emitted payload passes the guard the consumer applies", async () => {
		const run = createIssueRun();
		await fetchIssueAndEmit(run.runCtx);

		const payload = issuePayloadOf(run);
		assert.deepEqual(
			parseIssueDataEvent(payload),
			payload,
			"a real emitted payload is accepted by the contract guard",
		);
	});

	it("payload carries the run's issue number, not the fetched document's", async () => {
		// The footer must name the issue this run owns; gh echoing another number
		// (or a repo redirect) must not change what the footer shows.
		const run = createIssueRun({ issue: { ...MOCK_ISSUE, number: 999 } });
		await fetchIssueAndEmit(run.runCtx);

		assert.equal(issuePayloadOf(run).issueNumber, 42);
	});

	it("payload carries config.repo, not the fetched document's repo", async () => {
		const run = createIssueRun({ repo: "SchneiderDaniel/cheasee-pi" });
		await fetchIssueAndEmit(run.runCtx);

		const payload = issuePayloadOf(run);
		assert.equal(payload.issueRepo, "SchneiderDaniel/cheasee-pi");
		assert.equal(payload.issueTitle, "Add feature", "title comes from the fetched issue");
	});

	it("missing title falls back to `Issue #<n>` in the emitted payload", async () => {
		const run = createIssueRun({ issue: { ...MOCK_ISSUE, title: undefined } });

		const ok = await fetchIssueAndEmit(run.runCtx);

		assert.equal(ok, true);
		assert.equal(issuePayloadOf(run).issueTitle, "Issue #42");
	});

	it("empty gh output still yields a payload (fetchIssue returns {}, not null)", async () => {
		const run = createIssueRun({ execResult: { code: 0, stdout: "", stderr: "" } });

		const ok = await fetchIssueAndEmit(run.runCtx);

		assert.equal(ok, true, "an empty document is not a fetch failure");
		assert.equal(issuePayloadOf(run).issueTitle, "Issue #42");
	});

	it("failed fetch → returns false and publishes nothing", async () => {
		const run = createIssueRun({ execResult: new Error("gh: issue not found") });

		const ok = await fetchIssueAndEmit(run.runCtx);

		assert.equal(ok, false, "phase stops the pipeline");
		assert.deepEqual(run.emits, [], "no footer write for an issue that was never fetched");
		assert.equal(run.runCtx.issueTitle, "", "no title captured on the failure path");
		assert.equal(run.notifyErrors.length, 1, "fetch failure is user-visible");
	});
});

// ---------------------------------------------------------------------------
// Producer → bus → footer round trip
// ---------------------------------------------------------------------------

describe("issue-data round trip — producer payload reaches the footer", () => {
	it("what preflight emits lands in the footer's issue fields", async () => {
		const bus = createFakeBus();
		const state = new FooterState({} as ExtensionContext, () => {});
		// Same wiring the context-info listener uses: guard, then map.
		bus.on(ISSUE_DATA_EVENT, (raw) => applyIssueDataEvent(state, parseIssueDataEvent(raw)));

		const run = createIssueRun();
		run.runCtx.pi = {
			...(run.runCtx.pi as unknown as Record<string, unknown>),
			events: bus,
		} as unknown as ExtensionAPI;

		await fetchIssueAndEmit(run.runCtx);

		assert.equal(state.footerConfig.issueNumber.value, 42);
		assert.equal(state.footerConfig.issueRepo.value, "acme/widgets");
		assert.equal(state.footerConfig.issueTitle.value, "Add feature");
	});
});

// ---------------------------------------------------------------------------
// Producers reference the contract (static guards)
// ---------------------------------------------------------------------------

describe("supervisor producers — single source for the wire contract", () => {
	it("handler finally clears with a typed null on ISSUE_DATA_EVENT", () => {
		const source = read(PRODUCER_FINALLY);
		assert.match(source, /pi\.events\.emit\(\s*ISSUE_DATA_EVENT\s*,/, "finally emits the clear");
		assert.match(source, /:\s*IssueDataEvent\s*=\s*null/, "clear sentinel is typed");
	});

	it("no production source repeats the wire literal — only the contract module owns it", () => {
		const offenders: string[] = [];
		for (const file of productionSources(EXTENSIONS_ROOT)) {
			if (read(file).includes('"supervisor:issue-data"'))
				offenders.push(relative(EXTENSIONS_ROOT, file));
		}
		assert.deepEqual(offenders, [join("lib", "issue-data-event.ts")]);
	});

	it("the context-info consumer subscribes on the constant, not a literal", () => {
		const source = read(join(EXTENSIONS_ROOT, "context-info", "events.ts"));
		assert.match(source, /pi\.events\.on\(\s*ISSUE_DATA_EVENT\s*,/, "consumer uses the constant");
	});
});
