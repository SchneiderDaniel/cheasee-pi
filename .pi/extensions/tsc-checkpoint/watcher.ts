/**
 * tsc-checkpoint — DiagnosticsWatcher: lifecycle, trend computation, listener registration
 *
 * Wraps a TscWatchAdapter to provide cached diagnostics, trend tracking,
 * and diagnostic change notifications. The default constructor creates a
 * real TypeScriptWatchAdapter via createDefaultAdapter(); a mock adapter
 * can be injected for testing.
 */

import { existsSync } from "node:fs";
import type { TscDiagnostic, TscWatchOptions, DiagnosticTrend } from "./types.ts";
import type { TscWatchAdapter } from "./adapter.ts";
import { createDefaultAdapter } from "./adapter.ts";

export class DiagnosticsWatcher {
	private adapter: TscWatchAdapter;
	private cachedDiagnostics: TscDiagnostic[] = [];
	private running = false;
	private trendHistory: number[] = [];
	private diagnosticListeners: Array<(d: TscDiagnostic[]) => void> = [];
	private tsconfigPath: string;
	private watchOptions: TscWatchOptions;

	constructor(tsconfigPath: string, watchOptions?: TscWatchOptions, adapter?: TscWatchAdapter) {
		this.tsconfigPath = tsconfigPath;
		this.watchOptions = watchOptions ?? {};
		this.adapter = adapter ?? createDefaultAdapter();

		// Forward adapter diagnostic events
		this.adapter.onDiagnosticsChange((diags: TscDiagnostic[]) => {
			this.cachedDiagnostics = diags;
			const errorCount = diags.filter((d) => d.severity === "Error").length;
			this.trendHistory.push(errorCount);
			for (const listener of this.diagnosticListeners) {
				listener(diags);
			}
		});
	}

	get tsconfigPathValue(): string {
		return this.tsconfigPath;
	}

	get watchOptionsValue(): TscWatchOptions {
		return { ...this.watchOptions };
	}

	/**
	 * Start the watcher. Returns true if started, false if already running.
	 * Throws if tsconfig does not exist.
	 */
	start(): boolean {
		if (this.running) return false;
		if (!existsSync(this.tsconfigPath)) {
			throw new Error(`tsconfig not found: ${this.tsconfigPath}`);
		}
		const started = this.adapter.start(this.tsconfigPath);
		this.running = started;
		return started;
	}

	/** Stop the watcher. No-op if not running. */
	stop(): void {
		if (!this.running) return;
		this.adapter.stop();
		this.running = false;
	}

	/** Whether the watcher is currently running. */
	isRunning(): boolean {
		return this.running;
	}

	/** Get the latest cached diagnostics. */
	getDiagnostics(): TscDiagnostic[] {
		return this.cachedDiagnostics;
	}

	/** Register a callback for when diagnostics change. */
	onDiagnosticsChange(listener: (d: TscDiagnostic[]) => void): void {
		this.diagnosticListeners.push(listener);
	}

	/**
	 * Get the diagnostic trend between the last two checks.
	 * Returns undefined if fewer than 2 data points exist.
	 */
	getTrend(): DiagnosticTrend | undefined {
		if (this.trendHistory.length < 2) return undefined;
		const current = this.trendHistory[this.trendHistory.length - 1]!;
		const previous = this.trendHistory[this.trendHistory.length - 2]!;
		const delta = current - previous;
		return {
			current,
			previous,
			direction: delta < 0 ? "improved" : delta > 0 ? "regressed" : "stable",
			delta: Math.abs(delta),
		};
	}
}
