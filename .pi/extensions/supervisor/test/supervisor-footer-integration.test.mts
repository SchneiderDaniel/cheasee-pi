/**
 * Tests: supervisor ↔ context-info issue-data bus (issue #2091)
 *
 * The supervisor pipeline used to push footer data through a dynamic import of
 * `context-info`, which builds a second module instance (jiti vs native ESM) —
 * so the write silently missed the live state. The shared `pi.events` bus is
 * the one supported path now, and the topic + payload shape live in a neutral
 * contract module (`lib/issue-data-event.ts`) imported by both sides.
 *
 * These assertions cover the producer side (topic constant, typed payload, no
 * duplicated wire literal) and the bus round-trip. Consumer behaviour lives in
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
import {
	ISSUE_DATA_EVENT,
	parseIssueDataEvent,
	type IssueDataEvent,
} from "../../lib/issue-data-event.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXTENSIONS_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const PRODUCER_PREFLIGHT = join(
	EXTENSIONS_ROOT,
	"supervisor",
	"pipeline",
	"handler",
	"preflight.ts",
);
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
// Producers reference the contract (adapter, static)
// ---------------------------------------------------------------------------

describe("supervisor producers — typed emit sites", () => {
	it("preflight emits the issue payload on ISSUE_DATA_EVENT", () => {
		const source = read(PRODUCER_PREFLIGHT);
		assert.match(
			source,
			/pi\.events\.emit\(\s*ISSUE_DATA_EVENT\s*,/,
			"preflight must emit on the contract topic",
		);
		assert.match(source, /issueNumber:\s*issueNum/, "payload carries the parsed issue number");
		assert.match(source, /issueRepo:\s*config\.repo/, "payload carries the configured repo");
		assert.match(source, /issueTitle:\s*runCtx\.issueTitle/, "payload carries the fetched title");
	});

	it("preflight payload is annotated IssueDataEvent so a shape change breaks the build", () => {
		const source = read(PRODUCER_PREFLIGHT);
		assert.match(
			source,
			/:\s*IssueDataEvent\s*=\s*\{/,
			"payload literal must be typed, `emit` takes `unknown` and cannot check it",
		);
	});

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
