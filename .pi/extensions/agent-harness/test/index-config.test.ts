/**
 * AgentHarness — session_start wiring with harness-config.json loading.
 *
 * Split from index.test.ts (issue #2005 Long File refactor).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import type { ToolCallResult, ResolvedHarnessRules } from "../index.ts";
import agentHarness from "../index.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	createMockAPI,
	createConfigTempDir,
	writeHarnessConfig,
	makeConfigCtx,
	configTempDirs,
} from "./harness-fixtures.ts";

describe("AgentHarness — session_start config loading", () => {
	const savedCwd = process.cwd();

	after(() => {
		// Restore cwd and clean up temp dirs
		process.chdir(savedCwd);
		for (const dir of configTempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		configTempDirs.length = 0;
	});

	it("session_start with trusted ctx and config file present → resolved rules loaded, handleToolCall uses override cascade threshold", async () => {
		const dir = createConfigTempDir();
		writeHarnessConfig(dir, {
			toolMeta: { bash: { cascadeThreshold: 12 } },
			cascadeThreshold: 8,
		});
		process.chdir(dir);

		const api = createMockAPI();
		agentHarness(api);

		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// 11 consecutive bash calls should pass (threshold 12)
		const results = [];
		for (let i = 0; i < 11; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "bash", input: { command: "echo hi" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		// 11th call should still be OK
		assert.equal(results[10], undefined, "11th bash call should pass (threshold 12)");

		// 12th call should block
		const blocked = await api.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "echo hi" } },
			makeConfigCtx(),
		);
		assert.ok(blocked?.block, "12th bash call should block");
	});

	it("session_start with untrusted ctx and config file present → defaults used, no config override applied", async () => {
		const dir = createConfigTempDir();
		writeHarnessConfig(dir, { cascadeThreshold: 99, toolMeta: { bash: { cascadeThreshold: 50 } } });
		process.chdir(dir);

		let notifyCalled = false;
		const api = createMockAPI();
		agentHarness(api);

		await api.fire(
			"session_start",
			{ type: "session_start", reason: "new" },
			makeConfigCtx({
				isProjectTrusted: () => false,
				ui: {
					notify: () => {
						notifyCalled = true;
					},
				},
			}),
		);

		assert.equal(notifyCalled, true, "should call notify for untrusted project");

		// Default threshold (8) should apply
		const results = [];
		for (let i = 0; i < 8; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} should pass (default threshold)`);
		}
		assert.ok(results[7]?.block, "8th call should block (default threshold)");
	});

	it("session_start without config file → defaults used", async () => {
		const dir = createConfigTempDir();
		// No .pi/harness-config.json written
		process.chdir(dir);

		const api = createMockAPI();
		agentHarness(api);

		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// Default threshold (8) should apply
		const results = [];
		for (let i = 0; i < 8; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} should pass (default threshold)`);
		}
		assert.ok(results[7]?.block, "8th call should block (default threshold)");
	});

	it("session_start where config loader throws → session still initializes with defaults (fail-safe)", async () => {
		const dir = createConfigTempDir();
		// Malformed JSON config
		fs.writeFileSync(path.join(dir, ".pi", "harness-config.json"), "not valid json", "utf-8");
		process.chdir(dir);

		const api = createMockAPI();
		agentHarness(api);

		// Should not throw — catches error and falls back to defaults
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// Default threshold (8) should still apply
		const results = [];
		for (let i = 0; i < 8; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} should pass (default fallback)`);
		}
		assert.ok(results[7]?.block, "8th call should block (default fallback)");
	});

	it("Multiple session_start calls → each session_start reloads config independently", async () => {
		const dir1 = createConfigTempDir();
		writeHarnessConfig(dir1, { cascadeThreshold: 5 });

		const dir2 = createConfigTempDir();
		writeHarnessConfig(dir2, { cascadeThreshold: 3 });

		// First session with threshold 5
		process.chdir(dir1);

		const api = createMockAPI();
		agentHarness(api);

		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// 4 calls should pass, 5th blocks
		let results = [];
		for (let i = 0; i < 5; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 4; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} in session 1 should pass`);
		}
		assert.ok(results[4]?.block, "5th call in session 1 should block (threshold 5)");

		// Second session with threshold 3
		process.chdir(dir2);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// 2 calls should pass, 3rd blocks
		results = [];
		for (let i = 0; i < 3; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "g.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 2; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} in session 2 should pass`);
		}
		assert.ok(results[2]?.block, "3rd call in session 2 should block (threshold 3)");
	});

	// ── Validation failures are surfaced (mode-adaptive, issue #1725) ──

	const BAD_CONFIG = { tools: { bash: { cascadeThreshold: 4 } } };

	/** Fire session_start and report how many consecutive writes pass before the block. */
	async function defaultThresholdEndures(api: ReturnType<typeof createMockAPI>): Promise<number> {
		let passed = 0;
		for (let i = 0; i < 8; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			if (!r?.block) passed++;
		}
		return passed;
	}

	it("mode 'tui' + unknown-key config → ui.notify once with warning naming the key, defaults still applied", async () => {
		const dir = createConfigTempDir();
		writeHarnessConfig(dir, BAD_CONFIG);
		process.chdir(dir);

		const notifyCalls: Array<{ message: string; type?: string }> = [];
		const api = createMockAPI();
		agentHarness(api);

		await api.fire(
			"session_start",
			{ type: "session_start", reason: "new" },
			makeConfigCtx({
				mode: "tui",
				ui: { notify: (message: string, type?: string) => notifyCalls.push({ message, type }) },
			}),
		);

		assert.equal(notifyCalls.length, 1, "exactly one warning");
		assert.equal(notifyCalls[0].type, "warning");
		assert.ok(notifyCalls[0].message.includes("tools"), `message should name the key: ${notifyCalls[0].message}`);
		assert.equal(await defaultThresholdEndures(api), 7, "7 writes pass — config was discarded, defaults apply");
	});

	it("mode 'rpc' + unknown-key config → sendUserMessage once naming the key, ui.notify NOT called", async () => {
		const dir = createConfigTempDir();
		writeHarnessConfig(dir, BAD_CONFIG);
		process.chdir(dir);

		let notifyCalled = false;
		const sent: string[] = [];
		const api = createMockAPI();
		(api as any).sendUserMessage = (message: string) => sent.push(message);
		agentHarness(api);

		await api.fire(
			"session_start",
			{ type: "session_start", reason: "new" },
			makeConfigCtx({
				mode: "rpc",
				ui: { notify: () => { notifyCalled = true; } },
			}),
		);

		assert.equal(sent.length, 1, "sendUserMessage called once");
		assert.ok(sent[0].includes("tools"), `message should name the key: ${sent[0]}`);
		assert.equal(notifyCalled, false, "ui.notify must not be used in rpc mode");
	});

	for (const mode of ["json", "print"] as const) {
		it(`mode '${mode}' + unknown-key config → console.error naming the key, no ui.notify / sendUserMessage`, async () => {
			const dir = createConfigTempDir();
			writeHarnessConfig(dir, BAD_CONFIG);
			process.chdir(dir);

			let notifyCalled = false;
			let sendCalled = false;
			const errors: unknown[][] = [];
			const originalError = console.error;
			console.error = (...args: unknown[]) => { errors.push(args); };
			try {
				const api = createMockAPI();
				(api as any).sendUserMessage = () => { sendCalled = true; };
				agentHarness(api);

				await api.fire(
					"session_start",
					{ type: "session_start", reason: "new" },
					makeConfigCtx({ mode, ui: { notify: () => { notifyCalled = true; } } }),
				);
			} finally {
				console.error = originalError;
			}

			assert.ok(errors.length >= 1, "console.error must be called");
			assert.ok(
				errors.some((args) => String(args[0]).includes("tools")),
				`error output should name the key: ${JSON.stringify(errors)}`,
			);
			assert.equal(notifyCalled, false, "ui.notify must not be used");
			assert.equal(sendCalled, false, "sendUserMessage must not be used");
		});
	}

	it("mode undefined (backward compat) + unknown-key config → console.error branch, no throw", async () => {
		const dir = createConfigTempDir();
		writeHarnessConfig(dir, BAD_CONFIG);
		process.chdir(dir);

		let notifyCalled = false;
		const errors: unknown[][] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			const api = createMockAPI();
			agentHarness(api);
			await api.fire(
				"session_start",
				{ type: "session_start", reason: "new" },
				makeConfigCtx({ ui: { notify: () => { notifyCalled = true; } } }),
			);
		} finally {
			console.error = originalError;
		}

		assert.ok(errors.some((args) => String(args[0]).includes("tools")));
		assert.equal(notifyCalled, false);
	});

	it("malformed JSON config → surfaced with parse failure, defaults applied", async () => {
		const dir = createConfigTempDir();
		fs.writeFileSync(path.join(dir, ".pi", "harness-config.json"), "not valid json{", "utf-8");
		process.chdir(dir);

		const notifyCalls: string[] = [];
		const api = createMockAPI();
		agentHarness(api);

		await api.fire(
			"session_start",
			{ type: "session_start", reason: "new" },
			makeConfigCtx({ mode: "tui", ui: { notify: (message: string) => notifyCalls.push(message) } }),
		);

		assert.equal(notifyCalls.length, 1);
		assert.match(notifyCalls[0], /parse/i);
	});

	it("sequential sessions: a broken config in session 2 falls back to defaults instead of leaking session 1's rules", async () => {
		// Session 1 gets a permissive per-tool threshold from its own project config.
		const permissiveDir = createConfigTempDir();
		writeHarnessConfig(permissiveDir, { toolMeta: { write: { cascadeThreshold: 20 } } });
		// Session 2 runs in a different project whose config fails validation.
		const brokenDir = createConfigTempDir();
		writeHarnessConfig(brokenDir, BAD_CONFIG);

		const api = createMockAPI();
		agentHarness(api);

		process.chdir(permissiveDir);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx({ mode: "tui" }));
		assert.equal(await defaultThresholdEndures(api), 8, "session 1 runs with its threshold-20 rule");

		process.chdir(brokenDir);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx({ mode: "tui" }));
		assert.equal(
			await defaultThresholdEndures(api),
			7,
			"session 2 must fall back to the default threshold (8th write blocks), not session 1's threshold 20",
		);
	});
});
