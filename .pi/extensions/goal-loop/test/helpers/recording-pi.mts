/**
 * recording-pi.mts — an `ExtensionAPI` double that RECORDS registrations.
 *
 * The shared `createMockPi` stubs `on`/`registerCommand` with no-ops, which is
 * fine for modules that only register. The goal-loop wiring must be driven from
 * its handlers, so this double keeps them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RecordedCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

export interface RecordedHandler {
	(event: unknown, ctx: unknown): Promise<unknown>;
}

export interface Notification {
	message: string;
	type: string;
}

export interface RecordingPi {
	pi: ExtensionAPI;
	commands: Map<string, RecordedCommand>;
	handlers: Map<string, RecordedHandler[]>;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	/** Messages sent to the agent through `sendUserMessage`. */
	sent: string[];
	/** Emit an event to every registered handler; returns the first non-undefined result. */
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown>;
	runCommand(name: string, args: string, ctx: unknown): Promise<void>;
}

export function createRecordingPi(): RecordingPi {
	const commands = new Map<string, RecordedCommand>();
	const handlers = new Map<string, RecordedHandler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const sent: string[] = [];

	const pi = {
		on(event: string, handler: RecordedHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, options: RecordedCommand) {
			commands.set(name, options);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
		sendUserMessage(content: unknown) {
			sent.push(typeof content === "string" ? content : JSON.stringify(content));
		},
		sendMessage() {},
		appendEntry() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		async exec() {
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
		events: { emit() {}, on: () => () => {} },
	} as unknown as ExtensionAPI;

	async function emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const produced = await handler(payload, ctx);
			if (produced !== undefined) result = produced;
		}
		return result;
	}

	async function runCommand(name: string, args: string, ctx: unknown): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`command /${name} was not registered`);
		await command.handler(args, ctx);
	}

	return { pi, commands, handlers, tools, sent, emit, runCommand };
}

export interface UiCtx {
	ctx: Record<string, unknown>;
	notifications: Notification[];
	/** Set to prove the wiring never replaces the session. */
	newSessionCalls: number;
}

/**
 * Minimal command context. `newSession` throws so any attempt to replace the
 * session from a lifecycle handler fails loudly.
 */
export function createUiCtx(cwd = "/repo"): UiCtx {
	const notifications: Notification[] = [];
	const state = { newSessionCalls: 0 };
	const ctx: Record<string, unknown> = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			notify(message: string, type: string = "info") {
				notifications.push({ message, type });
			},
			setStatus() {},
			setWidget() {},
			addAutocompleteProvider() {},
		},
		async newSession() {
			state.newSessionCalls += 1;
			throw new Error("newSession must never be called from a lifecycle handler");
		},
		async withSession() {
			state.newSessionCalls += 1;
			throw new Error("withSession must never be called from a lifecycle handler");
		},
	};
	return {
		ctx,
		notifications,
		get newSessionCalls() {
			return state.newSessionCalls;
		},
	};
}
