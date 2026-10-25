// ─── mock ExtensionAPI command/flag/tool stubs (VBA god module split #2036) ───
// Bundle of the no-op command, flag, tool and session-message members of
// `createMockAPI`'s object literal. Split out so no single file carries the
// whole mock surface.

export function commandStubs() {
	return {
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
}
