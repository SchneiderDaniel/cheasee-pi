/**
 * Compile-time contract test (no runtime assertions).
 *
 * Enforces that both renderer factories are assignable to pi's exported
 * `MessageRenderer` type — i.e. the `any` callbacks are gone. Typechecked by
 * `npx tsc --noEmit --project .pi/tsconfig.json`; the checks live inside an
 * unexecuted function so a broad test glob has nothing to run.
 */

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer, createSummaryRenderer } from "../session/message-renderer.ts";
import type { SupervisorDetails } from "../session/message-renderers/types.ts";

/** Never called — type-level checks only. */
function _rendererContractChecks(pi: Parameters<typeof createMessageRenderer>[0]): void {
	const messageRenderer: MessageRenderer<SupervisorDetails> = createMessageRenderer(pi);
	const summaryRenderer: MessageRenderer = createSummaryRenderer(pi);
	void messageRenderer;
	void summaryRenderer;

	// A wrong-typed invocation must be rejected. If a factory ever regresses to
	// a callback typed `any`, this directive becomes unused and tsc fails.
	// @ts-expect-error — first argument must be a CustomMessage
	createMessageRenderer(pi)("not a message", { expanded: false }, null as never);
}
void _rendererContractChecks;
