import { describe, it, before, after } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import {
	makeMockPi,
	withSandboxEnv,
	makeToolCallEvent,
	makeCtx as makeHelperCtx,
} from "./helpers.ts";

let mod: {
	default: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;
	rewritePath: (
		toolName: "read" | "write" | "edit",
		event: { input: { path: string } },
		sandboxRoot: string,
		ctx: {
			hasUI: boolean;
			ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		},
		blockNoun: "file operations" | "writes" | "edits",
	) => import("@earendil-works/pi-coding-agent").ToolCallEventResult | undefined;
	findUnsafeCd: (command: string, sandboxRoot: string) => string | null;
	findUnsafeWriteInBash: (command: string, sandboxRoot: string) => string | null;
	hasShellExpansion: (token: string) => boolean;
};

let SANDBOX_ROOT: string;

function makeEvent(path: string): { input: { path: string } } {
	return { input: { path } };
}

function makeCtx(hasUI: boolean): {
	hasUI: boolean;
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
} {
	const notifications: { msg: string; level?: string }[] = [];
	const ctx = {
		hasUI,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ msg: message, level: type });
			},
		},
		// Expose collected notifications for assertion
		_notifications: notifications,
	} as {
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		_notifications: { msg: string; level?: string }[];
	};
	return ctx;
}

describe("hasShellExpansion", () => {
	before(async () => {
		mod = await import("../index.ts");
	});

	it("returns true for variable expansion $VAR", () => {
		assert.equal(mod.hasShellExpansion("$HOME"), true);
	});

	it("returns true for variable expansion ${VAR}", () => {
		assert.equal(mod.hasShellExpansion("${HOME}"), true);
	});

	it("returns true for command substitution $()", () => {
		assert.equal(mod.hasShellExpansion("$(id)"), true);
	});

	it("returns true for backtick command substitution", () => {
		assert.equal(mod.hasShellExpansion("`id`"), true);
	});

	it("returns true for wildcard glob *", () => {
		assert.equal(mod.hasShellExpansion("*.txt"), true);
	});

	it("returns true for wildcard glob ?", () => {
		assert.equal(mod.hasShellExpansion("file?.txt"), true);
	});

	it("returns true for wildcard glob [...]", () => {
		assert.equal(mod.hasShellExpansion("file[0-9].txt"), true);
	});

	it("returns true for single quotes", () => {
		assert.equal(mod.hasShellExpansion("'test'"), true);
	});

	it("returns true for double quotes", () => {
		assert.equal(mod.hasShellExpansion('"test"'), true);
	});

	it("returns true for semicolon command chaining", () => {
		assert.equal(mod.hasShellExpansion("dir;ls"), true);
	});

	it("returns true for pipe", () => {
		assert.equal(mod.hasShellExpansion("dir|ls"), true);
	});

	it("returns true for OR operator ||", () => {
		assert.equal(mod.hasShellExpansion("false||true"), true);
	});

	it("returns true for AND operator &&", () => {
		assert.equal(mod.hasShellExpansion("true&&false"), true);
	});

	it("returns true for background operator &", () => {
		assert.equal(mod.hasShellExpansion("sleep 10&"), true);
	});

	it("returns false for plain path without shell metacharacters", () => {
		assert.equal(mod.hasShellExpansion("/home/user/file.txt"), false);
	});

	it("returns false for hyphen flags", () => {
		assert.equal(mod.hasShellExpansion("--help"), false);
	});

	it("returns false for numeric", () => {
		assert.equal(mod.hasShellExpansion("42"), false);
	});
});
describe("findUnsafeWriteInBash", () => {
	before(async () => {
		mod = await import("../index.ts");
	});

	const SANDBOX = "/home/user/project";

	it("returns null for a simple cd (no write)", () => {
		assert.equal(mod.findUnsafeWriteInBash(`cd ${SANDBOX}`, SANDBOX), null);
	});

	it("returns null for a no-op redirect that stays inside", () => {
		assert.equal(mod.findUnsafeWriteInBash(`echo hello > ${SANDBOX}/file.txt`, SANDBOX), null);
	});

	it("returns reason for redirect to outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("echo data > /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns reason for append redirect to outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("echo more >> /etc/passwd", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns reason for heredoc write to outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("cat << EOF > /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for heredoc write inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`cat << EOF > ${SANDBOX}/data.txt`, SANDBOX), null);
	});

	it("returns reason for cp destination outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(`cp ${SANDBOX}/a.txt /etc/out`, SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for cp inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`cp ${SANDBOX}/a.txt ${SANDBOX}/b.txt`, SANDBOX), null);
	});

	it("returns reason for mv destination outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(`mv ${SANDBOX}/a.txt /tmp/out`, SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for mv inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`mv ${SANDBOX}/a.txt ${SANDBOX}/b.txt`, SANDBOX), null);
	});

	it("returns reason for touch outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("touch /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for touch inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`touch ${SANDBOX}/newfile.txt`, SANDBOX), null);
	});

	it("returns null for tee inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`echo data | tee ${SANDBOX}/log.txt`, SANDBOX), null);
	});

	it("returns reason for tee outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("echo data | tee /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns reason for tee first arg outside sandbox (multi-operand escape)", () => {
		const result = mod.findUnsafeWriteInBash(
			"echo data | tee /etc/outside.txt backup.txt",
			SANDBOX,
		);
		assert.equal(result, "outside sandbox: /etc/outside.txt");
	});

	it("returns reason for tee middle arg outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(
			`echo data | tee ${SANDBOX}/a.txt /etc/outside.txt ${SANDBOX}/b.txt`,
			SANDBOX,
		);
		assert.equal(result, "outside sandbox: /etc/outside.txt");
	});

	it("returns reason for touch first arg outside sandbox (multi-operand escape)", () => {
		const result = mod.findUnsafeWriteInBash("touch /etc/outside.txt ok.txt", SANDBOX);
		assert.equal(result, "outside sandbox: /etc/outside.txt");
	});

	it("returns null for touch reference file outside sandbox (value option, not a target)", () => {
		assert.equal(mod.findUnsafeWriteInBash("touch -r /etc/hosts ok.txt", SANDBOX), null);
	});

	it("returns reason for cp target-directory option outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("cp -t /etc/out a b", SANDBOX);
		assert.equal(result, "outside sandbox: /etc/out");
	});

	it("returns reason for bundled -t target-directory outside sandbox", () => {
		assert.equal(
			mod.findUnsafeWriteInBash("cp -at /etc/out src", SANDBOX),
			"outside sandbox: /etc/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("mv -bt /etc/out a", SANDBOX),
			"outside sandbox: /etc/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("install -at /etc/out src", SANDBOX),
			"outside sandbox: /etc/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("cp -at/etc/out src", SANDBOX),
			"outside sandbox: /etc/out",
		);
	});

	it("returns null for bundled -t target-directory inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`cp -at ${SANDBOX}/out src`, SANDBOX), null);
		// A value-taking option swallows the bundle remainder, so -St.bak is a
		// suffix value, not a bundled -t.
		assert.equal(mod.findUnsafeWriteInBash(`cp -St.bak a ${SANDBOX}/b`, SANDBOX), null);
	});

	it("returns reason for install -t target-directory outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("install -t /etc/out src", SANDBOX);
		assert.equal(result, "outside sandbox: /etc/out");
	});

	it("returns reason for glob operands outside sandbox (fail closed, not dropped)", () => {
		// shell-quote parses `/etc/*` as a glob token; dropping it would let the
		// command through, so the pattern itself is treated as a target.
		assert.equal(mod.findUnsafeWriteInBash("echo data | tee /etc/* safe.txt", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("touch /etc/* ok.txt", SANDBOX), "/etc/*");
		assert.equal(
			mod.findUnsafeWriteInBash(`echo data | tee ${SANDBOX}/a /etc/* ${SANDBOX}/b`, SANDBOX),
			"/etc/*",
		);
	});

	it("returns reason for glob target-directory values outside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash("cp -t /etc/* src", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("cp --target-directory=/etc/* src", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("cp -t/etc/* src", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("mv -t /etc/* a", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("install -t /etc/* src", SANDBOX), "/etc/*");
	});

	it("returns reason for glob value-option tokens outside sandbox (fail closed)", () => {
		// A glob in an option-value slot expands to several words, and every
		// word after the first lands in operand position (`touch -r /etc/* ok.txt`
		// becomes `touch -r /etc/a /etc/b ok.txt`) — an outside write target the
		// sandbox never sees if the value is trusted. Fail closed on the value.
		assert.equal(mod.findUnsafeWriteInBash("touch -r /etc/* ok.txt", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("touch -r /etc/[ab] ok.txt", SANDBOX), "/etc/[ab]");
		assert.equal(mod.findUnsafeWriteInBash("touch -r/etc/* ok.txt", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("touch -mr /etc/* ok.txt", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("touch --reference=/etc/* ok.txt", SANDBOX), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("touch -d /etc/* ok.txt", SANDBOX), "/etc/*");
	});

	it("returns null for expansion-free value options", () => {
		assert.equal(mod.findUnsafeWriteInBash("touch -r /etc/hosts ok.txt", SANDBOX), null);
		assert.equal(mod.findUnsafeWriteInBash("touch --reference /etc/hosts ok.txt", SANDBOX), null);
		assert.equal(mod.findUnsafeWriteInBash("touch -mr /etc/hosts ok.txt", SANDBOX), null);
		assert.equal(mod.findUnsafeWriteInBash(`touch -d 2020-01-01 ${SANDBOX}/f`, SANDBOX), null);
		assert.equal(mod.findUnsafeWriteInBash(`cp -S .bak a ${SANDBOX}/b`, SANDBOX), null);
	});

	it("returns reason for shell expansion attached to an option token", () => {
		// shell-quote resolves an unresolved variable to "" and, when it is
		// attached to a word, drops the `$` entirely (`cp -t$OUT src` →
		// ["cp","-t","src"]), so the option value vanished before the detector
		// could check it. The write detector tokenizes with expansion provenance,
		// keeps the `$` on the token, and fails closed on the command.
		for (const command of [
			"cp -t$OUT src",
			"cp -at$OUT src",
			"mv -t$OUT src",
			"install -t$OUT src",
			'cp -t"$OUT" src',
			"cp -t${OUT} src",
			"touch -r$REF ok.txt",
			"touch -mr$REF ok.txt",
		]) {
			assert.equal(mod.findUnsafeWriteInBash(command, SANDBOX), command, command);
		}
	});

	it("returns reason for attached expansion in dd of=", () => {
		const command = "dd of=$OUT if=/dev/zero";
		assert.equal(mod.findUnsafeWriteInBash(command, SANDBOX), command);
	});

	it("returns reason when the command word itself is built by expansion", () => {
		// `c$X -t /out src` runs `cp -t /out src` — the shell picks the command
		// word, so no write grammar can be matched against the token. Fail closed.
		assert.equal(mod.findUnsafeWriteInBash("c$X -t /etc/out src", SANDBOX), "c$X -t /etc/out src");
		assert.equal(
			mod.findUnsafeWriteInBash("$(which tee) /etc/out", SANDBOX),
			"$(which tee) /etc/out",
		);
	});

	it("returns null for the `[` test command (not an expansion)", () => {
		assert.equal(mod.findUnsafeWriteInBash("[ -f x ]", SANDBOX), null);
	});

	it("keeps bare unresolved variables fail-closed (command as reason)", () => {
		for (const command of ["cp a $DEST", "echo hi | tee $DEST backup.txt", "echo x > $OUT"]) {
			assert.equal(mod.findUnsafeWriteInBash(command, SANDBOX), command, command);
		}
	});

	it("returns reason for dd of outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(
			"dd if=/dev/zero of=/etc/outside.txt bs=1 count=1",
			SANDBOX,
		);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for dd inside sandbox", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`dd if=/dev/zero of=${SANDBOX}/test.bin bs=1 count=1`, SANDBOX),
			null,
		);
	});

	it("returns reason for install outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("install -m 755 file /usr/local/bin/prog", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for install inside sandbox", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`install -m 755 ${SANDBOX}/file ${SANDBOX}/bin/prog`, SANDBOX),
			null,
		);
	});

	it("returns reason for ln -s target outside sandbox (symlink escape)", () => {
		const result = mod.findUnsafeWriteInBash(`ln -s /etc/passwd ${SANDBOX}/link`, SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns reason for ln -s link name outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(`ln -s ${SANDBOX}/a.txt /etc/evil-link`, SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for ln -s inside sandbox", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s ${SANDBOX}/a.txt ${SANDBOX}/link`, SANDBOX),
			null,
		);
	});

	it("returns null for ln without -s (hard link)", () => {
		assert.equal(mod.findUnsafeWriteInBash(`ln ${SANDBOX}/a.txt ${SANDBOX}/b.txt`, SANDBOX), null);
	});
});
describe("findUnsafeWriteInBash via bash handler (integration)", () => {
	let handler: Function;
	let sandboxDir: string;

	before(async () => {
		// Real temp dir — getSandboxRoot() requires existsSync()
		sandboxDir = mkdtempSync(join(tmpdir(), "sandbox-ln-int-test-"));

		const mod2 = await import("../index.ts");
		const pi = makeMockPi();
		mod2.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
		handler = pi.handlers.get("tool_call")!;
	});

	after(() => {
		try {
			rmSync(sandboxDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("blocks ln -s with link name outside sandbox", async () => {
		await withSandboxEnv("WORKTREE_SANDBOX_PATH", sandboxDir, async () => {
			const event = makeToolCallEvent("bash", {
				command: `ln -s ${sandboxDir}/a.txt /etc/evil-link`,
			});
			const ctx = makeHelperCtx({ hasUI: false, mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined, "handler should return a block result");
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("outside the worktree"));
		});
	});

	it("allows ln -s inside sandbox (rewrites command with cd prefix)", async () => {
		await withSandboxEnv("WORKTREE_SANDBOX_PATH", sandboxDir, async () => {
			const event = makeToolCallEvent("bash", {
				command: `ln -s ${sandboxDir}/a.txt ${sandboxDir}/link`,
			});
			const ctx = makeHelperCtx({ hasUI: false, mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
			assert.equal(
				event.input.command,
				`cd "${sandboxDir}" && ln -s ${sandboxDir}/a.txt ${sandboxDir}/link`,
			);
		});
	});
});
