/**
 * tsc-checkpoint — Shared test utilities
 *
 * MockAdapter: a test double for TscWatchAdapter used across
 * watcher, adapter, and index test files.
 */

import type { TscDiagnostic, TscWatchAdapter } from "../index.ts";

/**
 * Mock adapter for deterministic testing of DiagnosticsWatcher
 * and the extension entry point without a real TypeScript compiler.
 */
export class MockAdapter implements TscWatchAdapter {
	startCalls = 0;
	stopCalls = 0;
	lastStartPath = "";
	private _isRunning = false;
	private _diagnostics: TscDiagnostic[] = [];
	private _listeners: Array<(diagnostics: TscDiagnostic[]) => void> = [];
	private _shouldFailStart = false;

	setShouldFailStart(fail: boolean): void {
		this._shouldFailStart = fail;
	}

	start(tsconfigPath: string): boolean {
		this.startCalls++;
		this.lastStartPath = tsconfigPath;
		if (this._isRunning) return false;
		if (this._shouldFailStart) {
			throw new Error(`tsconfig not found: ${tsconfigPath}`);
		}
		this._isRunning = true;
		return true;
	}

	stop(): void {
		this.stopCalls++;
		this._isRunning = false;
	}

	isRunning(): boolean {
		return this._isRunning;
	}

	getDiagnostics(): TscDiagnostic[] {
		return this._diagnostics;
	}

	onDiagnosticsChange(callback: (diagnostics: TscDiagnostic[]) => void): void {
		this._listeners.push(callback);
	}

	/** Test helper: simulate a diagnostic event from the watch process */
	emitDiagnostics(diagnostics: TscDiagnostic[]): void {
		this._diagnostics = diagnostics;
		for (const listener of this._listeners) {
			listener(diagnostics);
		}
	}
}
