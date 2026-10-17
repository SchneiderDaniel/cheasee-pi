import assert from "node:assert";

import { describe, it } from "node:test";

import { existsSync, readFileSync } from "node:fs";

import { createDefaultFooterConfig } from "../footer-state.ts";

import { installFooter } from "../footer.ts";

import { formatTokens } from "../../lib/format-tokens.ts";

interface ThresholdEntry {
	maxTokens: number | null;
	color: string;
}

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000, color: "green" },
	{ maxTokens: 150_000, color: "orange" },
	{ maxTokens: null, color: "red" },
];

function pickThreshold(tokens: number, thresholds: ThresholdEntry[]): ThresholdEntry {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	for (const entry of sorted) {
		if (entry.maxTokens === null) return entry;
		if (tokens <= entry.maxTokens) return entry;
	}
	return sorted[sorted.length - 1]!;
}

function getWorktreeName(cwd: string): string | null {
	try {
		const gitFile = `${cwd}/.git`;
		if (!existsSync(gitFile)) return null;
		const content = readFileSync(gitFile, "utf-8");
		const match = content.match(/^gitdir:\s*(.+)$/m);
		if (!match) return null;
		const gitDir = match[1]!.trim();
		const wtMatch = gitDir.match(/worktrees\/(.+?)(\/|$)/);
		return wtMatch ? wtMatch[1]! : "worktree";
	} catch {
		return null;
	}
}

interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
}

function computeTps(samples: TpsSample[]): number | null {
	if (samples.length < 2) return null;

	const now = Date.now();
	const cutoff = now - 30_000;

	// Filter to 30s window
	const active = samples.filter((s) => s.time >= cutoff);
	if (active.length < 2) return null;

	const first = active[0]!;
	const last = active[active.length - 1]!;
	const tokenDelta = last.cumulativeTokens - first.cumulativeTokens;
	const timeDelta = last.time - first.time;

	if (timeDelta <= 0) return null;
	if (tokenDelta <= 0) return null;

	return (tokenDelta / timeDelta) * 1000;
}

function formatTps(tps: number | null): string {
	if (tps === null) return "-- t/s";
	if (tps < 0.1) return "0.0 t/s";
	if (tps > 999.9) return `${Math.round(tps)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

function loadConfig(rawSettings: Record<string, unknown> | null): {
	config: ContextStatusBarConfig | null;
	warnings: string[];
} {
	const warnings: string[] = [];
	const defaults: ContextStatusBarConfig = {
		enabled: true,
		thresholds: DEFAULT_THRESHOLDS,
		showTimer: true,
		showTps: true,
		showCache: true,
	};

	if (!rawSettings || typeof rawSettings !== "object") {
		return { config: defaults, warnings };
	}

	const raw = (rawSettings as Record<string, unknown>)["contextStatusBar"];
	if (raw === undefined) {
		return { config: defaults, warnings };
	}
	if (typeof raw !== "object" || raw === null) {
		warnings.push("contextStatusBar must be an object; using defaults");
		return { config: defaults, warnings };
	}

	const cfg = raw as Record<string, unknown>;

	let enabled = true;
	if ("enabled" in cfg) {
		if (typeof cfg.enabled === "boolean") {
			enabled = cfg.enabled;
		} else {
			warnings.push("contextStatusBar.enabled must be boolean; using true");
		}
	}

	if (enabled === false) return { config: null, warnings };

	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		warnings.push("contextStatusBar.thresholds missing or empty; falling back to defaults");
		thresholds = DEFAULT_THRESHOLDS;
	} else {
		const parsed: ThresholdEntry[] = [];
		for (const entry of cfg.thresholds) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			const maxTokens =
				e.maxTokens === null || e.maxTokens === undefined ? null : Number(e.maxTokens);
			const color = typeof e.color === "string" ? e.color : "";
			if (maxTokens !== null && !Number.isFinite(maxTokens)) continue;
			if (!color) continue;
			parsed.push({ maxTokens: maxTokens as number | null, color });
		}
		if (parsed.length === 0) {
			warnings.push("contextStatusBar.thresholds has no valid entries; falling back to defaults");
			thresholds = DEFAULT_THRESHOLDS;
		} else {
			thresholds = parsed;
		}
	}

	// Parse showTimer
	let showTimer = true;
	if ("showTimer" in cfg) {
		if (typeof cfg.showTimer === "boolean") {
			showTimer = cfg.showTimer;
		} else {
			warnings.push("contextStatusBar.showTimer must be boolean; using true");
		}
	}

	// Parse showTps
	let showTps = true;
	if ("showTps" in cfg) {
		if (typeof cfg.showTps === "boolean") {
			showTps = cfg.showTps;
		} else {
			warnings.push("contextStatusBar.showTps must be boolean; using true");
		}
	}

	// Parse showCache
	let showCache = true;
	if ("showCache" in cfg) {
		if (typeof cfg.showCache === "boolean") {
			showCache = cfg.showCache;
		} else {
			warnings.push("contextStatusBar.showCache must be boolean; using true");
		}
	}

	return { config: { enabled, thresholds, showTimer, showTps, showCache }, warnings };
}

function formatCacheStats(
	cacheRead: number | undefined | null,
	cacheWrite: number | undefined | null,
): string {
	if (
		cacheRead === undefined ||
		cacheRead === null ||
		cacheWrite === undefined ||
		cacheWrite === null
	) {
		return "\u{1F4E6} --/--";
	}
	return `\u{1F4E6} ${_fmtTokens(cacheRead)}/${_fmtTokens(cacheWrite)}`;
}

function _fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

interface FooterFixture {
	rows: string[];
	fgCalls: Array<[string, string]>;
}

function renderFooterWithThinkingLevel(thinkingLevel: string): FooterFixture {
	const config = {
		enabled: true,
		thresholds: [],
		showTimer: false,
		showTps: false,
		showCache: false,
		welcomeTimeoutMs: 0,
	};
	const footerConfig = createDefaultFooterConfig();
	footerConfig.thinkingLevel = thinkingLevel;

	const fgCalls: Array<[string, string]> = [];
	let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			setFooter: (fn: unknown) => {
				if (typeof fn === "function") {
					footerComponent = fn(
						{ requestRender: () => {}, setClearOnShrink: () => {} },
						{
							fg: (color: string, text: string) => {
								fgCalls.push([color, text]);
								return text;
							},
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

	installFooter(ctx as any, config as any, footerConfig);

	if (!footerComponent) throw new Error("footer component was not created");
	return { rows: footerComponent.render(80), fgCalls };
}

describe("formatTokens", () => {
	it("formats K values", () => {
		assert.strictEqual(formatTokens(12_000), "12.0K");
		assert.strictEqual(formatTokens(1_000), "1.0K");
		assert.strictEqual(formatTokens(100_000), "100.0K");
		assert.strictEqual(formatTokens(999_999), "1000.0K");
	});

	it("formats M values", () => {
		assert.strictEqual(formatTokens(1_000_000), "1.0M");
		assert.strictEqual(formatTokens(2_500_000), "2.5M");
	});

	it("formats small values (no suffix)", () => {
		assert.strictEqual(formatTokens(0), "0");
		assert.strictEqual(formatTokens(999), "999");
		assert.strictEqual(formatTokens(42), "42");
	});
});
describe("pickThreshold", () => {
	const thresholds = DEFAULT_THRESHOLDS;

	it("≤100K returns green", () => {
		assert.strictEqual(pickThreshold(0, thresholds).color, "green");
		assert.strictEqual(pickThreshold(50_000, thresholds).color, "green");
		assert.strictEqual(pickThreshold(100_000, thresholds).color, "green");
	});

	it(">100K and ≤150K returns orange", () => {
		assert.strictEqual(pickThreshold(100_001, thresholds).color, "orange");
		assert.strictEqual(pickThreshold(150_000, thresholds).color, "orange");
	});

	it(">150K returns red", () => {
		assert.strictEqual(pickThreshold(150_001, thresholds).color, "red");
		assert.strictEqual(pickThreshold(500_000, thresholds).color, "red");
	});

	it("handles custom thresholds", () => {
		const custom: ThresholdEntry[] = [
			{ maxTokens: 50_000, color: "green" },
			{ maxTokens: null, color: "orange" },
		];
		assert.strictEqual(pickThreshold(30_000, custom).color, "green");
		assert.strictEqual(pickThreshold(60_000, custom).color, "orange");
	});

	it("null catch-all always matches last", () => {
		const custom: ThresholdEntry[] = [
			{ maxTokens: 10_000, color: "green" },
			{ maxTokens: null, color: "red" },
		];
		assert.strictEqual(pickThreshold(50_000, custom).color, "red");
	});

	it("sorts thresholds by maxTokens ascending before picking", () => {
		const unsorted: ThresholdEntry[] = [
			{ maxTokens: 50_000, color: "green" },
			{ maxTokens: 10_000, color: "orange" },
			{ maxTokens: null, color: "red" },
		];
		assert.strictEqual(pickThreshold(5_000, unsorted).color, "orange");
		assert.strictEqual(pickThreshold(15_000, unsorted).color, "green");
		assert.strictEqual(pickThreshold(100_000, unsorted).color, "red");
	});
});
describe("loadConfig", () => {
	it("returns defaults when key is absent", () => {
		const result = loadConfig({ supervisor: {} });
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("returns defaults when settings is null", () => {
		const result = loadConfig(null);
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("returns defaults when settings is empty object", () => {
		const result = loadConfig({});
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("loads valid config with thresholds", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [
					{ maxTokens: 50_000, color: "green" },
					{ maxTokens: null, color: "red" },
				],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.strictEqual(result.config!.thresholds.length, 2);
	});

	it("respects enabled: false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.strictEqual(result.config, null);
	});

	// ── showTimer config tests ─────────────────────────────────

	it("showTimer defaults to true when key absent", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, true);
	});

	it("showTimer: true → showTimer true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, true);
	});

	it("showTimer: false → showTimer false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, false);
	});

	it("falls back to defaults when thresholds missing", () => {
		const result = loadConfig({ contextStatusBar: { enabled: true } });
		assert.ok(result.config);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("falls back to defaults when thresholds is empty array", () => {
		const result = loadConfig({ contextStatusBar: { thresholds: [] } });
		assert.ok(result.config);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("falls back when contextStatusBar is not an object", () => {
		const result = loadConfig({ contextStatusBar: "not-an-object" });
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("skips invalid threshold entries", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [
					{ maxTokens: "bad", color: "green" },
					{ maxTokens: 50_000, color: "" },
					{ maxTokens: 100_000, color: "green" },
				],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.thresholds.length, 1);
		assert.strictEqual(result.config!.thresholds[0]!.maxTokens, 100_000);
	});

	it("allows null maxTokens for catch-all", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.thresholds[0]!.maxTokens, null);
	});
});
