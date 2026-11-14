/**
 * runner-presenter.test.mts — RunPresenter port + ctx.ui adapter (issue #2106).
 *
 * The CodeFlow `utils → ui` finding resolved to a real coupling: the runner's
 * process/state machinery called `ctx.ui` directly. The fix puts a port at the
 * presentation seam.
 *
 * Phase 1: `runner/presenter.ts` is a dependency-free inner type (distance 0) —
 *          no `ui`, `session/` or SDK import, so the use cases can depend on it.
 * Phase 2: `createRunPresenter` is the outer adapter and the only module in
 *          runner/ that owns `ctx.ui`. Operator-visible cadence is preserved:
 *          300ms debounce, 2s heartbeat, widget → working message → status
 *          teardown order, render-error containment.
 *
 * Real timers (matching runner-split-part3 style). Every test disposes the
 * presenter — the heartbeat interval would otherwise hold the suite open.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph } from "../../lib/test/source-graph.ts";
import { createRunPresenter } from "../agent/runner/ui.ts";
import type { RunPresenter } from "../agent/runner/presenter.ts";
import { createAgentRunState } from "../agent/state-helpers.ts";
import { getDebugLogger } from "../lib/debug.ts";
import {
	ErrorCollector,
	getErrorCollector,
	resetErrorCollector,
	setErrorCollector,
} from "../pipeline/error-collector.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESENTER_FILE = join(__dirname, "../agent/runner/presenter.ts");

const MEMBERS = [
	"scheduleFlush",
	"setWorkingMessage",
	"announceStart",
	"clear",
	"dispose",
] as const;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface UiCall {
	method: string;
	args: unknown[];
}

interface UiRecorder {
	ctx: any;
	calls: UiCall[];
	ui: Record<"notify" | "setStatus" | "setWidget" | "setWorkingMessage", (...args: any[]) => void>;
	argsOf(method: string): unknown[][];
}

/** Recording `ctx.ui` — one ordered ledger of every operator-visible call. */
function createUiRecorder(): UiRecorder {
	const calls: UiCall[] = [];
	const record = (method: string) => {
		return (...args: unknown[]): void => {
			calls.push({ method, args });
		};
	};
	const ui = {
		notify: record("notify"),
		setStatus: record("setStatus"),
		setWidget: record("setWidget"),
		setWorkingMessage: record("setWorkingMessage"),
	};
	return {
		ctx: { cwd: "/tmp/work", ui },
		calls,
		ui,
		argsOf: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
	};
}

/** Every presenter built here — disposed in the global `after` hook so a
 *  failed assertion can never leave the 2s heartbeat holding the suite open. */
const livePresenters: RunPresenter[] = [];

after(() => {
	for (const presenter of livePresenters) presenter.dispose();
	resetErrorCollector();
});

function presenterFor(rec: UiRecorder, agentName = "x"): RunPresenter {
	const presenter = createRunPresenter({
		ctx: rec.ctx,
		widgetId: `agent-${agentName}`,
		agentName,
		model: "test/model",
		state: createAgentRunState(Date.now()),
	});
	livePresenters.push(presenter);
	return presenter;
}

describe("Phase 1: RunPresenter is a dependency-free inner port", () => {
	it("imports nothing from the UI, session or SDK layer (distance 0)", () => {
		const graph = readGraph(PRESENTER_FILE);
		for (const specifier of graph.specifiers) {
			assert.ok(
				!/ui|session\/|@earendil-works\/pi-coding-agent/.test(specifier),
				`presenter.ts must stay presentation-free, found import "${specifier}"`,
			);
		}
	});

	it("declares the RunPresenter contract", () => {
		assert.ok(
			readGraph(PRESENTER_FILE).declarations.includes("RunPresenter"),
			"RunPresenter declared in presenter.ts",
		);
	});

	it("declares exactly the five documented contract members", () => {
		// `readGraph` records top-level declarations, not interface members, so the
		// contract body is checked directly: a stray 6th member or a renamed one
		// would silently widen the port every adapter has to implement.
		const source = readFileSync(PRESENTER_FILE, "utf-8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
		const body = source.match(/interface\s+RunPresenter\s*\{([\s\S]*?)\n\}/)?.[1];
		assert.ok(body, "RunPresenter interface body found in presenter.ts");
		const members = [...(body as string).matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\(/gm)].map(
			(m) => m[1]!,
		);
		assert.deepEqual(
			[...members].sort(),
			[...MEMBERS].sort(),
			"the port declares exactly the five members",
		);
	});

	it("is importable at runtime with no side effects (types only)", async () => {
		const mod = await import("../agent/runner/presenter.ts");
		assert.equal(typeof mod, "object", "type-only module loads without throwing");
	});

	it("the five members are the complete contract (a test fake satisfies it)", () => {
		// The second adapter that justifies the seam: any plain object with these
		// five methods is a presenter, so use cases never need ctx.ui.
		const fake: RunPresenter = {
			scheduleFlush: () => {},
			setWorkingMessage: () => {},
			announceStart: () => {},
			clear: () => {},
			dispose: () => {},
		};
		for (const member of MEMBERS) {
			assert.equal(typeof (fake as any)[member], "function", `RunPresenter.${member}`);
		}
		assert.deepEqual(
			Object.keys(fake).sort(),
			[...MEMBERS].sort(),
			"no member beyond the documented five",
		);
	});
});

describe("Phase 2: createRunPresenter — the ctx.ui adapter", () => {
	it("returns all five port members as functions", () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);
		for (const member of MEMBERS) {
			assert.equal(typeof (presenter as any)[member], "function", `createRunPresenter().${member}`);
		}
		presenter.dispose();
	});

	it("scheduleFlush debounces the widget render by 300ms", async () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.scheduleFlush();
		assert.equal(rec.argsOf("setWidget").length, 0, "nothing rendered synchronously");
		await wait(400);

		const renders = rec.argsOf("setWidget");
		assert.ok(renders.length >= 1, "debounced flush rendered the widget");
		assert.equal(renders[0]![0], "agent-x", "rendered against the run's widget id");
		assert.ok(Array.isArray(renders[0]![1]), "widget body built by buildWidgetLines");
		presenter.dispose();
	});

	it("coalesces a burst of scheduleFlush calls into one render", async () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.scheduleFlush();
		presenter.scheduleFlush();
		presenter.scheduleFlush();
		await wait(400);

		assert.equal(rec.argsOf("setWidget").length, 1, "burst inside the 300ms window renders once");
		presenter.dispose();
	});

	it("heartbeat renders at least once during a quiet run", async () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		await wait(2100);
		assert.ok(rec.argsOf("setWidget").length >= 1, "2s heartbeat kept the widget alive");
		presenter.dispose();
	});

	it("setWorkingMessage forwards the message, and undefined clears it (never '')", () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.setWorkingMessage("x: bash");
		presenter.setWorkingMessage();
		presenter.setWorkingMessage(undefined);

		const args = rec.argsOf("setWorkingMessage");
		assert.deepEqual(args[0], ["x: bash"]);
		assert.deepEqual(args[1], [undefined]);
		assert.deepEqual(args[2], [undefined]);
		assert.ok(
			args.every((a) => a[0] !== ""),
			"clearing uses undefined, never an empty string",
		);
		presenter.dispose();
	});

	it("announceStart notifies then sets the supervisor status, in that order", () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.announceStart("x");

		assert.deepEqual(rec.calls, [
			{ method: "notify", args: ["Running agent: x...", "info"] },
			{ method: "setStatus", args: ["supervisor", "Running x..."] },
		]);
		presenter.dispose();
	});

	it("clear() tears down widget → working message → status, with no empty-string clears", () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.clear();

		assert.equal(rec.calls.length, 3, "exactly three teardown calls");
		assert.deepEqual(rec.calls, [
			{ method: "setWidget", args: ["agent-x", undefined] },
			{ method: "setWorkingMessage", args: [undefined] },
			{ method: "setStatus", args: ["supervisor", undefined] },
		]);
		assert.ok(
			rec.calls.every((c) => c.args[1] !== ""),
			"no empty-string clears",
		);
		presenter.dispose();
	});

	it("clear() is idempotent and never resurrects timers, even after dispose()", async () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.clear();
		assert.equal(rec.calls.length, 3);
		presenter.clear();
		assert.equal(rec.calls.length, 6, "second clear is another full teardown (no throw)");

		presenter.dispose();
		presenter.clear();
		assert.equal(rec.calls.length, 9, "clear after dispose still tears down, no throw");

		await wait(400);
		assert.equal(rec.argsOf("setWidget").length, 3, "no timer resurrection after dispose");
	});

	it("dispose cancels the pending debounce", async () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.scheduleFlush();
		presenter.dispose();
		await wait(400);

		assert.equal(rec.argsOf("setWidget").length, 0, "cancelled debounce never renders");
	});

	it("dispose stops the heartbeat and is idempotent", async () => {
		const rec = createUiRecorder();
		const presenter = presenterFor(rec);

		presenter.dispose();
		presenter.dispose();
		await wait(2200);

		assert.equal(rec.argsOf("setWidget").length, 0, "no heartbeat render after dispose");
	});

	it("contains setWidget render errors: debug log + error collector entry, never throws", async (t) => {
		const rec = createUiRecorder();
		rec.ui.setWidget = () => {
			throw new Error("render exploded");
		};
		const log = getDebugLogger();
		const errorSpy = t.mock.method(log, "error");
		const collector = new ErrorCollector();
		setErrorCollector(collector);

		const presenter = presenterFor(rec);
		assert.doesNotThrow(() => presenter.scheduleFlush());
		await wait(400);

		assert.equal(errorSpy.mock.callCount(), 1, "one debug-log error per failed render");
		assert.equal(errorSpy.mock.calls[0]!.arguments[0], "agent-runner");
		const collected = collector.flush("runner");
		assert.equal(collected.length, 1, "failure surfaced to the operator warning panel");
		assert.equal(collected[0]!.severity, "warn");
		assert.match(collected[0]!.message, /render exploded/);
		assert.equal(getErrorCollector(), collector, "the wired collector received the entry");
		presenter.dispose();
	});
});
