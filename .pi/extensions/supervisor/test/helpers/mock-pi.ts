/**
 * mock-pi.ts — ExtensionAPI / UI-context mock factories.
 *
 * Split out of capture.ts (issue #2001); the object-literal stub groups split
 * into per-responsibility siblings here (issue #2036) so no module carries a
 * `VBA God Module` declaration count. The public surface is unchanged: this
 * file re-exports every factory and owns `createMockPi`.
 */

import type { ExtensionAPI, EventBus } from "@earendil-works/pi-coding-agent";
import { CapturedOutput } from "./capture-core.ts";
import { apiCommandStubs } from "./mock-pi-api-commands.ts";
import { apiRuntimeStubs } from "./mock-pi-api-runtime.ts";
import { apiToolStubs } from "./mock-pi-api-tools.ts";

export { createMockTheme } from "./mock-pi-theme.ts";
export { createMockUI } from "./mock-pi-ui.ts";
export { createMockSessionManager } from "./mock-pi-session.ts";
export { createMockModelRegistry } from "./mock-pi-model.ts";

/**
 * Create a complete ExtensionAPI mock backed by `captured`.
 *
 * Captured methods:
 * - `sendMessage()` pushes to `captured.messages` (including options)
 * - `exec()` pushes to `captured.execCalls`, returns registered fixture or default error
 * - `events.emit()` is a safe no-op
 *
 * @example
 * ```ts
 * const captured = new CapturedOutput();
 * const pi = createMockPi(captured);
 * pi.sendMessage({ customType: "test", content: "hello", display: true });
 * assert.equal(captured.messages.length, 1);
 * ```
 */
export function createMockPi(captured: CapturedOutput): ExtensionAPI {
	const events: EventBus = {
		emit(_channel: string, _data: unknown) {},
		on(_channel: string, _handler: (data: unknown) => void): () => void {
			return () => {};
		},
	};

	const pi: ExtensionAPI = {
		...apiCommandStubs,
		...apiToolStubs,
		...apiRuntimeStubs(captured),
		events,
	};

	return pi;
}
