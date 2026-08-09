/**
 * Phase 4: Full lifecycle integration via mock ExtensionAPI
 *
 * End-to-end handler sequence: session_start → command → shutdown → next session_start.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigStore } from "../config.ts";
import {
	resetSessionLevel,
	resolveSessionLevel,
	shouldAppendCavemanEntry,
} from "../session-level.ts";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { Level } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomDir(): string {
	return join(
		tmpdir(),
		`caveman-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
}

interface MockCapture {
	setLevelCalls: Level[];
	appendEntryCalls: { level: Level }[];
}

function createMockExtensionAPI(capture: MockCapture) {
	return {
		appendEntry: (customType: string, data: { level: Level }) => {
			capture.appendEntryCalls.push(data);
		},
	};
}

interface MockSessionManager {
	entries: Array<{ type: string; customType: string; data: Record<string, unknown> }>;
}

function createMockCtx(
	entries: Array<{ type: string; customType: string; data: Record<string, unknown> }> = [],
) {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Full lifecycle integration", () => {
	let configDir: string;
	let configPath: string;

	beforeEach(async () => {
		configDir = randomDir();
		await mkdir(configDir, { recursive: true });
		configPath = join(configDir, "caveman.json");
	});

	async function writeConfig(data: Record<string, unknown>): Promise<void> {
		await writeFile(configPath, JSON.stringify(data));
	}

	it("session_start (new, defaultLevel=off) → setLevel(off), appendEntry NOT called", async () => {
		await writeConfig({ defaultLevel: "off", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		// Simulate session_start logic
		const result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);

		assert.equal(store.getLevel(), "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("session_start (new, defaultLevel=lite) → setLevel(lite), appendEntry called with level=lite", async () => {
		await writeConfig({ defaultLevel: "lite", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		const capture: MockCapture = { setLevelCalls: [], appendEntryCalls: [] };
		const result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		if (result.shouldAppendEntry) {
			createMockExtensionAPI(capture).appendEntry("caveman-level", { level: store.getLevel() });
		}

		assert.equal(store.getLevel(), "lite");
		assert.equal(capture.appendEntryCalls.length, 1);
		assert.equal(capture.appendEntryCalls[0].level, "lite");
	});

	it("session_start (resume, session entry=full) → setLevel(full), appendEntry NOT called", async () => {
		await writeConfig({ defaultLevel: "off", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		const sessionEntries: CustomEntry[] = [
			{
				id: "1",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "custom",
				customType: "caveman-level",
				data: { level: "full" as Level },
			},
		];
		const capture: MockCapture = { setLevelCalls: [], appendEntryCalls: [] };

		const result = resolveSessionLevel(store.getConfig(), sessionEntries);
		store.setLevel(result.level);
		if (result.shouldAppendEntry) {
			createMockExtensionAPI(capture).appendEntry("caveman-level", { level: store.getLevel() });
		}

		assert.equal(store.getLevel(), "full");
		assert.equal(result.shouldAppendEntry, false);
		assert.equal(capture.appendEntryCalls.length, 0);
	});

	it("lifecycle: new(off) → /caveman full → shutdown → new(off) → level is off (no leak)", async () => {
		await writeConfig({ defaultLevel: "off", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		// Session A start (new, defaultLevel=off)
		let result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		assert.equal(store.getLevel(), "off");

		// User runs /caveman full
		store.setLevel("full");
		assert.equal(store.getLevel(), "full");

		// Session A shutdown — reset
		store.setLevel(resetSessionLevel(store.getLevel()));
		assert.equal(store.getLevel(), "off");

		// Session B start (new, defaultLevel=off) — no session entries
		result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		assert.equal(store.getLevel(), "off"); // NOT "full" — no leak
	});

	it("lifecycle: new(lite) → /caveman off → shutdown → new(lite) → level is lite", async () => {
		await writeConfig({ defaultLevel: "lite", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		// Session A start (new, defaultLevel=lite)
		let result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		assert.equal(store.getLevel(), "lite");

		// User runs /caveman off
		store.setLevel("off");
		assert.equal(store.getLevel(), "off");

		// Session A shutdown
		store.setLevel(resetSessionLevel(store.getLevel()));
		assert.equal(store.getLevel(), "off");

		// Session B start (new, defaultLevel=lite) — no entries
		result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		assert.equal(store.getLevel(), "lite");
	});

	it("appendEntry called only when resulting level is not off", async () => {
		await writeConfig({ defaultLevel: "off", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		const capture: MockCapture = { setLevelCalls: [], appendEntryCalls: [] };
		const api = createMockExtensionAPI(capture);

		// defaultLevel=off, new session → shouldAppendEntry=false
		let result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		if (result.shouldAppendEntry) {
			api.appendEntry("caveman-level", { level: store.getLevel() });
		}
		assert.equal(capture.appendEntryCalls.length, 0);

		// defaultLevel=lite, new session → shouldAppendEntry=true
		await writeConfig({ defaultLevel: "lite", showStatus: true });
		const store2 = createConfigStore(configPath);
		await store2.ensureConfigLoaded();
		result = resolveSessionLevel(store2.getConfig(), []);
		store2.setLevel(result.level);
		if (result.shouldAppendEntry) {
			api.appendEntry("caveman-level", { level: store2.getLevel() });
		}
		assert.equal(capture.appendEntryCalls.length, 1);
		assert.equal(capture.appendEntryCalls[0].level, "lite");
	});

	// ---------------------------------------------------------------------------
	// Phase 4: Trust-gated lifecycle scenarios
	// ---------------------------------------------------------------------------

	it("appendEntry gated on trust: untrusted + shouldAppendEntry=true → no entry", () => {
		const result = shouldAppendCavemanEntry(true, false);
		assert.equal(result, false);
	});

	it("appendEntry gated on trust: trusted + shouldAppendEntry=true → entry", () => {
		const result = shouldAppendCavemanEntry(true, true);
		assert.equal(result, true);
	});

	it("appendEntry gated on trust: trusted + shouldAppendEntry=false → no entry", () => {
		const result = shouldAppendCavemanEntry(false, true);
		assert.equal(result, false);
	});

	it("trust gating in session_start: untrusted project with defaultLevel=lite → appendEntry NOT called", async () => {
		await writeConfig({ defaultLevel: "lite", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		const capture: MockCapture = { setLevelCalls: [], appendEntryCalls: [] };
		const pi = createMockExtensionAPI(capture);

		// Simulate session_start with untrusted project
		const result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);

		// Gate on trust
		if (shouldAppendCavemanEntry(result.shouldAppendEntry, false)) {
			pi.appendEntry("caveman-level", { level: store.getLevel() });
		}

		// Level is still set
		assert.equal(store.getLevel(), "lite");
		// But appendEntry is NOT called
		assert.equal(capture.appendEntryCalls.length, 0);
	});

	it("trust gating in session_start: trusted project with defaultLevel=lite → appendEntry called", async () => {
		await writeConfig({ defaultLevel: "lite", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		const capture: MockCapture = { setLevelCalls: [], appendEntryCalls: [] };
		const pi = createMockExtensionAPI(capture);

		// Simulate session_start with trusted project
		const result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);

		// Gate on trust
		if (shouldAppendCavemanEntry(result.shouldAppendEntry, true)) {
			pi.appendEntry("caveman-level", { level: store.getLevel() });
		}

		assert.equal(store.getLevel(), "lite");
		assert.equal(capture.appendEntryCalls.length, 1);
		assert.equal(capture.appendEntryCalls[0].level, "lite");
	});

	it("lifecycle: untrusted project with new(lite) → /caveman full → shutdown → new(lite) → level restored, no leak", async () => {
		await writeConfig({ defaultLevel: "lite", showStatus: true });
		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();

		const capture: MockCapture = { setLevelCalls: [], appendEntryCalls: [] };
		const pi = createMockExtensionAPI(capture);

		// Session A start (new, defaultLevel=lite, untrusted)
		let result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		if (shouldAppendCavemanEntry(result.shouldAppendEntry, false)) {
			pi.appendEntry("caveman-level", { level: store.getLevel() });
		}
		assert.equal(store.getLevel(), "lite");
		assert.equal(capture.appendEntryCalls.length, 0, "No entry in untrusted session");

		// User runs /caveman full (this still works regardless of trust)
		store.setLevel("full");
		assert.equal(store.getLevel(), "full");

		// Session A shutdown — reset
		store.setLevel(resetSessionLevel(store.getLevel()));
		assert.equal(store.getLevel(), "off");

		// Session B start (new, defaultLevel=lite, still untrusted)
		result = resolveSessionLevel(store.getConfig(), []);
		store.setLevel(result.level);
		if (shouldAppendCavemanEntry(result.shouldAppendEntry, false)) {
			pi.appendEntry("caveman-level", { level: store.getLevel() });
		}
		assert.equal(store.getLevel(), "lite");
		assert.equal(capture.appendEntryCalls.length, 0, "Still no entry in untrusted session");
	});
});
