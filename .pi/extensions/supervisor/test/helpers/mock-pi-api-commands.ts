/**
 * mock-pi-api-commands.ts — command/flag/provider/model stubs for the
 * `ExtensionAPI` mock.
 *
 * Split out of mock-pi.ts (issue #2036). These need no captured output, so they
 * are a plain object spread by `createMockPi`.
 */

import type { Model } from "@earendil-works/pi-ai";

export const apiCommandStubs = {
	// ══ Event handlers (all events) ══
	on(_event: any, _handler: any) {
		return () => {};
	},

	// ══ Commands ══
	registerCommand(_name: string, _options: any) {},
	registerShortcut(_shortcut: any, _options: any) {},
	registerFlag(_name: string, _options: any) {},
	getFlag(_name: string): boolean | string | undefined {
		return undefined;
	},

	// ══ Commands info ══
	getCommands(): any[] {
		return [];
	},

	// ══ Model ══
	async setModel(_model: Model<any>): Promise<boolean> {
		return true;
	},
	getThinkingLevel(): any {
		return "off";
	},
	setThinkingLevel(_level: any) {},

	// ══ Providers ══
	registerProvider(_providerOrName: any, _config?: any) {},
	unregisterProvider(_name: string) {},
};
