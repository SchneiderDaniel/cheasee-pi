/**
 * Tests for caveman index.ts — wiring integration
 *
 * Phase 6: Entry point wires stores to events.
 * Index.ts has no business logic, pure adapter.
 *
 * Includes test scenarios for:
 * - Mode-adaptive compression (Phase 2)
 * - System prompt options inspection (Phase 3)
 * - Project trust gating (Phase 4)
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeMockCtx, makeMockPi } from "./caveman-harness.mts";

// Split from caveman-index.test.mts (issue #2035 Long File refactor).
// ---------------------------------------------------------------------------
// Phase 1: session_start restores from the active branch
// ---------------------------------------------------------------------------

function cavemanBranchEntry(level: string) {
	return { type: "custom", customType: "caveman-level", data: { level } };
}

function makeStatusSpy(): {
	calls: { key: string; value: string | undefined }[];
	ui: ExtensionContext["ui"];
} {
	const calls: { key: string; value: string | undefined }[] = [];
	const ui = {
		setStatus: (key: string, value: string | undefined) => {
			calls.push({ key, value });
		},
		notify: () => {},
		theme: {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		},
	} as unknown as ExtensionContext["ui"];
	return { calls, ui };
}

describe("session_start restores from active branch (Phase 1)", () => {
	async function getSessionStart() {
		const { pi, events, entries } = makeMockPi();
		const mod = await import("../index.ts");
		mod.default(pi);
		const sessionStart = events.find((e) => e.event === "session_start");
		assert.ok(sessionStart !== undefined, "session_start handler not registered");
		return { sessionStart, entries };
	}

	it("restores level from getBranch and never touches getEntries", async () => {
		const { sessionStart, entries } = await getSessionStart();
		const { calls, ui } = makeStatusSpy();
		const ctx = makeMockCtx({
			ui,
			sessionManager: {
				getBranch: () => [cavemanBranchEntry("ultra")],
				getEntries: () => {
					throw new Error("getEntries must not be called");
				},
			},
		});

		await sessionStart.handler({}, ctx);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].key, "caveman");
		assert.equal(calls[0].value, "caveman: ULTRA");
		assert.equal(entries.length, 0, "restored branch level must not append an entry");
	});

	it("wrong-branch-off regression: getBranch=full wins over abandoned getEntries=…off", async () => {
		const { sessionStart, entries } = await getSessionStart();
		const { calls, ui } = makeStatusSpy();
		const ctx = makeMockCtx({
			ui,
			sessionManager: {
				getBranch: () => [cavemanBranchEntry("full")],
				getEntries: () => [cavemanBranchEntry("full"), cavemanBranchEntry("off")],
			},
		});

		await sessionStart.handler({}, ctx);

		assert.equal(calls[0].value, "caveman: FULL");
		assert.equal(entries.length, 0);
	});

	it("last root→leaf element wins", async () => {
		const { sessionStart } = await getSessionStart();
		const { calls, ui } = makeStatusSpy();
		const ctx = makeMockCtx({
			ui,
			sessionManager: {
				getBranch: () => [cavemanBranchEntry("ultra"), cavemanBranchEntry("lite")],
				getEntries: () => [],
			},
		});

		await sessionStart.handler({}, ctx);

		assert.equal(calls[0].value, "caveman: LITE");
	});

	it("branch resolves off → status cleared", async () => {
		const { sessionStart } = await getSessionStart();
		const { calls, ui } = makeStatusSpy();
		const ctx = makeMockCtx({
			ui,
			sessionManager: {
				getBranch: () => [cavemanBranchEntry("off")],
				getEntries: () => [],
			},
		});

		await sessionStart.handler({}, ctx);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].value, undefined);
	});

	it("empty branch with default lite → appends exactly one lite entry", async () => {
		const { sessionStart, entries } = await getSessionStart();
		const ctx = makeMockCtx({
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
			},
		});

		await sessionStart.handler({}, ctx);

		assert.equal(entries.length, 1);
		assert.equal(entries[0].type, "caveman-level");
		assert.deepEqual(entries[0].data, { level: "lite" });
	});

	it("branch of only non-caveman entries → default level, no throw", async () => {
		const { sessionStart } = await getSessionStart();
		const { calls, ui } = makeStatusSpy();
		const ctx = makeMockCtx({
			ui,
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: "other", data: {} }],
				getEntries: () => [],
			},
		});

		await sessionStart.handler({}, ctx);

		assert.equal(calls[0].value, "caveman: LITE");
	});

	it("reload: session_start({reason:'reload'}) restores from branch without appending", async () => {
		const { sessionStart, entries } = await getSessionStart();
		const { calls, ui } = makeStatusSpy();
		const ctx = makeMockCtx({
			ui,
			sessionManager: {
				getBranch: () => [cavemanBranchEntry("full")],
				getEntries: () => [],
			},
		});

		await sessionStart.handler({ reason: "reload" }, ctx);

		assert.equal(calls[0].value, "caveman: FULL");
		assert.equal(entries.length, 0);
	});

	it("fail-closed: session manager without getBranch rejects", async () => {
		const { sessionStart } = await getSessionStart();
		const ctx = makeMockCtx({
			sessionManager: { getEntries: () => [] },
		});

		await assert.rejects(async () => {
			await sessionStart.handler({}, ctx);
		}, TypeError);
	});
});
