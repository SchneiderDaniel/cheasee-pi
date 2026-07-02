/**
 * Tests for processStartTime module-scoped constant in footer.ts.
 *
 * Uses dynamic import() to verify the timer functionality that relies on
 * the processStartTime constant (used at line 113 of footer.ts) is intact
 * after removing the dead `export` keyword.
 *
 * The constant itself is no longer exported — it is an internal detail of
 * the module. We verify it indirectly through the rendered timer output.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/process-starttime.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("processStartTime (module-scoped constant)", () => {
	it("module loads without error (dynamic import side-effect)", async () => {
		// Dynamic import — no static import of the removed export.
		// This verifies the module evaluates without error, which includes
		// the processStartTime = Date.now() assignment at line 25.
		const mod = await import("../footer.ts");
		assert.ok(mod !== null && typeof mod === "object", "module should be importable");
	});

	it("installFooter render with showTimer=true produces elapsed timer output", async () => {
		const mod = (await import("../footer.ts")) as { installFooter: Function };
		assert.ok(typeof mod.installFooter === "function", "installFooter should be exported");

		const { installFooter } = mod;

		// Minimal config with showTimer enabled
		const config = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: true,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
			cacheHitRate: undefined,
			sessionName: undefined,
			trustStatus: undefined,
			sessionId: "",
			prevCpuUsage: 0,
			prevCpuTime: 0,
			allocatedCpus: 4,
			containerDisplay: { value: "" },
		};

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						footerComponent = fn(
							{ requestRender: () => {}, setClearOnShrink: () => {} },
							{
								fg: (_color: string, text: string) => text,
							},
							{
								onBranchChange: () => () => {},
								getGitBranch: () => "main",
								getExtensionStatuses: () => new Map(),
							},
						);
					}
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
			model: { id: "test-model" },
		};

		installFooter(ctx as any, config as any, footerConfig as any);

		assert.ok(footerComponent, "footer component should be created");
		const result = footerComponent!.render(80);
		const allRows = result.join(" ");

		// Timer output includes the ⏱ emoji, proving processStartTime was
		// evaluated at module scope and is usable from the render function
		assert.ok(allRows.includes("\u23f1"), "render output should include timer emoji (⏱)");
	});

	it("rendered elapsed time is non-negative and finite (proving processStartTime is valid)", async () => {
		const mod = (await import("../footer.ts")) as { installFooter: Function };
		const { installFooter } = mod;

		const config = {
			enabled: true,
			thresholds: [],
			showTimer: true,
			showTps: false,
			showCache: false,
			welcomeTimeoutMs: 0,
		};

		const footerConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
			cacheHitRate: undefined,
			sessionName: undefined,
			trustStatus: undefined,
			sessionId: "",
			prevCpuUsage: 0,
			prevCpuTime: 0,
			allocatedCpus: 4,
			containerDisplay: { value: "" },
		};

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						footerComponent = fn(
							{ requestRender: () => {}, setClearOnShrink: () => {} },
							{
								fg: (_color: string, text: string) => text,
							},
							{
								onBranchChange: () => () => {},
								getGitBranch: () => "main",
								getExtensionStatuses: () => new Map(),
							},
						);
					}
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
			model: { id: "test-model" },
		};

		installFooter(ctx as any, config as any, footerConfig as any);

		const result = footerComponent!.render(80);
		const allRows = result.join(" ");

		// Extract numeric portion from timer string like "⏱ 0m 5s"
		const timerMatch = allRows.match(/(\d+)\s*s/);
		assert.ok(timerMatch !== null, "timer output should contain seconds");

		const elapsedSeconds = parseInt(timerMatch[1]!, 10);
		assert.ok(
			!Number.isNaN(elapsedSeconds) && Number.isFinite(elapsedSeconds),
			"elapsed seconds should be a finite number",
		);
		assert.ok(elapsedSeconds >= 0, `elapsed seconds (${elapsedSeconds}) should be >= 0`);
	});
});
