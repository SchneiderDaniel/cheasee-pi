// ─── Unsafe-write grammars: per-command checkers ─────────────────
// Split out of unsafe-write.ts (issue #2033). The end-to-end matrix lives in
// `worktree-sandbox.test.mts`; this suite pins the seams the split created so a
// grammar regression names the module it came from.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ParseEntry } from "shell-quote";
import { checkDd } from "../unsafe-write-dd.ts";
import { checkLn } from "../unsafe-write-ln.ts";
import { checkRedirect } from "../unsafe-write-commands.ts";
import { flagTargets } from "../unsafe-write-flags.ts";
import { collectWriteTargets } from "../unsafe-write-targets.ts";
import { WRITE_COMMAND_GRAMMARS } from "../unsafe-write-grammars.ts";

const SANDBOX = "/tmp/unsafe-write-test";

describe("checkRedirect", () => {
	it("passes a /dev/null sink and an in-sandbox file", () => {
		const tokens = [{ op: ">" }, "/dev/null"] as unknown as ParseEntry[];
		assert.equal(checkRedirect(tokens, 0, "cmd", SANDBOX), null);
		const inner = [{ op: ">" }, join(SANDBOX, "out.txt")] as unknown as ParseEntry[];
		assert.equal(checkRedirect(inner, 0, "cmd", SANDBOX), null);
	});

	it("blocks a redirect outside the sandbox with the reason string", () => {
		const tokens = [{ op: ">" }, "/etc/passwd"] as unknown as ParseEntry[];
		assert.equal(checkRedirect(tokens, 0, "cmd", SANDBOX), "outside sandbox: /etc/passwd");
	});
});

describe("checkDd", () => {
	it("passes of= inside the sandbox and a /dev/null sink", () => {
		const inner = ["dd", `of=${join(SANDBOX, "img")}`] as unknown as ParseEntry[];
		assert.equal(checkDd(inner, 0, "cmd", SANDBOX), null);
		const nullSink = ["dd", "of=/dev/null"] as unknown as ParseEntry[];
		assert.equal(checkDd(nullSink, 0, "cmd", SANDBOX), null);
	});

	it("blocks of= outside the sandbox", () => {
		const tokens = ["dd", "of=/etc/passwd"] as unknown as ParseEntry[];
		assert.equal(checkDd(tokens, 0, "cmd", SANDBOX), "outside sandbox: /etc/passwd");
	});
});

describe("checkLn", () => {
	it("passes a symlink whose target stays inside the sandbox", () => {
		const tokens = [
			"ln",
			"-s",
			join(SANDBOX, "target"),
			join(SANDBOX, "link"),
		] as unknown as ParseEntry[];
		assert.equal(checkLn(tokens, 0, "cmd", SANDBOX), null);
	});

	it("blocks a symlink pointing outside the sandbox, -s and -sf alike", () => {
		for (const flag of ["-s", "-sf"]) {
			const tokens = ["ln", flag, "/etc/passwd", join(SANDBOX, "link")] as unknown as ParseEntry[];
			assert.equal(checkLn(tokens, 0, "cmd", SANDBOX), "outside sandbox: /etc/passwd");
		}
	});

	it("blocks a hard-link destination outside the sandbox", () => {
		const tokens = ["ln", join(SANDBOX, "a"), "/etc/passwd"] as unknown as ParseEntry[];
		assert.equal(checkLn(tokens, 0, "cmd", SANDBOX), "outside sandbox: /etc/passwd");
	});
});

describe("write-target collection + flagTargets", () => {
	it("collects glob patterns and skips non-separator operators", () => {
		const cp = WRITE_COMMAND_GRAMMARS["cp"]!;
		const tokens = [
			"cp",
			{ op: ">" },
			{ op: "glob", pattern: "/etc/*" },
		] as unknown as ParseEntry[];
		assert.deepEqual(collectWriteTargets(tokens, 1, cp), ["/etc/*"]);
	});

	it("separate option values consume the next token, attached ones do not", () => {
		const cp = WRITE_COMMAND_GRAMMARS["cp"]!;
		assert.deepEqual(flagTargets("-t", "/out", cp), { targets: ["/out"], consumesNext: true });
		assert.deepEqual(flagTargets("--target-directory=/out", null, cp), {
			targets: ["/out"],
			consumesNext: false,
		});
		assert.deepEqual(flagTargets("-S", ".bak", cp), { targets: [], consumesNext: true });
	});

	it("a short bundle takes the attached remainder or the next token", () => {
		const cp = WRITE_COMMAND_GRAMMARS["cp"]!;
		assert.deepEqual(flagTargets("-t/out", null, cp), { targets: ["/out"], consumesNext: false });
		assert.deepEqual(flagTargets("-at", "/out", cp), { targets: ["/out"], consumesNext: true });
	});
});
