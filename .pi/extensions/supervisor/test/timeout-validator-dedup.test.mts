// ─── Tests: timeout-validator dedup (GH #1894) ─────────────────────
// Phase 2 of the test plan: parity, divergence lock, and a source-level
// dedup guard proving the shared body exists once.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	validateAgentTimeouts,
	validateAgentTimeoutSec,
	MAX_AGENT_TIMEOUT_MIN,
	MAX_AGENT_TIMEOUT_SEC,
} from "../config/config.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const configPath = resolve(__dirname, "..", "config", "config.ts");
const AGENTS = ["developer", "auditor"];

// ─── Phase 1: exact-message locks (byte-identical errors) ───────────

describe("timeout validators — exact message locks", () => {
	it("minutes: non-object, non-positive, over-cap messages", () => {
		assert.throws(
			() => validateAgentTimeouts("x", []),
			(err: unknown) =>
				err instanceof Error && err.message === "agentTimeoutsMin must be an object, got string",
		);
		assert.throws(
			() => validateAgentTimeouts({ developer: 0 }, AGENTS),
			(err: unknown) =>
				err instanceof Error &&
				err.message === "agentTimeoutsMin.developer must be a positive integer, got 0",
		);
		assert.throws(
			() => validateAgentTimeouts({ developer: MAX_AGENT_TIMEOUT_MIN + 1 }, AGENTS),
			(err: unknown) =>
				err instanceof Error &&
				err.message ===
					`agentTimeoutsMin.developer must be ≤ ${MAX_AGENT_TIMEOUT_MIN} minutes (Node timer limit), got ${MAX_AGENT_TIMEOUT_MIN + 1}`,
		);
	});

	it("seconds: non-object, negative, over-cap messages", () => {
		assert.throws(
			() => validateAgentTimeoutSec(42, []),
			(err: unknown) =>
				err instanceof Error && err.message === "agentTimeoutSec must be an object, got number",
		);
		assert.throws(
			() => validateAgentTimeoutSec({ developer: -1 }, AGENTS),
			(err: unknown) =>
				err instanceof Error &&
				err.message === "agentTimeoutSec.developer must be a non-negative integer, got -1",
		);
		assert.throws(
			() => validateAgentTimeoutSec({ developer: MAX_AGENT_TIMEOUT_SEC + 1 }, AGENTS),
			(err: unknown) =>
				err instanceof Error &&
				err.message ===
					`agentTimeoutSec.developer must be ≤ ${MAX_AGENT_TIMEOUT_SEC}s (Node timer limit), got ${MAX_AGENT_TIMEOUT_SEC + 1}`,
		);
	});
});

// ─── Phase 1: warn-and-skip fail-open, field-specific text ──────────

describe("timeout validators — warn-and-skip fail-open", () => {
	it("minutes: unknown key warns with field name and is excluded", (t) => {
		const warn = t.mock.method(console, "warn");
		const result = validateAgentTimeouts({ typo: 30 }, AGENTS);
		assert.deepEqual(result, {});
		assert.equal(warn.mock.callCount(), 1);
		assert.equal(
			warn.mock.calls[0]!.arguments[0],
			'agentTimeoutsMin: unknown agent "typo" — entry ignored',
		);
	});

	it("seconds: unknown key warns with field name and is excluded", (t) => {
		const warn = t.mock.method(console, "warn");
		const result = validateAgentTimeoutSec({ typo: 30 }, AGENTS);
		assert.deepEqual(result, {});
		assert.equal(warn.mock.callCount(), 1);
		assert.equal(
			warn.mock.calls[0]!.arguments[0],
			'agentTimeoutSec: unknown agent "typo" — entry ignored',
		);
	});
});

// ─── Phase 2: parity + divergence lock ──────────────────────────────

describe("timeout validators — shared policy parity", () => {
	it("both accept the same valid map identically", () => {
		const input = { developer: 60 };
		assert.deepEqual(validateAgentTimeouts(input, AGENTS), validateAgentTimeoutSec(input, AGENTS));
	});

	it("both exclude the same unknown-key map identically", (t) => {
		t.mock.method(console, "warn");
		const input = { typo: 30 };
		assert.deepEqual(validateAgentTimeouts(input, AGENTS), {});
		assert.deepEqual(validateAgentTimeoutSec(input, AGENTS), {});
	});

	it("both reject the same negative map identically", () => {
		const input = { developer: -1 };
		assert.throws(() => validateAgentTimeouts(input, AGENTS), /positive integer/);
		assert.throws(() => validateAgentTimeoutSec(input, AGENTS), /non-negative integer/);
	});

	it("divergence lock: {developer:0} throws for minutes, accepted for seconds", () => {
		assert.throws(() => validateAgentTimeouts({ developer: 0 }, AGENTS), /positive integer/);
		assert.deepEqual(validateAgentTimeoutSec({ developer: 0 }, AGENTS), { developer: 0 });
	});
});

// ─── Phase 2: source-level dedup regression guard ───────────────────

describe("timeout validators — shared body exists once", () => {
	it("config.ts contains exactly one integer check and one warn-and-skip loop", () => {
		const src = readFileSync(configPath, "utf-8");
		const integerChecks = src.match(/Number\.isInteger\(value\)/g) ?? [];
		const warnLoops = src.match(/unknown agent/g) ?? [];
		assert.equal(integerChecks.length, 1, "one shared integer check — no duplicate validator body");
		assert.equal(warnLoops.length, 1, "one shared unknown-key warn — no duplicate validator body");
	});
});
