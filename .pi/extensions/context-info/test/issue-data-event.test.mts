/**
 * Tests: shared issue-data event contract + consumer mapping (issue #2091)
 *
 * Phase 1 — the neutral contract module: topic constant, payload type, guard.
 * Phase 2 — `applyIssueDataEvent` maps the typed payload onto FooterConfig.
 * Phase 3 — `registerFooterEvents` subscribes on the typed topic and routes
 *           the payload through the guard into the live footer state.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/issue-data-event.test.mts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FooterState } from "../footer-state.ts";
import { applyIssueDataEvent } from "../events-data.ts";
import { registerFooterEvents } from "../events.ts";
import {
	ISSUE_DATA_EVENT,
	parseIssueDataEvent,
	type IssueDataEvent,
} from "../../lib/issue-data-event.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createMockCtx(): any {
	return {
		ui: {
			setFooter: mock.fn(),
			setStatus: mock.fn(),
			setWidget: mock.fn(),
			setWorkingIndicator: mock.fn(),
			notify: mock.fn(),
			theme: { fg: (_color: string, text: string) => text },
		},
		model: { id: "test-model", contextWindow: 128000 },
		getContextUsage: () => ({ tokens: 5000, contextWindow: 128000 }),
		sessionManager: { getSessionFile: () => "/tmp/test_12345.jsonl" },
		cwd: "/tmp",
	};
}

interface FakeBus {
	on: (topic: string, handler: (payload: unknown) => void) => () => void;
	emit: (topic: string, payload: unknown) => void;
	/** Topics the extension actually subscribed to, in registration order. */
	topics: string[];
	/** Handlers per topic, so a test can fire the extension's listener. */
	handlers: Map<string, Array<(payload: unknown) => void>>;
	fire: (topic: string, payload: unknown) => void;
}

function createFakeBus(): FakeBus {
	const topics: string[] = [];
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	const on = (topic: string, handler: (payload: unknown) => void) => {
		topics.push(topic);
		const list = handlers.get(topic) ?? [];
		list.push(handler);
		handlers.set(topic, list);
		return () => {};
	};
	const fire = (topic: string, payload: unknown) => {
		for (const handler of handlers.get(topic) ?? []) handler(payload);
	};
	return {
		on,
		emit: fire,
		topics,
		handlers,
		fire,
	};
}

function createFakePi(): { pi: ExtensionAPI; bus: FakeBus } {
	const bus = createFakeBus();
	const pi = {
		events: { on: bus.on, emit: bus.emit },
		on: () => {},
		getSessionName: () => "test-session",
	} as unknown as ExtensionAPI;
	return { pi, bus };
}

function readSource(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// Phase 1: neutral contract module
// ---------------------------------------------------------------------------

describe("issue-data contract — topic constant", () => {
	it('ISSUE_DATA_EVENT pins the wire value "supervisor:issue-data"', () => {
		assert.equal(ISSUE_DATA_EVENT, "supervisor:issue-data");
	});

	it("contract module is neutral — no import from context-info/ or supervisor/", () => {
		const source = readSource("../../lib/issue-data-event.ts");
		assert.ok(
			!/from\s+["'][^"']*(context-info|supervisor)[^"']*["']/.test(source),
			"contract module must not import either extension",
		);
	});
});

describe("issue-data contract — parseIssueDataEvent guard", () => {
	it("null stays null (clear sentinel preserved)", () => {
		assert.equal(parseIssueDataEvent(null), null);
	});

	it("well-formed payload returns the three fields", () => {
		const parsed = parseIssueDataEvent({
			issueNumber: 862,
			issueRepo: "owner/repo",
			issueTitle: "Add feature",
		});
		assert.deepEqual(parsed, {
			issueNumber: 862,
			issueRepo: "owner/repo",
			issueTitle: "Add feature",
		});
	});

	it("extra fields are dropped, not forwarded", () => {
		const parsed = parseIssueDataEvent({
			issueNumber: 1,
			issueRepo: "o/r",
			issueTitle: "t",
			supervisorSecret: "leak",
		});
		assert.deepEqual(Object.keys(parsed as object).sort(), [
			"issueNumber",
			"issueRepo",
			"issueTitle",
		]);
	});

	it("boundary values are accepted verbatim (0, empty strings, long title)", () => {
		assert.deepEqual(parseIssueDataEvent({ issueNumber: 0, issueRepo: "", issueTitle: "" }), {
			issueNumber: 0,
			issueRepo: "",
			issueTitle: "",
		});
		const longTitle = "x".repeat(500);
		const parsed = parseIssueDataEvent({ issueNumber: 7, issueRepo: "o/r", issueTitle: longTitle });
		assert.equal((parsed as { issueTitle: string }).issueTitle.length, 500);
	});

	it("non-object payloads are rejected as undefined (ignored, not a clear)", () => {
		for (const raw of [undefined, "owner/repo", 42, true]) {
			assert.equal(parseIssueDataEvent(raw), undefined, `raw=${String(raw)}`);
		}
	});

	it("missing or wrongly typed fields are rejected as undefined", () => {
		assert.equal(parseIssueDataEvent({}), undefined);
		assert.equal(parseIssueDataEvent({ issueNumber: 1, issueRepo: "o/r" }), undefined);
		assert.equal(
			parseIssueDataEvent({ issueNumber: "1", issueRepo: "o/r", issueTitle: "t" }),
			undefined,
		);
		assert.equal(
			parseIssueDataEvent({ issueNumber: Number.NaN, issueRepo: "o/r", issueTitle: "t" }),
			undefined,
		);
		assert.equal(parseIssueDataEvent({ issueNumber: 1, issueRepo: 9, issueTitle: "t" }), undefined);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: consumer mapping — applyIssueDataEvent
// ---------------------------------------------------------------------------

describe("applyIssueDataEvent — payload → footer config", () => {
	it("typed payload sets issueNumber, issueRepo and issueTitle", () => {
		const state = new FooterState(createMockCtx());

		applyIssueDataEvent(state, {
			issueNumber: 862,
			issueRepo: "owner/repo",
			issueTitle: "Add feature",
		});

		assert.equal(state.footerConfig.issueNumber.value, 862);
		assert.equal(state.footerConfig.issueRepo.value, "owner/repo");
		assert.equal(state.footerConfig.issueTitle.value, "Add feature");
	});

	it("a second payload overwrites all three fields (no stale title/repo)", () => {
		const state = new FooterState(createMockCtx());

		applyIssueDataEvent(state, { issueNumber: 100, issueRepo: "org/one", issueTitle: "First" });
		applyIssueDataEvent(state, { issueNumber: 200, issueRepo: "org/two", issueTitle: "Second" });

		assert.equal(state.footerConfig.issueNumber.value, 200);
		assert.equal(state.footerConfig.issueRepo.value, "org/two");
		assert.equal(state.footerConfig.issueTitle.value, "Second");
	});

	it("null clears all three fields", () => {
		const state = new FooterState(createMockCtx());
		applyIssueDataEvent(state, { issueNumber: 862, issueRepo: "owner/repo", issueTitle: "Add" });

		applyIssueDataEvent(state, null);

		assert.equal(state.footerConfig.issueNumber.value, undefined);
		assert.equal(state.footerConfig.issueRepo.value, undefined);
		assert.equal(state.footerConfig.issueTitle.value, undefined);
	});

	it("null on already-cleared state is idempotent (no throw)", () => {
		const state = new FooterState(createMockCtx());

		assert.doesNotThrow(() => applyIssueDataEvent(state, null));
		assert.equal(state.footerConfig.issueNumber.value, undefined);
	});

	it("boundary values are stored verbatim", () => {
		const state = new FooterState(createMockCtx());

		applyIssueDataEvent(state, { issueNumber: 0, issueRepo: "", issueTitle: "" });
		assert.equal(state.footerConfig.issueNumber.value, 0);
		assert.equal(state.footerConfig.issueRepo.value, "");
		assert.equal(state.footerConfig.issueTitle.value, "");

		const longTitle = "y".repeat(500);
		applyIssueDataEvent(state, { issueNumber: 3, issueRepo: "o/r", issueTitle: longTitle });
		assert.equal(state.footerConfig.issueTitle.value, longTitle);
	});

	it("re-renders through _requestRender when it is installed (no footer re-install)", () => {
		const installFooterCb = mock.fn();
		const requestRender = mock.fn();
		const state = new FooterState(createMockCtx(), installFooterCb);
		state.footerConfig._requestRender = requestRender;

		applyIssueDataEvent(state, { issueNumber: 862, issueRepo: "owner/repo", issueTitle: "Add" });

		assert.equal(requestRender.mock.calls.length, 1);
		assert.equal(installFooterCb.mock.calls.length, 0);
	});

	it("falls back to callInstallFooter when _requestRender is absent", () => {
		const installFooterCb = mock.fn();
		const state = new FooterState(createMockCtx(), installFooterCb);
		state.footerConfig._requestRender = undefined;

		applyIssueDataEvent(state, { issueNumber: 862, issueRepo: "owner/repo", issueTitle: "Add" });

		assert.equal(installFooterCb.mock.calls.length, 1);
	});

	it("tolerates a foreign payload at runtime: no throw, no mutation, no render", () => {
		const installFooterCb = mock.fn();
		const requestRender = mock.fn();
		const state = new FooterState(createMockCtx(), installFooterCb);
		state.footerConfig._requestRender = requestRender;
		state.footerConfig.issueNumber.value = 42;

		assert.doesNotThrow(() => applyIssueDataEvent(state, undefined));

		assert.equal(state.footerConfig.issueNumber.value, 42, "field untouched");
		assert.equal(state.footerConfig.issueRepo.value, undefined);
		assert.equal(requestRender.mock.calls.length, 0, "nothing changed, nothing to render");
		assert.equal(installFooterCb.mock.calls.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: consumer listener wiring — registerFooterEvents
// ---------------------------------------------------------------------------

describe("registerFooterEvents — issue-data listener", () => {
	it("subscribes on exactly ISSUE_DATA_EVENT", () => {
		const { pi, bus } = createFakePi();
		const state = new FooterState(createMockCtx());

		registerFooterEvents(pi, () => state);

		assert.deepEqual(bus.topics, [ISSUE_DATA_EVENT]);
	});

	it("payload arriving on the bus reaches the footer and requests a render", () => {
		const { pi, bus } = createFakePi();
		const requestRender = mock.fn();
		const state = new FooterState(createMockCtx());
		state.footerConfig._requestRender = requestRender;
		registerFooterEvents(pi, () => state);

		bus.fire(ISSUE_DATA_EVENT, { issueNumber: 862, issueRepo: "owner/repo", issueTitle: "Add" });

		assert.equal(state.footerConfig.issueNumber.value, 862);
		assert.equal(state.footerConfig.issueRepo.value, "owner/repo");
		assert.equal(state.footerConfig.issueTitle.value, "Add");
		assert.equal(requestRender.mock.calls.length, 1);
	});

	it("null on the bus clears the footer", () => {
		const { pi, bus } = createFakePi();
		const state = new FooterState(createMockCtx());
		registerFooterEvents(pi, () => state);

		bus.fire(ISSUE_DATA_EVENT, { issueNumber: 862, issueRepo: "owner/repo", issueTitle: "Add" });
		bus.fire(ISSUE_DATA_EVENT, null);

		assert.equal(state.footerConfig.issueNumber.value, undefined);
		assert.equal(state.footerConfig.issueRepo.value, undefined);
		assert.equal(state.footerConfig.issueTitle.value, undefined);
	});

	it("a foreign payload on the bus is ignored (no mutation, no render)", () => {
		const { pi, bus } = createFakePi();
		const requestRender = mock.fn();
		const installFooterCb = mock.fn();
		const state = new FooterState(createMockCtx(), installFooterCb);
		state.footerConfig._requestRender = requestRender;
		registerFooterEvents(pi, () => state);

		assert.doesNotThrow(() => bus.fire(ISSUE_DATA_EVENT, { issueNumber: "862" }));

		assert.equal(state.footerConfig.issueNumber.value, undefined);
		assert.equal(requestRender.mock.calls.length, 0);
		assert.equal(installFooterCb.mock.calls.length, 0);
	});

	it("no state yet (before session_start) → no throw, no render", () => {
		const { pi, bus } = createFakePi();
		const installFooterCb = mock.fn();
		registerFooterEvents(pi, () => undefined);

		assert.doesNotThrow(() => bus.fire(ISSUE_DATA_EVENT, null));
		assert.doesNotThrow(() =>
			bus.fire(ISSUE_DATA_EVENT, { issueNumber: 1, issueRepo: "o/r", issueTitle: "t" }),
		);
		assert.equal(installFooterCb.mock.calls.length, 0);
	});

	it("disposed state → no mutation, no render, no throw", () => {
		const { pi, bus } = createFakePi();
		const installFooterCb = mock.fn();
		const requestRender = mock.fn();
		const state = new FooterState(createMockCtx(), installFooterCb);
		state.footerConfig._requestRender = requestRender;
		registerFooterEvents(pi, () => state);
		state.dispose();

		assert.doesNotThrow(() =>
			bus.fire(ISSUE_DATA_EVENT, { issueNumber: 862, issueRepo: "owner/repo", issueTitle: "Add" }),
		);

		assert.equal(state.footerConfig.issueNumber.value, undefined);
		assert.equal(requestRender.mock.calls.length, 0);
		assert.equal(installFooterCb.mock.calls.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Compile-time contract (never executed — enforced by `tsc --noEmit`)
// ---------------------------------------------------------------------------

/** Never called — type-level checks only. */
function _issueDataContractTypeChecks(): void {
	const set: IssueDataEvent = { issueNumber: 1, issueRepo: "o/r", issueTitle: "t" };
	const clear: IssueDataEvent = null;
	void set;
	void clear;

	// @ts-expect-error — issueNumber must be a number, not a string
	const wrongNumber: IssueDataEvent = { issueNumber: "1", issueRepo: "o/r", issueTitle: "t" };
	// @ts-expect-error — issueTitle is required
	const missingTitle: IssueDataEvent = { issueNumber: 1, issueRepo: "o/r" };
	void wrongNumber;
	void missingTitle;
}
void _issueDataContractTypeChecks;
