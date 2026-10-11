/**
 * capture.ts — Shared capture harness for supervisor output tests.
 *
 * Barrel (issue #2001 split): the captured-output container lives in
 * capture-core.ts, the ExtensionAPI mocks in mock-pi.ts, and the
 * command-context mock in mock-ctx.ts. Every importer keeps using this path.
 *
 * Run with: node --experimental-strip-types --test
 *
 * Usage:
 * ```ts
 * import { describe, it, beforeEach } from "node:test";
 * import { CapturedOutput, createMockPi, createMockCtx } from "../helpers/capture.ts";
 *
 * let captured: CapturedOutput;
 * let pi: ExtensionAPI;
 * let ctx: ExtensionCommandContext;
 *
 * beforeEach(() => {
 *   captured = new CapturedOutput();
 *   pi = createMockPi(captured);
 *   ctx = createMockCtx(captured);
 * });
 * ```
 */

export {
	CapturedOutput,
	makeExecResult,
	mockExecResponse,
	setMockResponses,
	resetMocks,
} from "./capture-core.ts";
export type {
	CapturedMessage,
	CapturedWidget,
	CapturedStatus,
	CapturedNotification,
	CapturedExecCall,
	ExecResult,
} from "./capture-core.ts";
export { createMockPi, createMockUI, createMockTheme } from "./mock-pi.ts";
export { createMockCtx } from "./mock-ctx.ts";
