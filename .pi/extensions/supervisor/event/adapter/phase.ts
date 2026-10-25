// --- Phase ordering ---------------------------------------------
// Which phase an event may raise the run state to. Split out of handlers.ts
// (issue #2033) so the thinking and text handlers share one table.

import type { AgentPhase } from "../../config/types.ts";

/** Numeric priority for phase ordering. Higher = more important. */
export function phasePriority(phase: AgentPhase): number {
	switch (phase) {
		case "tool":
			return 3;
		case "thinking":
			return 2;
		case "text":
			return 1;
		case "idle":
			return 0;
	}
}
