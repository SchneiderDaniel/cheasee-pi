/**
 * Regression tests for the project-local ponytail extension adapter.
 *
 * Context (issue #1776): the extension registered its teardown cleanup on
 * "session_end", which is not a Pi event — Pi emits "session_shutdown".
 * `pi.on` stores unknown keys silently in a Map, and index.js sits outside
 * .pi/tsconfig.json, so the registration-key assertion is the only guard.
 *
 * Run from the repo root (index.js resolves its hooks from process.cwd()):
 *   node --experimental-strip-types --test .pi/extensions/ponytail/test/ponytail-index.test.mts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Non-literal dynamic import: the adapter is plain JS with no declarations,
// and this keeps the test honest about loading the real runtime module.
const indexUrl = new URL("../index.js", import.meta.url).href;
const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf-8");

type Handler = (...args: unknown[]) => unknown;

interface MockPi {
	pi: {
		on: (event: string, handler: Handler) => () => void;
		registerCommand: (name: string, def: { handler: Handler }) => void;
		appendEntry: (type: string, data: unknown) => void;
		sendUserMessage: (message: string, opts?: unknown) => void;
	};
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: Handler }>;
	calls: { on: number; registerCommand: number; appendEntry: number; sendUserMessage: number };
}

function makeMockPi(): MockPi {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const calls = { on: 0, registerCommand: 0, appendEntry: 0, sendUserMessage: 0 };

	const pi: MockPi["pi"] = {
		on: (event, handler) => {
			calls.on += 1;
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (name, def) => {
			calls.registerCommand += 1;
			commands.set(name, def);
		},
		appendEntry: () => {
			calls.appendEntry += 1;
		},
		sendUserMessage: () => {
			calls.sendUserMessage += 1;
		},
	};

	return { pi, handlers, commands, calls };
}

interface RecordingCtx {
	ctx: Record<string, unknown>;
	statusCalls: [string, unknown][];
}

function makeRecordingCtx(): RecordingCtx {
	const statusCalls: [string, unknown][] = [];
	const ctx = {
		ui: {
			setStatus: (key: string, value: unknown) => {
				statusCalls.push([key, value]);
			},
			notify: () => {},
		},
		sessionManager: { getEntries: () => [], getBranch: () => [] },
		isIdle: () => true,
	};
	return { ctx, statusCalls };
}

async function loadExtension(): Promise<(pi: unknown) => void> {
	const mod = (await import(indexUrl)) as { default: (pi: unknown) => void };
	return mod.default;
}

const REASONS = ["quit", "reload", "new", "resume", "fork"] as const;

describe("ponytail — teardown registered on the Pi-emitted event", () => {
	it("registers a session_shutdown handler", async () => {
		const extension = await loadExtension();
		const { pi, handlers } = makeMockPi();
		extension(pi);
		assert.ok(handlers.has("session_shutdown"), "expected session_shutdown to be registered");
	});

	it("does not register the non-existent session_end event", async () => {
		const extension = await loadExtension();
		const { pi, handlers } = makeMockPi();
		extension(pi);
		assert.ok(!handlers.has("session_end"), "session_end is not a Pi event and must not be used");
	});

	it("preserves the existing lifecycle contract", async () => {
		const extension = await loadExtension();
		const { pi, handlers } = makeMockPi();
		extension(pi);
		for (const event of ["session_start", "input", "before_agent_start"]) {
			assert.ok(handlers.has(event), `expected ${event} to still be registered`);
		}
	});
});

describe("ponytail — shutdown clears footer status with undefined", () => {
	it("invokes setStatus('ponytail', undefined) exactly once", async () => {
		const extension = await loadExtension();
		const { pi, handlers } = makeMockPi();
		extension(pi);
		const handler = handlers.get("session_shutdown");
		assert.ok(handler, "session_shutdown handler missing");

		const { ctx, statusCalls } = makeRecordingCtx();
		await handler({ type: "session_shutdown", reason: "reload" }, ctx);
		assert.deepStrictEqual(statusCalls, [["ponytail", undefined]]);
	});

	it("tolerates an undefined ctx without throwing", async () => {
		const extension = await loadExtension();
		const { pi, handlers } = makeMockPi();
		extension(pi);
		const handler = handlers.get("session_shutdown");
		assert.ok(handler);
		await assert.doesNotReject(async () => handler({}, undefined));
	});

	it("tolerates a ctx without ui without throwing", async () => {
		const extension = await loadExtension();
		const { pi, handlers } = makeMockPi();
		extension(pi);
		const handler = handlers.get("session_shutdown");
		assert.ok(handler);
		await assert.doesNotReject(async () => handler({}, {}));
	});

	it("does not call registration APIs during shutdown (stale runtime)", async () => {
		const extension = await loadExtension();
		const { pi, handlers, calls } = makeMockPi();
		extension(pi);
		const handler = handlers.get("session_shutdown");
		assert.ok(handler);

		const before = { ...calls };
		const { ctx } = makeRecordingCtx();
		await handler({ type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(calls.on, before.on, "pi.on must not be called during shutdown");
		assert.equal(
			calls.registerCommand,
			before.registerCommand,
			"pi.registerCommand must not be called during shutdown",
		);
	});

	it("tolerates every SessionShutdownEvent reason", async () => {
		const extension = await loadExtension();
		const { pi, handlers } = makeMockPi();
		extension(pi);
		const handler = handlers.get("session_shutdown");
		assert.ok(handler);

		for (const reason of REASONS) {
			const { ctx, statusCalls } = makeRecordingCtx();
			await assert.doesNotReject(
				async () => handler({ type: "session_shutdown", reason }, ctx),
				`reason ${reason} must not throw`,
			);
			assert.deepStrictEqual(
				statusCalls,
				[["ponytail", undefined]],
				`reason ${reason} should clear status with undefined`,
			);
		}
	});
});

describe("ponytail — off branch clears with undefined, never blank string", () => {
	it("/ponytail off calls setStatus('ponytail', undefined)", async () => {
		const extension = await loadExtension();
		const { pi, commands } = makeMockPi();
		extension(pi);
		const command = commands.get("ponytail");
		assert.ok(command, "ponytail command missing");

		const { ctx, statusCalls } = makeRecordingCtx();
		await command.handler("off", ctx);

		assert.deepStrictEqual(statusCalls, [["ponytail", undefined]]);
		assert.ok(
			statusCalls.every(([, value]) => value !== ""),
			"blank-string clear leaves an empty footer row",
		);
	});
});

describe("ponytail — static regression guard", () => {
	it("source registers session_shutdown", () => {
		assert.ok(indexSource.includes("session_shutdown"), "index.js must use session_shutdown");
	});

	it("source contains no session_end literal", () => {
		assert.ok(!indexSource.includes("session_end"), "session_end is not a Pi event");
	});

	it("source contains no blank-string status clear", () => {
		assert.ok(
			!indexSource.includes('setStatus("ponytail", "")'),
			'blank-string clear leaves an empty footer row; use undefined',
		);
	});
});
