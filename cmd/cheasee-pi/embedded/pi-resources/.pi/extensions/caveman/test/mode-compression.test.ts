/**
 * Phase 2: Mode-adaptive compression — pure function + use-case tests
 *
 * resolveCompression(level, mode) determines whether to skip compression
 * based on the current run mode. JSON and RPC modes skip to avoid mangling
 * structured output. Print and TUI modes apply compression normally.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCompression, type ExtensionMode } from "../compression.ts";
import type { Level } from "../types.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveCompression — pure function", () => {
	// --- General: off always skips ---

	it('level="off" + any mode → skip', () => {
		for (const mode of ["tui", "rpc", "json", "print"] as ExtensionMode[]) {
			const result = resolveCompression("off", mode);
			assert.equal(result.skip, true);
		}
	});

	// --- JSON mode: always skip ---

	it('mode="json" + level="lite" → skip', () => {
		const result = resolveCompression("lite", "json");
		assert.equal(result.skip, true);
	});

	it('mode="json" + level="full" → skip', () => {
		const result = resolveCompression("full", "json");
		assert.equal(result.skip, true);
	});

	it('mode="json" + level="ultra" → skip', () => {
		const result = resolveCompression("ultra", "json");
		assert.equal(result.skip, true);
	});

	// --- RPC mode: skip (output consumed by programmatic consumers) ---

	it('mode="rpc" + level="full" → skip', () => {
		const result = resolveCompression("full", "rpc");
		assert.equal(result.skip, true);
	});

	it('mode="rpc" + level="lite" → skip', () => {
		const result = resolveCompression("lite", "rpc");
		assert.equal(result.skip, true);
	});

	// --- Print mode: full compression ---

	it('mode="print" + level="full" → full intensity', () => {
		const result = resolveCompression("full", "print");
		assert.equal(result.skip, false);
		assert.equal(result.intensity, "full");
	});

	it('mode="print" + level="lite" → lite intensity', () => {
		const result = resolveCompression("lite", "print");
		assert.equal(result.skip, false);
		assert.equal(result.intensity, "lite");
	});

	// --- TUI mode: full compression ---

	it('mode="tui" + level="full" → full intensity', () => {
		const result = resolveCompression("full", "tui");
		assert.equal(result.skip, false);
		assert.equal(result.intensity, "full");
	});

	it('mode="tui" + level="lite" → lite intensity', () => {
		const result = resolveCompression("lite", "tui");
		assert.equal(result.skip, false);
		assert.equal(result.intensity, "lite");
	});

	it('mode="tui" + level="ultra" → ultra intensity', () => {
		const result = resolveCompression("ultra", "tui");
		assert.equal(result.skip, false);
		assert.equal(result.intensity, "ultra");
	});

	// --- Boundary: mode undefined/missing → conservative (tui behavior) ---

	it('mode=undefined + level="full" → full intensity (conservative)', () => {
		const result = resolveCompression("full", undefined);
		assert.equal(result.skip, false);
		assert.equal(result.intensity, "full");
	});

	it('mode=undefined + level="lite" → lite intensity', () => {
		const result = resolveCompression("lite", undefined);
		assert.equal(result.skip, false);
		assert.equal(result.intensity, "lite");
	});
});
