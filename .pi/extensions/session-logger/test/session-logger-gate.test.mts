import assert from "node:assert";
import { describe, it } from "node:test";

import { beginSession } from "../pipeline.ts";
import { createSessionLoggerGate, toggleSessionLoggerGate } from "../index.ts";

describe("session-logger gate", () => {
	it("applies /session-logger off to the next session without disabling the current one", () => {
		const gate = createSessionLoggerGate(true);

		assert.strictEqual(beginSession(gate), true);
		assert.strictEqual(gate.sessionEnabled, true);

		assert.strictEqual(toggleSessionLoggerGate(gate, "off"), false);
		assert.strictEqual(gate.enabledForNextSession, false);
		assert.strictEqual(gate.sessionEnabled, true);

		assert.strictEqual(beginSession(gate), false);
		assert.strictEqual(gate.sessionEnabled, false);
	});

	it("re-enables logging only when a later session starts", () => {
		const gate = createSessionLoggerGate(false);

		assert.strictEqual(beginSession(gate), false);
		assert.strictEqual(toggleSessionLoggerGate(gate, "on"), true);
		assert.strictEqual(gate.sessionEnabled, false);

		assert.strictEqual(beginSession(gate), true);
		assert.strictEqual(gate.sessionEnabled, true);
	});
});
