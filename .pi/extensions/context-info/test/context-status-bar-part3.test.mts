import assert from "node:assert";

import { describe, it } from "node:test";

import { existsSync, readFileSync } from "node:fs";

import { createDefaultFooterConfig } from "../footer-state.ts";

import { installFooter } from "../footer.ts";

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

describe("loadConfig — showCache", () => {
	it("showCache defaults to true when key absent", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, true);
	});

	it("showCache: true → showCache true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showCache: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, true);
	});

	it("showCache: false → showCache false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showCache: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, false);
	});

	it("showCache: invalid (non-boolean) → emits warning, defaults to true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showCache: "yes",
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, true);
		assert.ok(result.warnings.some((w) => w.includes("showCache")));
	});

	it("showCache false with showTimer false and showTps false → all three false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: false,
				showTps: false,
				showCache: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, false);
		assert.strictEqual(result.config!.showTps, false);
		assert.strictEqual(result.config!.showCache, false);
	});
});
describe("footer thinking-level rendering (lib/thinking-level.ts wired)", () => {
	it("thinkingLevel='medium' renders '· ◒ medium' center segment colored accent", () => {
		const { rows, fgCalls } = renderFooterWithThinkingLevel("medium");
		assert.ok(rows[0]!.includes("· ◒ medium"), `should contain '· ◒ medium', got: ${rows[0]}`);
		assert.ok(
			fgCalls.some(([color, text]) => color === "accent" && text === "◒ medium"),
			"'◒ medium' should be rendered with the canonical 'accent' color",
		);
	});

	it("renders '· ○ off' fallback when thinkingLevel is unset/empty", () => {
		for (const level of ["", " "]) {
			const { rows, fgCalls } = renderFooterWithThinkingLevel(level);
			assert.ok(rows[0]!.includes("· ○ off"), `should contain '· ○ off', got: ${rows[0]}`);
			assert.ok(
				fgCalls.some(([color, text]) => color === "dim" && text === "○ off"),
				"'○ off' should be rendered with the canonical 'dim' color",
			);
		}
	});

	it("unknown level 'bogus' renders '· bogus' fallback in dim (identical to pre-change)", () => {
		const { rows, fgCalls } = renderFooterWithThinkingLevel("bogus");
		assert.ok(rows[0]!.includes("· bogus"), `fallback should render '· bogus', got: ${rows[0]}`);
		assert.ok(
			fgCalls.some(([color, text]) => color === "dim" && text === "· bogus"),
			"fallback color should be the canonical 'dim'",
		);
	});

	it("all 6 known levels render icons identical to canonical lib mapping", () => {
		const iconMap: Record<string, string> = {
			off: "○",
			minimal: "◐",
			low: "◑",
			medium: "◒",
			high: "◓",
			xhigh: "●",
		};
		for (const [level, icon] of Object.entries(iconMap)) {
			const { rows } = renderFooterWithThinkingLevel(level);
			assert.ok(
				rows[0]!.includes(`${icon} ${level}`),
				`'${level}' should render '${icon} ${level}', got: ${rows[0]}`,
			);
		}
	});
});
