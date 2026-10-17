// ─── caveman shared mock builders (issue #2035 Long File split) ───
// Lives in a non-`.test.mts` module so `node --test` never loads it as a suite.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface EventHandler {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

function makeMockPi(): {
	pi: ExtensionAPI;
	events: EventHandler[];
	entries: { type: string; data: unknown }[];
	commands: { name: string; def: unknown }[];
} {
	const events: EventHandler[] = [];
	const entries: { type: string; data: unknown }[] = [];
	const commands: { name: string; def: unknown }[] = [];

	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			events.push({ event, handler });
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
		registerCommand: (name: string, def: unknown) => {
			commands.push({ name, def });
		},
	} as unknown as ExtensionAPI;

	return { pi, events, entries, commands };
}

function makeMockSessionManager() {
	return {
		getEntries: () => [] as unknown[],
		getBranch: () => [] as unknown[],
	};
}

function makeMockCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		ui: {
			setStatus: () => {},
			notify: () => {},
			theme: {
				fg: () => (s: string) => s,
				bold: (s: string) => s,
			},
		} as unknown as ExtensionContext["ui"],
		sessionManager: makeMockSessionManager(),
		mode: "tui",
		isProjectTrusted: () => true,
		...overrides,
	} as ExtensionContext;
}

export { makeMockCtx, makeMockPi, makeMockSessionManager };
export type { EventHandler };
