/**
 * mock-pi-session.ts — mock `ReadonlySessionManager` factory.
 *
 * Split out of mock-pi.ts (issue #2036); `mock-pi.ts` re-exports it.
 */

import { sessionCoreStubs } from "./mock-pi-session-core.ts";
import { sessionTreeStubs } from "./mock-pi-session-tree.ts";

/** Minimal stub satisfying ReadonlySessionManager (structural Pick<> type). */
export function createMockSessionManager() {
	return {
		...sessionCoreStubs(),
		...sessionTreeStubs(),
	};
}
