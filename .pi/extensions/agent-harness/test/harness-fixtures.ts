// ─── agent-harness test fixtures (issue #2005 Long File split) ───
// Shared harness/API/config helpers moved out of index.test.ts. Non-test
// module so `node --test` does not load it as a suite.

import assert from "node:assert/strict";
import { AgentHarness } from "../index.ts";
import type { ToolCallResult } from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { commandStubs } from "./harness-api-stubs.ts";
import { sessionStubs } from "./harness-api-stubs-session.ts";

export function makeEvent(toolName: string, args: Record<string, unknown> = {}, isError = false) {
	return { toolName, input: args, isError };
}

export function makeCtx() {
	return {};
}

export function callNTimes(
	harness: AgentHarness,
	toolName: string,
	n: number,
	args: Record<string, unknown> = {},
): (ToolCallResult | null)[] {
	const results: (ToolCallResult | null)[] = [];
	for (let i = 0; i < n; i++) {
		results.push(harness.handleToolCall(makeEvent(toolName, args), makeCtx()));
	}
	return results;
}

export function createMockAPI() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const api = {
		handlers,
		on(event: any, handler: any) {
			handlers.set(event, handler);
		},
		fire(event: string, data: any, ctx?: any) {
			const handler = handlers.get(event);
			return handler ? handler(data, ctx ?? {}) : undefined;
		},
		...commandStubs(),
		...sessionStubs(),
	};
	return api as typeof api & ExtensionAPI;
}

// ── Mock ExtensionAPI integration ──

// Track for cleanup
export const configTempDirs: string[] = [];

export function createConfigTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-wiring-test-"));
	configTempDirs.push(dir);
	fs.mkdirSync(path.join(dir, ".pi"));
	return dir;
}

export function writeHarnessConfig(dir: string, content: unknown): void {
	fs.writeFileSync(path.join(dir, ".pi", "harness-config.json"), JSON.stringify(content), "utf-8");
}

export function makeConfigCtx(overrides: Record<string, unknown> = {}) {
	return {
		isProjectTrusted: () => true,
		ui: {
			notify: () => {},
		},
		...overrides,
	};
}

export function makeCtxWithUI(hasUI: boolean) {
	return { hasUI } as any;
}
