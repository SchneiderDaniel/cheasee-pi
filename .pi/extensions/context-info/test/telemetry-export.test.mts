/**
 * Tests verifying telemetry.ts module public API surface
 *
 * After removing the `export` keyword from `isJsonMode()`:
 * - `isJsonMode` should no longer be a named export
 * - `tryEmit` should remain the public export
 * - Behavioral regressions: tryEmit still works correctly in JSON mode
 *
 * IMPORTANT: Must NOT statically import (type or value) the removed symbol.
 * Use only dynamic `import()` for verification.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/telemetry-export.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Phase 1: Removal verification — dynamic imports only
// ---------------------------------------------------------------------------

describe("isJsonMode — export removal verification", () => {
	it("isJsonMode is NOT a named export of telemetry.ts (dynamic import returns undefined)", async () => {
		// Dynamic import to avoid static import of removed symbol
		const mod = (await import("../telemetry.ts")) as Record<string, unknown>;
		// After removing `export`, isJsonMode should be undefined on the module
		assert.strictEqual(
			(mod as any).isJsonMode,
			undefined,
			"isJsonMode should not be a named export after removing export keyword",
		);
	});

	it("tryEmit IS still a named export of telemetry.ts", async () => {
		const mod = (await import("../telemetry.ts")) as Record<string, unknown>;
		assert.strictEqual(
			typeof (mod as any).tryEmit,
			"function",
			"tryEmit should remain a named export",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Behavioral regression — tryEmit with JSON mode
// ---------------------------------------------------------------------------

/**
 * Helper: create a mock argv with --mode json or --mode tui.
 * Returns { restore } to reset process.argv afterward.
 * Node --experimental-strip-types isolates test files per run.
 */
function withArgv(mode: string): { restore: () => void } {
	const originalArgv = process.argv;
	// We must preserve at least the first two entries (node binary + script path)
	// but for this test, the only position we care about is --mode value.
	// We'll construct argv with --mode <mode> at the standard positions.
	let newArgv: string[];
	if (mode === "json") {
		newArgv = ["node", "test", "--mode", "json"];
	} else {
		// Non-JSON mode: could be --mode tui, or no --mode at all
		newArgv = ["node", "test", "--mode", "tui"];
	}
	Object.defineProperty(process, "argv", {
		value: newArgv,
		writable: true,
		configurable: true,
	});
	return {
		restore: () => {
			Object.defineProperty(process, "argv", {
				value: originalArgv,
				writable: true,
				configurable: true,
			});
		},
	};
}

describe("tryEmit — behavioral regression tests", () => {
	it("tryEmit with isJsonMode=true path (JSON mode on) — telemetry suppressed", async () => {
		// Arrange: set JSON mode
		const { restore } = withArgv("json");

		// Import telemetry module
		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		// Capture console.log output
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			// Act: simulate tryEmit with valid state
			const state = {
				emitted: false,
				footerConfig: { lastContextWindow: { value: 256000 } },
			};
			const ctx = { getContextUsage: () => ({ tokens: 12400, contextWindow: 256000 }) };

			tryEmit(ctx, state);

			// Assert: no telemetry emitted because JSON mode suppresses it
			assert.strictEqual(logs.length, 0, "tryEmit should not emit telemetry in JSON mode");
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("tryEmit with isJsonMode=false path (JSON mode off) — telemetry emitted", async () => {
		// Arrange: set non-JSON mode
		const { restore } = withArgv("tui");

		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			// Act
			const state = {
				emitted: false,
				footerConfig: { lastContextWindow: { value: 256000 } },
			};
			const ctx = { getContextUsage: () => ({ tokens: 12400, contextWindow: 256000 }) };

			tryEmit(ctx, state);

			// Assert: telemetry IS emitted when not in JSON mode
			assert.strictEqual(logs.length, 1, "tryEmit should emit telemetry when not in JSON mode");
			const parsed = JSON.parse(logs[0]!);
			assert.strictEqual(parsed.type, "context_info");
			assert.strictEqual(parsed.contextTokens, 12400);
			assert.strictEqual(parsed.contextWindow, 256000);
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("tryEmit with state.emitted=true — early return, no emission", async () => {
		const { restore } = withArgv("tui");

		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			const state = {
				emitted: true, // Already emitted
				footerConfig: { lastContextWindow: { value: 256000 } },
			};
			const ctx = { getContextUsage: () => ({ tokens: 12400, contextWindow: 256000 }) };

			tryEmit(ctx, state);

			assert.strictEqual(logs.length, 0, "should not emit when already emitted");
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("tryEmit with null context window — early return", async () => {
		const { restore } = withArgv("tui");

		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			const state = {
				emitted: false,
				footerConfig: { lastContextWindow: { value: undefined } },
			};
			const ctx = { getContextUsage: () => ({ tokens: 12400, contextWindow: 256000 }) };

			tryEmit(ctx, state);

			assert.strictEqual(logs.length, 0, "should not emit with null context window");
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("tryEmit with missing context window (0 or negative) — early return", async () => {
		const { restore } = withArgv("tui");

		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			const state = {
				emitted: false,
				footerConfig: { lastContextWindow: { value: 0 } },
			};
			const ctx = { getContextUsage: () => ({ tokens: 12400, contextWindow: 256000 }) };

			tryEmit(ctx, state);

			assert.strictEqual(logs.length, 0, "should not emit with zero context window");
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("tryEmit with null/undefined token count — early return", async () => {
		const { restore } = withArgv("tui");

		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			const state = {
				emitted: false,
				footerConfig: { lastContextWindow: { value: 256000 } },
			};
			const ctx = { getContextUsage: () => undefined };

			tryEmit(ctx, state);

			assert.strictEqual(logs.length, 0, "should not emit with null context usage");
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("tryEmit with null/undefined tokens (string or zero) — early return", async () => {
		const { restore } = withArgv("tui");

		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			const state = {
				emitted: false,
				footerConfig: { lastContextWindow: { value: 256000 } },
			};
			// tokens is null → should early return
			const ctx = { getContextUsage: () => ({ tokens: null, contextWindow: 256000 }) as any };

			tryEmit(ctx, state);

			assert.strictEqual(logs.length, 0, "should not emit with null token count");
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("tryEmit idempotency — second call does not emit again", async () => {
		const { restore } = withArgv("tui");

		const mod = (await import("../telemetry.ts")) as { tryEmit: Function };
		const { tryEmit } = mod;

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			const state = {
				emitted: false,
				footerConfig: { lastContextWindow: { value: 256000 } },
			};
			const ctx = { getContextUsage: () => ({ tokens: 12400, contextWindow: 256000 }) };

			// First call — should emit
			tryEmit(ctx, state);
			assert.strictEqual(logs.length, 1, "first call should emit");

			// Second call — should NOT emit (state.emitted is now true)
			tryEmit(ctx, state);
			assert.strictEqual(logs.length, 1, "second call should not emit again");
		} finally {
			console.log = origLog;
			restore();
		}
	});
});
