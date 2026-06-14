// ─── Watchdog — liveness probe for agent session event delivery ────
// Phase 2: Detects stalled event processing and triggers recovery.
// Pure timer logic — no TUI or Pi API dependencies.

// ─── Types ──────────────────────────────────────────────────────────

export interface WatchdogOptions {
	/** Timeout in ms — if no reset within this period, the watchdog fires */
	timeoutMs: number;
	/** Interval in ms between checks */
	checkIntervalMs: number;
	/** Callback invoked when watchdog timeout is reached */
	onTimeout: (elapsedMs: number) => void;
}

export interface WatchdogHandle {
	/** Reset the watchdog timer (call on every event) */
	reset: () => void;
	/** Start the watchdog interval */
	start: () => void;
	/** Stop the watchdog interval */
	stop: () => void;
	/** Pause elapsed-time accumulation (e.g. during long-running tool execution) */
	pause: () => void;
	/** Resume elapsed-time accumulation after pause */
	resume: () => void;
	/** The current elapsed time since last reset (0 if never reset). Excludes paused intervals. */
	getElapsedMs: () => number;
	/** Whether the watchdog is currently running */
	isRunning: () => boolean;
}

// ─── createWatchdog ────────────────────────────────────────────────

/**
 * Create a watchdog timer that monitors event delivery liveness.
 *
 * The watchdog maintains an internal `lastEventTime` timestamp.
 * On each check interval, if `timeoutMs` has elapsed since the last reset,
 * the `onTimeout` callback is invoked with the elapsed milliseconds.
 *
 * @param options - Watchdog configuration
 * @returns WatchdogHandle for controlling the watchdog lifecycle
 */
export function createWatchdog(options: WatchdogOptions): WatchdogHandle {
	let lastEventTime = 0;
	let intervalId: ReturnType<typeof setInterval> | undefined;
	let running = false;
	let onTimeoutFired = false;
	let paused = false;
	let pauseStartTime = 0;
	let totalPausedMs = 0;

	const getEffectiveElapsed = (): number => {
		if (lastEventTime === 0) return 0;
		let elapsed = Date.now() - lastEventTime - totalPausedMs;
		if (paused) {
			elapsed -= Date.now() - pauseStartTime;
		}
		return elapsed;
	};

	const check = () => {
		if (lastEventTime === 0) return; // never reset — not started yet
		if (paused) return; // don't count paused time
		const elapsed = getEffectiveElapsed();
		if (elapsed >= options.timeoutMs && !onTimeoutFired) {
			onTimeoutFired = true;
			options.onTimeout(elapsed);
		}
	};

	const handle: WatchdogHandle = {
		reset: () => {
			lastEventTime = Date.now();
			onTimeoutFired = false;
			totalPausedMs = 0;
			paused = false;
		},
		start: () => {
			if (running) return;
			running = true;
			onTimeoutFired = false;
			lastEventTime = Date.now();
			totalPausedMs = 0;
			paused = false;
			intervalId = setInterval(check, options.checkIntervalMs);
		},
		stop: () => {
			if (intervalId !== undefined) {
				clearInterval(intervalId);
				intervalId = undefined;
			}
			running = false;
		},
		pause: () => {
			if (!running || paused) return;
			paused = true;
			pauseStartTime = Date.now();
		},
		resume: () => {
			if (!paused) return;
			totalPausedMs += Date.now() - pauseStartTime;
			paused = false;
		},
		getElapsedMs: () => getEffectiveElapsed(),
		isRunning: () => running,
	};

	return handle;
}
