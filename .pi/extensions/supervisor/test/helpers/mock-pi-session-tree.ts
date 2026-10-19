/**
 * mock-pi-session-tree.ts — session tree-access stubs.
 *
 * Split out of mock-pi.ts (issue #2036); `mock-pi-session.ts` composes it with
 * the cwd/id/entry subset.
 */

export function sessionTreeStubs() {
	return {
		getHeader: () => null,
		getEntries: () => [],
		getTree: () => [],
		getSessionName: () => undefined,
	};
}
