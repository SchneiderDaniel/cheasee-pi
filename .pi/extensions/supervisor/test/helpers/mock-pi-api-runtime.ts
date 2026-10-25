/**
 * mock-pi-api-runtime.ts — captured session-messaging and `exec` stubs for the
 * `ExtensionAPI` mock.
 *
 * Split out of mock-pi.ts (issue #2036). These write into `captured`, so they
 * are a factory spread by `createMockPi`.
 */

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { CapturedOutput, makeExecResult, lookupExecFixture } from "./capture-core.ts";

export function apiRuntimeStubs(captured: CapturedOutput) {
	return {
		// ══ Session messaging ══
		sendMessage<T = unknown>(
			message: { customType: string; content: any; display?: boolean; details?: T },
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		) {
			captured.messages.push({
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				triggerTurn: options?.triggerTurn,
				deliverAs: options?.deliverAs,
			});
		},
		sendUserMessage(_content: any, _options?: any) {},
		appendEntry<T = unknown>(_customType: string, _data?: T) {},
		setSessionName(_name: string) {},
		getSessionName(): string | undefined {
			return undefined;
		},
		setLabel(_entryId: string, _label?: string) {},

		// ══ Command execution ══
		async exec(command: string, args: string[], _options?: ExecOptions): Promise<ExecResult> {
			captured.execCalls.push({ cmd: command, args });
			const fixture = lookupExecFixture(command, args);
			return fixture ?? makeExecResult({ code: 1 });
		},
	};
}
