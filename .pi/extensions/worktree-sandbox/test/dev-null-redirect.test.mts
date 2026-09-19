/**
 * Tests: /dev/null device-file exemption.
 *
 * Any redirect to /dev/null (the universal discard idiom) was blocked as a
 * write "outside the worktree". Fix: an enumerated allow-list
 * (`SIDE_EFFECT_FREE_DEVICES = { "/dev/null" }`) is composed ONLY into pure
 * content sinks — shell redirects (`>`, `>>`), `dd of=`, and `tee`.
 * Operations that can mutate the `/dev/null` directory entry or its metadata
 * (`cp` with `--remove-destination`/`-b`/`--backup`, `mv`, `ln`, `install`,
 * `touch`) and `cd` keep the strict containment check.
 *
 * Phase 1: /dev/null is allow-listed for content sinks (false positive fixed).
 * Phase 2: Exemption is not an escape primitive (exact match on resolved path).
 * Phase 3: Preserved behavior, scope, and API surface (regression).
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/worktree-sandbox/test/dev-null-redirect.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeToolCallEvent, makeCtx, makeMockPi, withSandboxEnv } from "./helpers.ts";
import type { ToolCallResult } from "./helpers.ts";

// ─── Modules under test ─────────────────────────────────────────────

let mod: {
	default: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;
	findUnsafeWriteInBash: (command: string, sandboxRoot: string) => string | null;
	findUnsafeCd: (command: string, sandboxRoot: string) => string | null;
	rewritePath: (
		toolName: "read" | "write" | "edit",
		event: { input: { path: string } },
		sandboxRoot: string,
		ctx: {
			hasUI: boolean;
			ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		},
		blockNoun: "file operations" | "writes" | "edits",
	) => ToolCallResult | undefined;
};

let tokenHelpers: {
	isPathSafe: (target: string, sandboxRoot: string) => boolean;
	isPathWithinSandbox: (absolutePath: string, sandboxRoot: string) => boolean;
	isSideEffectFreeDevice: (target: string) => boolean;
};

// Fixed sandbox root — pure string comparisons, no FS access.
const SB = "/home/user/project";
const ENV_KEY = "WORKTREE_SANDBOX_PATH";

describe("dev-null-redirect: /dev/null device exemption", () => {
	before(async () => {
		mod = await import("../index.ts");
		tokenHelpers = await import("../meaningful-token.ts");
	});

	// ═════════════════════════════════════════════════════════════════
	// Phase 1: /dev/null is allow-listed for content sinks (false positive fixed)
	// ═════════════════════════════════════════════════════════════════

	describe("Phase 1: /dev/null allow-listed for content sinks", () => {
		it("entity — pure containment predicate does NOT exempt /dev/null", () => {
			assert.equal(tokenHelpers.isPathSafe("/dev/null", SB), false);
		});

		it("entity — device predicate keys on the normalized absolute target", () => {
			assert.equal(tokenHelpers.isSideEffectFreeDevice("/dev/null"), true);
			assert.equal(tokenHelpers.isSideEffectFreeDevice("/dev/null/"), true);
			assert.equal(tokenHelpers.isSideEffectFreeDevice("/dev/../dev/null"), true);
			// Relative "dev/null" is not an absolute device path.
			assert.equal(tokenHelpers.isSideEffectFreeDevice("dev/null"), false);
		});

		it("use-case — all three stderr-suppression redirect idioms pass", () => {
			assert.equal(mod.findUnsafeWriteInBash("echo hi > /dev/null", SB), null);
			assert.equal(mod.findUnsafeWriteInBash("echo hi >> /dev/null", SB), null);
			assert.equal(mod.findUnsafeWriteInBash("npm install 2>/dev/null", SB), null);
			assert.equal(mod.findUnsafeWriteInBash("git status 2>/dev/null", SB), null);
			assert.equal(mod.findUnsafeWriteInBash("cmd &>/dev/null", SB), null);
			assert.equal(mod.findUnsafeWriteInBash("cmd > /dev/null 2>&1", SB), null);
			assert.equal(mod.findUnsafeWriteInBash("cmd 2>&1 >/dev/null", SB), null);
		});

		it("use-case — content-sink write branches inherit the exemption", () => {
			assert.equal(mod.findUnsafeWriteInBash("dd if=/dev/zero of=/dev/null", SB), null);
			assert.equal(mod.findUnsafeWriteInBash("echo x | tee /dev/null", SB), null);
		});

		it("use-case — cp is not a content sink: destination-unlink modes stay contained", () => {
			// GNU cp --remove-destination unlinks the destination before opening it;
			// -b/--backup rename it. cp is therefore not side-effect-free for /dev/null.
			assert.equal(mod.findUnsafeWriteInBash("cp x /dev/null", SB), "outside sandbox: /dev/null");
			assert.equal(
				mod.findUnsafeWriteInBash("cp --remove-destination payload /dev/null", SB),
				"outside sandbox: /dev/null",
			);
			assert.equal(mod.findUnsafeWriteInBash("cp -b x /dev/null", SB), "outside sandbox: /dev/null");
			assert.equal(
				mod.findUnsafeWriteInBash("cp --backup=numbered x /dev/null", SB),
				"outside sandbox: /dev/null",
			);
		});

		it("use-case — directory-entry / metadata ops stay contained (audit remedy)", () => {
			// mv renames the dir entry; ln links it; install copies + mutates mode/
			// owner; touch mutates metadata — none are side-effect-free for /dev/null.
			assert.equal(mod.findUnsafeWriteInBash("mv x /dev/null", SB), "outside sandbox: /dev/null");
			assert.equal(mod.findUnsafeWriteInBash("touch /dev/null", SB), "outside sandbox: /dev/null");
			assert.equal(mod.findUnsafeWriteInBash("install f /dev/null", SB), "outside sandbox: /dev/null");
			assert.equal(mod.findUnsafeWriteInBash("ln -s a /dev/null", SB), "outside sandbox: /dev/null");
			assert.equal(
				mod.findUnsafeWriteInBash("ln -sf payload /dev/null", SB),
				"outside sandbox: /dev/null",
			);
		});

		it("use-case — exemption does not swallow later real writes", () => {
			assert.equal(
				mod.findUnsafeWriteInBash("echo x > /dev/null; echo y > /etc/z", SB),
				"outside sandbox: /etc/z",
			);
			assert.equal(mod.findUnsafeWriteInBash(`echo x > /dev/null && echo y > ${SB}/ok`, SB), null);
		});

		it("use-case — cd is not a content sink: /dev/null target stays blocked", () => {
			assert.equal(mod.findUnsafeCd("cd /dev/null", SB), "/dev/null");
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Phase 2: Exemption is not an escape primitive
	// ═════════════════════════════════════════════════════════════════

	describe("Phase 2: exemption is exact-match, not a prefix grant", () => {
		it("use-case — /dev/nullable is not a prefix match", () => {
			assert.equal(
				mod.findUnsafeWriteInBash("echo hi > /dev/nullable", SB),
				"outside sandbox: /dev/nullable",
			);
		});

		it("use-case — /dev/null/../etc/passwd resolves outside and stays blocked", () => {
			assert.equal(
				mod.findUnsafeWriteInBash("echo hi > /dev/null/../etc/passwd", SB),
				"outside sandbox: /dev/null/../etc/passwd",
			);
		});

		it("use-case — non-enumerated devices stay blocked", () => {
			for (const dev of ["/dev/sda", "/dev/mem", "/dev/kmem", "/dev/port", "/dev/kmsg", "/dev/zero"]) {
				assert.equal(
					mod.findUnsafeWriteInBash(`echo hi > ${dev}`, SB),
					`outside sandbox: ${dev}`,
				);
			}
		});

		it("use-case — fd-alias devices stay blocked (deliberate)", () => {
			for (const dev of ["/dev/stdout", "/dev/stderr", "/dev/fd/1"]) {
				assert.equal(
					mod.findUnsafeWriteInBash(`echo hi > ${dev}`, SB),
					`outside sandbox: ${dev}`,
				);
			}
		});

		it("entity — negative direct predicate", () => {
			assert.equal(tokenHelpers.isPathSafe("/dev/nullable", SB), false);
			assert.equal(tokenHelpers.isPathSafe("/dev/sda", SB), false);
			assert.equal(tokenHelpers.isSideEffectFreeDevice("/dev/nullable"), false);
			assert.equal(tokenHelpers.isSideEffectFreeDevice("/dev/sda"), false);
			assert.equal(tokenHelpers.isSideEffectFreeDevice("/dev/stdout"), false);
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Phase 3: Preserved behavior, scope, and API surface
	// ═════════════════════════════════════════════════════════════════

	describe("Phase 3: preserved behavior, scope, API surface", () => {
		it("use-case — real outside writes unchanged", () => {
			assert.equal(
				mod.findUnsafeWriteInBash("echo x > /etc/passwd", SB),
				"outside sandbox: /etc/passwd",
			);
			assert.equal(
				mod.findUnsafeWriteInBash(`echo x > ${SB}/../../etc/passwd`, SB),
				`outside sandbox: ${SB}/../../etc/passwd`,
			);
		});

		it("entity — containment primitive stays pure", () => {
			assert.equal(tokenHelpers.isPathWithinSandbox("/dev/null", SB), false);
		});

		it("use-case — device exemption scoped out of tool paths", () => {
			for (const tool of ["write", "edit", "read"] as const) {
				const event = { input: { path: "/dev/null" } };
				const ctx = makeCtx({ hasUI: false });
				const result = mod.rewritePath(tool, event, SB, ctx, "writes");
				assert.ok(result !== undefined, `expected block for ${tool}`);
				assert.equal(result.block, true);
				assert.ok(
					(result.reason ?? "").includes("outside the worktree"),
					`expected reason to mention worktree for ${tool}`,
				);
			}
		});

		it("entity — barrel surface unchanged", () => {
			assert.equal("isPathSafe" in mod, false);
			assert.equal("isPathWithinSandbox" in mod, false);
			assert.equal("SIDE_EFFECT_FREE_DEVICES" in mod, false);
			assert.equal("isSideEffectFreeDevice" in mod, false);
		});

		it("structural — stale .fixcheck duplicates deleted", () => {
			const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
			assert.equal(existsSync(join(extDir, ".fixcheck", "meaningful-token.ts")), false);
			assert.equal(existsSync(join(extDir, ".fixcheck", "unsafe-write.ts")), false);
		});

		it("e2e — harness reproduction: npm install 2>/dev/null is not blocked", async () => {
			const sandboxDir = mkdtempSync(join(tmpdir(), "dev-null-redirect-"));
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "npm install 2>/dev/null" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });

			const result = await withSandboxEnv(ENV_KEY, sandboxDir, () => handler(event, ctx));

			assert.equal(result, undefined);
			assert.equal(event.input.command, `cd "${sandboxDir}" && npm install 2>/dev/null`);
		});

		it("e2e — harness negative: echo hi > /etc/evil is blocked", async () => {
			const sandboxDir = mkdtempSync(join(tmpdir(), "dev-null-redirect-"));
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "echo hi > /etc/evil" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });

			const result = await withSandboxEnv(ENV_KEY, sandboxDir, () => handler(event, ctx));

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("outside the worktree"));
		});
	});
});
