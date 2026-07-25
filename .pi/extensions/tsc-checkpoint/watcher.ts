/**
 * tsc-checkpoint — Consolidated tsc-binding watcher
 *
 * Thin watcher that owns ts.createWatchProgram directly (no adapter delegation),
 * feeds error counts into TrendTracker for trend analysis, and caches diagnostics
 * between /check calls.
 *
 * This is the single file that replaces the former DiagnosticsWatcher → adapter
 * chain. The TscWatchAdapter interface, TypeScriptWatchAdapter class, and
 * createDefaultAdapter factory have been removed — they were a speculative seam
 * (one real implementation + one test mock) that added pass-through complexity
 * without real polymorphism.
 */

import ts from "typescript";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TscDiagnostic, DiagnosticTrend } from "./types.ts";
import { diagnosticToTscDiagnostic } from "./adapter.ts";
import { TrendTracker } from "./trend.ts";

export class DiagnosticsWatcher {
	private watchProgram: ts.WatchOfConfigFile<ts.BuilderProgram> | undefined;
	private cachedDiagnostics: TscDiagnostic[] = [];
	private running = false;
	private trendTracker = new TrendTracker();
	private diagnosticListeners: Array<(d: TscDiagnostic[]) => void> = [];
	private tsconfigPath: string;
	private tsconfigDir: string;

	constructor(tsconfigPath: string) {
		this.tsconfigPath = tsconfigPath;
		this.tsconfigDir = dirname(tsconfigPath);
	}

	get tsconfigPathValue(): string {
		return this.tsconfigPath;
	}

	/**
	 * Start the watch compiler. Returns true if started, false if already running.
	 * Throws if tsconfig does not exist.
	 */
	start(): boolean {
		if (this.running) return false;
		if (!existsSync(this.tsconfigPath)) {
			throw new Error(`tsconfig not found: ${this.tsconfigPath}`);
		}

		this.cachedDiagnostics = [];
		this.trendTracker = new TrendTracker();

		const host = ts.createWatchCompilerHost(
			this.tsconfigPath,
			{ noEmit: true },
			ts.sys,
			ts.createEmitAndSemanticDiagnosticsBuilderProgram,
			(diagnostic: ts.Diagnostic) => {
				if (diagnostic.category !== ts.DiagnosticCategory.Error) return;
				const diag = diagnosticToTscDiagnostic(diagnostic, this.tsconfigDir);
				if (diag) {
					this.cachedDiagnostics.push(diag);
				}
			},
			(
				_diagnostic: ts.Diagnostic,
				_newLine: string,
				_options: ts.CompilerOptions,
				errorCount?: number,
			) => {
				if (errorCount === undefined) {
					// New compilation cycle starting — clear previous diagnostics
					// Reference: TypeScript watch.ts — errorCount is undefined only
					// during the onWatchStatusChange callback for "new compilation
					// cycle starting" signal.
					this.cachedDiagnostics = [];
				} else {
					// Compilation complete — update trend and notify listeners
					const errCount = this.cachedDiagnostics.filter(
						(d) => d.severity === "Error",
					).length;
					this.trendTracker.push(errCount);
					this.notifyListeners();
				}
			},
		);

		this.watchProgram = ts.createWatchProgram(host);
		this.running = true;
		return true;
	}

	/** Stop the watcher. No-op if not running. */
	stop(): void {
		if (!this.running) return;
		this.watchProgram?.close();
		this.running = false;
		this.watchProgram = undefined;
	}

	/** Whether the watcher is currently running. */
	isRunning(): boolean {
		return this.running;
	}

	/** Get the latest cached diagnostics. */
	getDiagnostics(): TscDiagnostic[] {
		return [...this.cachedDiagnostics];
	}

	/** Register a callback for when diagnostics change. */
	onDiagnosticsChange(listener: (d: TscDiagnostic[]) => void): void {
		this.diagnosticListeners.push(listener);
	}

	/**
	 * Get the diagnostic trend between the last two checks.
	 * Delegates to TrendTracker — pure computation, no I/O.
	 */
	getTrend(): DiagnosticTrend | undefined {
		return this.trendTracker.getTrend();
	}

	/**
	 * Test-only: inject diagnostics without starting the watch program.
	 * Simulates the effect of a completed compilation cycle for unit tests.
	 */
	_injectDiagnostics(diagnostics: TscDiagnostic[]): void {
		this.cachedDiagnostics = diagnostics;
		const errorCount = diagnostics.filter((d) => d.severity === "Error").length;
		this.trendTracker.push(errorCount);
		this.notifyListeners();
	}

	private notifyListeners(): void {
		const snapshot = [...this.cachedDiagnostics];
		for (const listener of this.diagnosticListeners) {
			listener(snapshot);
		}
	}
}
