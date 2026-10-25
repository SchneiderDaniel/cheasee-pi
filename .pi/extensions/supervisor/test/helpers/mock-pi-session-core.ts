/**
 * mock-pi-session-core.ts — cwd / id / entry / branch session-manager stubs.
 *
 * Split out of mock-pi.ts (issue #2036); `mock-pi-session.ts` composes it with
 * the tree-access subset.
 */

/** Minimal stub satisfying the ReadonlySessionManager cwd/id/entry surface. */
export function sessionCoreStubs() {
	return {
		getCwd: () => "/repo",
		getSessionDir: () => "/repo/.pi/sessions",
		getSessionId: () => "mock-session-id",
		getSessionFile: () => "/repo/.pi/sessions/mock.json",
		getLeafId: () => null,
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => [],
		buildContextEntries: () => [],
		buildSessionProjection: () => ({
			entries: [],
			messages: [],
			thinkingLevel: "off",
			model: null,
		}),
	};
}
