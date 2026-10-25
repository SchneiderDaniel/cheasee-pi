/**
 * mock-pi-api-tools.ts — tool / renderer / MCP / virtual-model stubs for the
 * `ExtensionAPI` mock.
 *
 * Split out of mock-pi.ts (issue #2036). These need no captured output, so they
 * are a plain object spread by `createMockPi`.
 */

export const apiToolStubs = {
	// ══ Tools ══
	registerTool(_tool: any) {},
	registerMessageRenderer(_customType: string, _renderer: any) {},
	getActiveTools(): string[] {
		return [];
	},
	getAllTools(): any[] {
		return [];
	},
	setActiveTools(_toolNames: string[]) {},
	registerMarkdownTransformer(_transformer: any) {},
	registerEntryRenderer(_customType: string, _renderer: any) {},
	registerToolRenderer(_resolver: any) {},
	getSettings(): any {
		return {};
	},
	registerMcpServer(_name: string, _config: any) {},
	unregisterMcpServer(_name: string) {},
	getMcpServers(): any[] {
		return [];
	},
	registerVirtualModel(_model: any) {},
	unregisterVirtualModel(_provider: string, _id: string) {},
};
