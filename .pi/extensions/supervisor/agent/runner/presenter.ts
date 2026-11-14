// ─── Run presentation port ────────────────────────────────────────
// Inner port owned by the runner USE CASES: "what a run reports to the
// operator" (issue #2106). Types only — no `ctx.ui`, no widget rendering,
// no SDK import — so spawned-run/event-loop depend on this contract
// instead of reaching into the terminal.
//
// Adapters: runner/ui.ts (outer — renders through ctx.ui) and the test
// fakes (a recording presenter). runner/index.ts is the only module that
// knows both sides, which is why the `runner → ui` edge survives there:
// composition roots must know their adapters.

export interface RunPresenter {
	/** Schedule a debounced render of the run widget (bursts coalesce). */
	scheduleFlush(): void;
	/** Operator-visible "<agent>: <tool>" line; `undefined` clears it. */
	setWorkingMessage(message?: string): void;
	/** Announce that the run started (notification + supervisor status). */
	announceStart(agentName: string): void;
	/** Tear down run-scoped presentation: widget → working message → status. */
	clear(): void;
	/** Cancel pending presentation timers. Idempotent. */
	dispose(): void;
}
