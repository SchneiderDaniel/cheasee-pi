// ── Shared event contract: supervisor → context-info issue data ──
// The supervisor pipeline publishes the issue it is working on, the
// context-info footer subscribes and mirrors it. Topic and payload shape live
// here, in a module that belongs to neither extension: producers and consumers
// import the same declaration, so the two sides cannot drift apart.
//
// Why an event at all: a dynamic import of `context-info` from the supervisor
// builds a second module instance (jiti vs native ESM), so a module-level
// state reference would never be the live one. `pi.events` is a single shared
// bus, and it carries no module state.

/** Topic used by both the supervisor (emit) and context-info (subscribe). */
export const ISSUE_DATA_EVENT = "supervisor:issue-data";

/**
 * Payload contract.
 *
 * `null` is the clear sentinel: the pipeline finished and the footer must drop
 * the issue row. Any other value describes the issue currently being worked.
 */
export type IssueDataEvent = {
	issueNumber: number;
	issueRepo: string;
	issueTitle: string;
} | null;

/**
 * Narrow a raw bus payload to {@link IssueDataEvent}.
 *
 * `EventBus.on` hands the listener `unknown`, so exactly one place has to turn
 * an unvalidated payload into the typed contract — this one. The return value
 * distinguishes the three cases a listener cares about: `null` clears, an
 * object sets, and `undefined` means "not our payload, ignore it" (a foreign
 * emitter must never clear a footer it knows nothing about).
 */
export function parseIssueDataEvent(raw: unknown): IssueDataEvent | undefined {
	if (raw === null) return null;
	if (typeof raw !== "object") return undefined;
	if (!("issueNumber" in raw) || !("issueRepo" in raw) || !("issueTitle" in raw)) {
		return undefined;
	}
	const { issueNumber, issueRepo, issueTitle } = raw;
	if (typeof issueNumber !== "number" || !Number.isFinite(issueNumber)) return undefined;
	if (typeof issueRepo !== "string" || typeof issueTitle !== "string") return undefined;
	return { issueNumber, issueRepo, issueTitle };
}
