/**
 * Tests for session-logger branch-scoped startup seeding (bug #1774)
 *
 * `seedStats` must aggregate only the active branch (`sessionManager.getBranch()`),
 * never the whole session file (`getEntries()`), otherwise resuming a branched
 * session inflates the report with inactive-branch usage.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-branch-seeding.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import { createSessionStats } from "../stats.ts";
import { LoggerPipeline } from "../pipeline.ts";
import type { SessionLoggerGate } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures — minimal entry shapes (matches what seedStats consumes)
// ---------------------------------------------------------------------------

const assistant = (input: number, output = 0) => ({
	type: "message",
	message: {
		role: "assistant",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	},
});

const user = () => ({ type: "message", message: { role: "user", content: "hi" } });

const compaction = (id: string, timestamp: string) => ({
	type: "compaction",
	timestamp,
	firstKeptEntryId: id,
	tokensBefore: 1,
	summary: "compact",
});

const modelChange = (timestamp: string, provider: string, modelId: string) => ({
	type: "model_change",
	timestamp,
	provider,
	modelId,
});

const thinkingChange = (timestamp: string, thinkingLevel: string) => ({
	type: "thinking_level_change",
	timestamp,
	thinkingLevel,
});

function createGate(enabled = true): SessionLoggerGate {
	return { enabledForNextSession: enabled, sessionEnabled: enabled };
}

// ===========================================================================
// Phase 1: Branch-scoped seeding in stats.ts
// ===========================================================================

describe("seedStats — branch-scoped aggregation", () => {
	it("populates totals from getBranch when only getBranch is exposed", () => {
		const stats = createSessionStats();
		stats.seedStats({ getBranch: () => [assistant(100, 50)] });
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 100);
		assert.strictEqual(snap.totalOutputTokens, 50);
	});

	it("branch differential — inactive-branch usage is excluded", () => {
		const active = [assistant(100)];
		const inactive = [assistant(500)];
		let getEntriesCalls = 0;
		const sm = {
			getBranch: () => active,
			getEntries: () => {
				getEntriesCalls++;
				return [...active, ...inactive];
			},
		};
		const stats = createSessionStats();
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 100, "seeded totals must equal active-branch only");
		assert.strictEqual(getEntriesCalls, 0, "getEntries must never be consulted");
	});

	it("compaction count sourced from branch only", () => {
		const stats = createSessionStats();
		const sm = {
			getBranch: () => [compaction("b", "t2")],
			getEntries: () => [compaction("a", "t1"), compaction("b", "t2")],
		};
		stats.seedStats(sm);
		assert.strictEqual(stats.getSnapshot().compactionCount, 1);
	});

	it("modelChanges taken from branch only, root→leaf order preserved", () => {
		const stats = createSessionStats();
		const sm = {
			getBranch: () => [modelChange("t1", "openai", "gpt-4"), modelChange("t2", "anthropic", "claude-3")],
			getEntries: () => [
				modelChange("t0", "meta", "llama"),
				modelChange("t1", "openai", "gpt-4"),
				modelChange("t2", "anthropic", "claude-3"),
			],
		};
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.modelChanges.length, 2);
		assert.strictEqual(snap.modelChanges[0].model, "openai/gpt-4");
		assert.strictEqual(snap.modelChanges[1].model, "anthropic/claude-3");
	});

	it("thinkingChanges taken from branch only (inactive level absent)", () => {
		const stats = createSessionStats();
		const sm = {
			getBranch: () => [thinkingChange("t1", "high")],
			getEntries: () => [thinkingChange("t0", "low"), thinkingChange("t1", "high")],
		};
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.thinkingChanges.length, 1);
		assert.strictEqual(snap.thinkingChanges[0].level, "high");
	});

	it("empty branch — all-zero snapshot, no throw", () => {
		const stats = createSessionStats();
		stats.seedStats({ getBranch: () => [] });
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 0);
		assert.strictEqual(snap.compactionCount, 0);
		assert.deepStrictEqual(snap.modelChanges, []);
		assert.deepStrictEqual(snap.thinkingChanges, []);
	});

	it("branch with only a user message — no usage added", () => {
		const stats = createSessionStats();
		stats.seedStats({ getBranch: () => [user()] });
		assert.strictEqual(stats.getSnapshot().totalInputTokens, 0);
	});

	it("getBranch is the sole source — called once, getEntries never called", () => {
		let getBranchCalls = 0;
		const sm = {
			getBranch() {
				getBranchCalls++;
				return [];
			},
			getEntries(): any[] {
				throw new Error("getEntries must not be called");
			},
		};
		const stats = createSessionStats();
		stats.seedStats(sm);
		assert.strictEqual(getBranchCalls, 1);
	});
});

// ===========================================================================
// Phase 2: Pipeline wiring
// ===========================================================================

describe("LoggerPipeline.onSessionStart — branch-scoped reader", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-branch-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeSessionFile(): string {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-branch.jsonl");
		fs.writeFileSync(sessionFile, "", "utf8");
		return sessionFile;
	}

	it("forwards branch reader without leaking branch logic — getBranch called once, getEntries never", async () => {
		const pipeline = new LoggerPipeline(createGate(true));
		const sessionFile = makeSessionFile();
		const active = [assistant(100)];
		const inactive = [assistant(500)];
		let getBranchCalls = 0;
		let getEntriesCalls = 0;

		const ctx = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getCwd: () => tmpDir,
				getBranch: () => {
					getBranchCalls++;
					return active;
				},
				getEntries: () => {
					getEntriesCalls++;
					return [...active, ...inactive];
				},
			},
		};

		await pipeline.onSessionStart({}, ctx as any);

		assert.strictEqual(getBranchCalls, 1, "getBranch invoked exactly once per session_start");
		assert.strictEqual(getEntriesCalls, 0, "pipeline must not read all entries");
	});

	it("no session file — early return, getBranch never invoked", async () => {
		const pipeline = new LoggerPipeline(createGate(true));
		let getBranchCalls = 0;

		const ctx = {
			sessionManager: {
				getSessionFile: () => undefined,
				getCwd: () => tmpDir,
				getBranch: () => {
					getBranchCalls++;
					return [];
				},
			},
		};

		await pipeline.onSessionStart({}, ctx as any);

		assert.strictEqual(getBranchCalls, 0, "seedStats must not run without a session file");
	});
});
