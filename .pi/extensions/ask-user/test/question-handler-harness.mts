// ─── question-handler shared test mock (issue #2035 Long File split) ───
// Lives in a non-`.test.mts` module so `node --test` never loads it as a suite.
import type { QuestionHandlerContext } from "../question-handler.ts";

type MockCtx = QuestionHandlerContext;
type MockUI = QuestionHandlerContext["ui"];

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockCtx(overrides?: Partial<MockUI>): MockCtx {
	const ui: MockUI = {
		input: async () => "mock answer",
		custom: async <T,>() => undefined as T,
		select: async () => undefined,
		notify: () => {},
		...overrides,
	};

	return {
		ui,
		// Trust gate off by default: `true` would run the real appendQnaEntry.
		isProjectTrusted: async () => false,
	};
}

export { makeMockCtx };
export type { MockCtx, MockUI };
