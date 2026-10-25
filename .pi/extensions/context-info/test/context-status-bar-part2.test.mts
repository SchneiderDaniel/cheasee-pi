import assert from "node:assert";

import { describe, it } from "node:test";

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

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

describe("getWorktreeName", () => {
	it("returns null when .git does not exist", () => {
		const dir = join(tmpdir(), `pi-test-no-git-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			assert.strictEqual(getWorktreeName(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null for regular git repo (.git is directory)", () => {
		const dir = join(tmpdir(), `pi-test-regular-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		// Create .git as a directory (regular repo)
		mkdirSync(join(dir, ".git"));
		try {
			assert.strictEqual(getWorktreeName(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects worktree name from .git file", () => {
		const dir = join(tmpdir(), `pi-test-worktree-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), "gitdir: /home/user/.git/worktrees/my-feature-branch\n");
		try {
			assert.strictEqual(getWorktreeName(dir), "my-feature-branch");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns 'worktree' for unknown worktree path format", () => {
		const dir = join(tmpdir(), `pi-test-bad-worktree-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), "gitdir: /some/weird/path\n");
		try {
			assert.strictEqual(getWorktreeName(dir), "worktree");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
describe("loadConfig — showTps", () => {
	it("showTps defaults to true when key absent", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTps, true);
	});

	it("showTps: true → showTps true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTps: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTps, true);
	});

	it("showTps: false → showTps false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTps: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTps, false);
	});

	it("showTps false with showTimer false → both false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: false,
				showTps: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, false);
		assert.strictEqual(result.config!.showTps, false);
	});
});
describe("computeTps", () => {
	it("empty buffer → null", () => {
		assert.strictEqual(computeTps([]), null);
	});

	it("single sample → null", () => {
		assert.strictEqual(computeTps([{ time: Date.now(), cumulativeTokens: 100 }]), null);
	});

	it("two samples with positive delta → tps", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now - 10_000, cumulativeTokens: 0 },
			{ time: now, cumulativeTokens: 500 },
		];
		// 500 tokens in 10s = 50 t/s
		const tps = computeTps(samples);
		assert.ok(tps !== null);
		assert.strictEqual(tps, 50);
	});

	it("samples outside 30s window are pruned", () => {
		const now = Date.now();
		// Old sample 60s ago — outside 30s window
		const samples: TpsSample[] = [
			{ time: now - 60_000, cumulativeTokens: 0 },
			{ time: now - 5_000, cumulativeTokens: 0 },
			{ time: now, cumulativeTokens: 300 },
		];
		const tps = computeTps(samples);
		assert.ok(tps !== null);
		// After pruning old 60s sample: 300 tokens in 5s = 60 t/s
		assert.strictEqual(tps, 60);
	});

	it("zero token delta → null", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now - 10_000, cumulativeTokens: 100 },
			{ time: now, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), null);
	});

	it("zero time delta → null", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now, cumulativeTokens: 0 },
			{ time: now, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), null);
	});

	it("all samples older than 30s → null", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now - 60_000, cumulativeTokens: 0 },
			{ time: now - 45_000, cumulativeTokens: 500 },
		];
		assert.strictEqual(computeTps(samples), null);
	});
});
describe("formatTps", () => {
	it("null → -- t/s", () => {
		assert.strictEqual(formatTps(null), "-- t/s");
	});

	it("42.5 → 42.5 t/s", () => {
		assert.strictEqual(formatTps(42.5), "42.5 t/s");
	});

	it("0 → 0.0 t/s", () => {
		assert.strictEqual(formatTps(0), "0.0 t/s");
	});

	it("0.05 → 0.0 t/s (very slow)", () => {
		assert.strictEqual(formatTps(0.05), "0.0 t/s");
	});

	it("0.1 → 0.1 t/s", () => {
		assert.strictEqual(formatTps(0.1), "0.1 t/s");
	});

	it("999.9 → 999.9 t/s", () => {
		assert.strictEqual(formatTps(999.9), "999.9 t/s");
	});

	it("1000 → 1000 t/s (integer, no decimal)", () => {
		assert.strictEqual(formatTps(1000), "1000 t/s");
	});

	it("1234.5 → 1235 t/s (rounded integer)", () => {
		assert.strictEqual(formatTps(1234.5), "1235 t/s");
	});
});
describe("formatCacheStats", () => {
	it("formatCacheStats(76288, 0) → 📦 76.3K/0 using formatTokens for each value", () => {
		assert.strictEqual(formatCacheStats(76288, 0), "\u{1F4E6} 76.3K/0");
	});

	it("formatCacheStats(1200000, 500) → 📦 1.2M/500 (mixed suffix and plain)", () => {
		assert.strictEqual(formatCacheStats(1200000, 500), "\u{1F4E6} 1.2M/500");
	});

	it("formatCacheStats(0, 0) → 📦 0/0 (valid data, not placeholder)", () => {
		assert.strictEqual(formatCacheStats(0, 0), "\u{1F4E6} 0/0");
	});

	it("formatCacheStats(undefined, undefined) → 📦 --/-- (no data yet)", () => {
		assert.strictEqual(formatCacheStats(undefined, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(null, undefined) → 📦 --/-- (null treated as unavailable)", () => {
		assert.strictEqual(formatCacheStats(null, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(0, undefined) → 📦 --/-- (partial data treated as unavailable)", () => {
		assert.strictEqual(formatCacheStats(0, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(undefined, 0) → 📦 --/-- (partial data treated as unavailable)", () => {
		assert.strictEqual(formatCacheStats(undefined, 0), "\u{1F4E6} --/--");
	});
});
