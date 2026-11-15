// Use case: the one error that means "this run stopped on purpose".
//
// A halt is not a per-test pending: the run ends with a message an operator can
// act on (provider outage, checkpoint refusal, filing failure, incomplete
// inventory). Its own module so the pool and the orchestrator can both throw it
// without importing each other.

export class RunHaltedError extends Error {
	readonly code = "RUN_HALTED";
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "RunHaltedError";
	}
}
