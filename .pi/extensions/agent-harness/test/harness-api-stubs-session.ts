// ─── mock ExtensionAPI tool/model/provider stubs (VBA god module split #2036) ───
// Remaining no-op members of `createMockAPI`'s object literal: tool listing,
// command listing, model selection and provider registration. Split from the
// sibling `harness-api-stubs.ts` so no single file carries the whole mock surface.

export function sessionStubs() {
	return {
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off" as any,
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		events: { on: () => {}, emit: () => {}, off: () => {} } as any,
	};
}
