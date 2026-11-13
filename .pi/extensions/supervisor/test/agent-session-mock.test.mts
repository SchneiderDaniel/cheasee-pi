/**
 * Tests for the shared in-process agent-session mock (issue #2105).
 *
 * `./helpers/mock-agent-session.ts` owns `MockSessionConfig`, the session
 * factory and the two `mock.module` export builders. The
 * `agent-runner-in-process*.test.mts` suites keep their own `mock.module`
 * registration (module mocks are per-process and must run before the runner
 * import) but no longer carry byte-identical copies of the factories.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/agent-session-mock.test.mts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createCodingAgentMockExports,
	createMockSession,
	createMockSessionManager,
	createMockSettingsManager,
	createProviderMockExports,
	type MockSessionConfig,
} from "./helpers/mock-agent-session.ts";

const here = dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_MESSAGES = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];

// ─── createMockSession ──────────────────────────────────────────────────────

describe("createMockSession", () => {
	it("exposes the SDK session surface", () => {
		const session = createMockSession({});
		assert.equal(typeof session.subscribe, "function");
		assert.equal(typeof session.prompt, "function");
		assert.equal(typeof session.abort, "function");
		assert.equal(typeof session.dispose, "function");
		assert.deepEqual(session.agent.state.messages, DEFAULT_MESSAGES);
		assert.equal(session.isStreaming, false);
	});

	it("subscribe replays config.events synchronously, in order, and returns an idempotent unsubscribe", () => {
		const events = [{ type: "message_start" }, { type: "message_end" }];
		const session = createMockSession({ events });
		const seen: unknown[] = [];

		const unsubscribe = session.subscribe((event) => seen.push(event));

		assert.deepEqual(seen, events);
		assert.equal(typeof unsubscribe, "function");
		assert.doesNotThrow(() => {
			unsubscribe();
			unsubscribe();
		});
	});

	it("prompt counts calls on the config object (undefined → 1)", async () => {
		const config: MockSessionConfig = {};
		const session = createMockSession(config);

		await session.prompt("task one");
		assert.equal(config.promptCalls, 1);

		await session.prompt("task two");
		assert.equal(config.promptCalls, 2);
	});

	it("shouldReject rejects with rejectError by identity", async () => {
		const sentinel = new Error("sdk exploded");
		const session = createMockSession({ shouldReject: true, rejectError: sentinel });
		const err = await session.prompt("task").then(
			() => null,
			(e: unknown) => e,
		);
		assert.equal(err, sentinel);
	});

	it("shouldReject alone rejects with the default message", async () => {
		const session = createMockSession({ shouldReject: true });
		await assert.rejects(session.prompt("task"), /session\.prompt failed/);
	});

	it("hangUntilAbort stays pending until abort() rejects with abortError", async () => {
		const sentinel = new Error("custom abort");
		const config: MockSessionConfig = { hangUntilAbort: true, abortError: sentinel };
		const session = createMockSession(config);

		const pending = session.prompt("task");
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await sleep(10);
		assert.equal(settled, false, "prompt stays pending until abort()");

		session.abort();
		assert.equal(config.abortCalled, true);
		const err = await pending.then(
			() => null,
			(e: unknown) => e,
		);
		assert.equal(err, sentinel);
	});

	it("hangUntilAbort without abortError rejects with the default abort message", async () => {
		const config: MockSessionConfig = { hangUntilAbort: true };
		const session = createMockSession(config);

		const pending = session.prompt("task");
		session.abort();
		await assert.rejects(pending, /This operation was aborted/);
	});

	it("abort() without hangUntilAbort records abortCalled and leaves the prompt resolved", async () => {
		const config: MockSessionConfig = {};
		const session = createMockSession(config);

		await session.prompt("task");
		session.abort();
		assert.equal(config.abortCalled, true);
	});

	it("dispose() records disposeCalled", () => {
		const config: MockSessionConfig = {};
		createMockSession(config).dispose();
		assert.equal(config.disposeCalled, true);
	});

	it("returns explicit config.messages by identity", () => {
		const messages = [{ role: "user", content: [{ type: "text", text: "custom" }] }];
		const session = createMockSession({ messages });
		assert.equal(session.agent.state.messages, messages);
	});
});

// ─── createProviderMockExports ──────────────────────────────────────────────

describe("createProviderMockExports", () => {
	it("resolves anthropic models and rejects unknown providers", () => {
		const provider = createProviderMockExports(() => ({}));
		assert.deepEqual(provider.getBuiltinModel("anthropic", "claude-x"), {
			id: "claude-x",
			provider: "anthropic",
			api: "anthropic-messages",
		});
		assert.throws(() => provider.getBuiltinModel("openai", "gpt"), /unknown provider openai/);
	});

	it("busy-waits synchronously for config.slowSyncSetupMs", () => {
		const provider = createProviderMockExports(() => ({ slowSyncSetupMs: 40 }));
		const startedAt = Date.now();
		provider.getBuiltinModel("anthropic", "claude-x");
		assert.ok(Date.now() - startedAt >= 40, "sync setup delay actually blocks");
	});

	it("does not block when slowSyncSetupMs is absent", () => {
		const provider = createProviderMockExports(() => ({}));
		const startedAt = Date.now();
		provider.getBuiltinModel("anthropic", "claude-x");
		assert.ok(Date.now() - startedAt < 40, "no sync delay without slowSyncSetupMs");
	});
});

// ─── createCodingAgentMockExports ───────────────────────────────────────────

describe("createCodingAgentMockExports", () => {
	it("builds the session from the config read at call time", async () => {
		let config: MockSessionConfig = {};
		const exports = createCodingAgentMockExports(() => config);

		const first = await exports.createAgentSession({});
		assert.deepEqual(first.agent.state.messages, DEFAULT_MESSAGES);

		const mutated = [{ role: "user", content: [{ type: "text", text: "changed" }] }];
		config = { messages: mutated };

		const second = await exports.createAgentSession({});
		assert.equal(second.agent.state.messages, mutated, "config re-read on every call");
	});

	it("honours setupDelayMs before resolving", async () => {
		const exports = createCodingAgentMockExports(() => ({ setupDelayMs: 40 }));
		const startedAt = Date.now();
		await exports.createAgentSession({});
		assert.ok(Date.now() - startedAt >= 40, "setup delay applied");
	});

	it("never settles when setupNeverSettles is set", async () => {
		const exports = createCodingAgentMockExports(() => ({ setupNeverSettles: true }));
		let settled = false;
		void exports.createAgentSession({}).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await sleep(50);
		assert.equal(settled, false, "never-settling setup stays pending");
	});

	it("exposes SessionManager and SettingsManager stubs", () => {
		const exports = createCodingAgentMockExports(() => ({}));

		const created = exports.SessionManager.create("/x");
		assert.equal(created.getCwd(), "/x");
		assert.equal(created.getSessionDir(), "/tmp/pi-session");

		const inMemory = exports.SessionManager.inMemory();
		assert.equal(inMemory.getCwd(), undefined);
		assert.equal(inMemory.getSessionDir(), undefined);

		assert.deepEqual(exports.SettingsManager.inMemory(), {});
	});

	it("exposes no-op tool factories and theme helpers", () => {
		const exports = createCodingAgentMockExports(() => ({}));
		for (const factory of [
			exports.createBashToolDefinition,
			exports.createReadToolDefinition,
			exports.createWriteToolDefinition,
			exports.createEditToolDefinition,
			exports.createGrepToolDefinition,
			exports.createFindToolDefinition,
			exports.createLsToolDefinition,
		]) {
			assert.deepEqual(factory("/tmp"), {});
		}
		assert.equal(exports.initTheme(), undefined);
		assert.deepEqual(exports.getMarkdownTheme(), {});
	});
});

// ─── createMockSessionManager / createMockSettingsManager ───────────────────

describe("manager stubs", () => {
	it("createMockSessionManager() mirrors the SDK surface", () => {
		const manager = createMockSessionManager();
		const created = manager.create("/work");
		assert.equal(created.getCwd(), "/work");
		assert.equal(created.getSessionDir(), "/tmp/pi-session");

		const inMemory = manager.inMemory();
		assert.equal(inMemory.getCwd(), undefined);
		assert.equal(inMemory.getSessionDir(), undefined);
	});

	it("createMockSettingsManager() returns an in-memory settings stub", () => {
		assert.deepEqual(createMockSettingsManager().inMemory(), {});
	});
});

// ─── Guards: one owner, no local copies in the test layer ───────────────────

describe("agent-session mock dedup guards", () => {
	const readSource = (file: string): string => readFileSync(join(here, file), "utf-8");
	const countOccurrences = (source: string, needle: string): number =>
		source.split(needle).length - 1;

	it("the helper contains no mock.module( call — registration stays in each test file", () => {
		const source = readSource("./helpers/mock-agent-session.ts");
		assert.equal(countOccurrences(source, "mock.module("), 0);
	});

	for (const file of [
		"agent-runner-in-process.test.mts",
		"agent-runner-in-process-part2.test.mts",
		"agent-runner-in-process-part3.test.mts",
	]) {
		it(`${file} declares no local session mock and no module-level slowSyncSetupMs`, () => {
			const source = readSource(file);
			for (const declaration of [
				"function createMockSession",
				"function createMockSessionManager",
				"function createMockSettingsManager",
				"let slowSyncSetupMs",
			]) {
				assert.equal(
					countOccurrences(source, declaration),
					0,
					`${file} still declares "${declaration}"`,
				);
			}
		});

		it(`${file} imports both export builders, keeps 2 mock.module calls behind the hasMockModule gate`, () => {
			const source = readSource(file);
			// The runner suites live in supervisor/test/, so the helper is a sibling:
			// "./helpers/mock-agent-session.ts" ("../helpers/" would escape test/).
			const importBlock = source.match(
				/import\s*\{([^}]*)\}\s*from\s*"\.\/helpers\/mock-agent-session\.ts"/,
			);
			assert.ok(importBlock, `expected an import from ./helpers/mock-agent-session.ts in ${file}`);
			assert.match(importBlock![1]!, /\bcreateCodingAgentMockExports\b/);
			assert.match(importBlock![1]!, /\bcreateProviderMockExports\b/);

			assert.equal(
				countOccurrences(source, "mock.module("),
				2,
				`${file} must keep exactly 2 mock.module registrations`,
			);
			assert.ok(
				source.includes('const hasMockModule = typeof mock.module === "function"') &&
					source.includes("if (hasMockModule) {"),
				`${file} must keep the hasMockModule gate`,
			);
		});
	}

	it("agent-runner-in-process.test.mts keeps its placeholder suite for runs without the flag", () => {
		// Only this suite declares the placeholder; the -partN files gate on
		// hasMockModule without one.
		const source = readSource("agent-runner-in-process.test.mts");
		assert.ok(
			source.includes("if (!hasMockModule)"),
			"placeholder branch must survive so runs without --experimental-test-module-mocks still pass",
		);
	});
});
