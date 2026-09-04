/**
 * Characterization: byte-identical detector decisions after the file split.
 *
 * Pins the public API surface of ../index.ts (the re-export barrel contract)
 * and the exact reason strings / branch priority of the detectors, so the
 * vertical split of index.ts into meaningful-token.ts / unsafe-write.ts /
 * unsafe-cd.ts cannot silently change any decision.
 *
 * All expected values below derive from the pre-split implementation.
 * SB = "/home/user/project" is a fixed sandbox root (no FS access needed —
 * all assertions are pure string comparisons).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ParseEntry } from "shell-quote";
import * as mod from "../index.ts";

const SB = "/home/user/project";

describe("byte-identical: public API surface (index.ts barrel)", () => {
	it("exposes all 9 documented exports, callable", () => {
		assert.equal(typeof mod.findMeaningfulToken, "function");
		assert.equal(typeof mod.findUnsafeWriteInBash, "function");
		assert.equal(typeof mod.findUnsafeCd, "function");
		assert.equal(typeof mod.hasShellExpansion, "function");
		assert.equal(typeof mod.tokenizeCommand, "function");
		assert.ok(mod.SEPARATORS instanceof Set);
		assert.equal(typeof mod.isCommandStart, "function");
		assert.equal(typeof mod.rewritePath, "function");
		assert.equal(typeof mod.default, "function");
	});

	it("does not re-export removed dead code (findSuspiciousArg)", () => {
		assert.equal("findSuspiciousArg" in mod, false);
	});

	it("keeps internal helpers module-private (not re-exported)", () => {
		assert.equal("checkWriteDest" in mod, false);
		assert.equal("checkWriteToken" in mod, false);
		assert.equal("findRawCdExpansion" in mod, false);
	});
});

describe("byte-identical: findMeaningfulToken discriminants", () => {
	it("returns all five discriminants unchanged", () => {
		assert.deepEqual(mod.findMeaningfulToken(["echo", "hi"], 0), {
			kind: "token",
			value: "echo",
			index: 0,
		});
		assert.deepEqual(mod.findMeaningfulToken(["cmd", { op: "glob", pattern: "*.txt" }], 1), {
			kind: "glob",
			pattern: "*.txt",
			index: 1,
		});
		assert.deepEqual(mod.findMeaningfulToken(["echo", "hi", { op: "&&" }], 2), {
			kind: "separator",
			op: "&&",
			index: 2,
		});
		assert.deepEqual(mod.findMeaningfulToken(["echo", { comment: "note" }], 1), {
			kind: "comment",
			index: 1,
		});
		assert.deepEqual(mod.findMeaningfulToken([], 0), { kind: "exhausted" });
	});

	it("skips non-separator operators mid-scan", () => {
		assert.deepEqual(mod.findMeaningfulToken(["echo", "hi", { op: ">" }, "out"], 2), {
			kind: "token",
			value: "out",
			index: 3,
		});
	});
});

describe("byte-identical: isCommandStart + SEPARATORS", () => {
	const tokens = mod.tokenizeCommand("echo a | cat && ls; grep x |& sort & echo b");

	it("index 0 starts a command; true after every separator", () => {
		assert.equal(mod.isCommandStart(tokens, 0), true);
		// Every token that directly follows a separator op starts a command.
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i]!;
			if (typeof t === "object" && "op" in t && mod.SEPARATORS.has(t.op)) {
				assert.equal(
					mod.isCommandStart(tokens, i + 1),
					true,
					`token after separator ${t.op} (index ${i})`,
				);
			}
		}
	});

	it("false after a glob (not a separator)", () => {
		const t: ParseEntry[] = ["cmd", { op: "glob", pattern: "*.ts" }, "arg"];
		assert.equal(mod.isCommandStart(t, 2), false);
	});

	it("SEPARATORS contains the 7 separators and nothing else relevant", () => {
		for (const op of ["|", "||", "|&", ";", ";;", "&&", "&"]) {
			assert.ok(mod.SEPARATORS.has(op), `missing ${op}`);
		}
		assert.equal(mod.SEPARATORS.has(">"), false);
		assert.equal(mod.SEPARATORS.has(">>"), false);
		assert.equal(mod.SEPARATORS.has("glob"), false);
		assert.equal(mod.SEPARATORS.size, 7);
	});
});

describe("byte-identical: hasShellExpansion", () => {
	it("hasShellExpansion unchanged", () => {
		assert.equal(mod.hasShellExpansion("$HOME/x"), true);
		assert.equal(mod.hasShellExpansion("/plain/path"), false);
	});
});

describe("byte-identical: findUnsafeWriteInBash reason strings per branch", () => {
	it("redirect branch (>, >>)", () => {
		assert.equal(
			mod.findUnsafeWriteInBash("echo data > /etc/outside.txt", SB),
			"outside sandbox: /etc/outside.txt",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("echo more >> /etc/passwd", SB),
			"outside sandbox: /etc/passwd",
		);
	});

	it("cp/mv/touch/tee/install branch", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`cp ${SB}/a.txt /etc/out`, SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash(`mv ${SB}/a.txt /tmp/out`, SB),
			"outside sandbox: /tmp/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("touch /etc/outside.txt", SB),
			"outside sandbox: /etc/outside.txt",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("echo data | tee /etc/outside.txt", SB),
			"outside sandbox: /etc/outside.txt",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("install -m 755 file /usr/local/bin/prog", SB),
			"outside sandbox: /usr/local/bin/prog",
		);
	});

	it("ln branch (symlink target checked)", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s /etc/passwd ${SB}/link`, SB),
			"outside sandbox: /etc/passwd",
		);
	});

	it("dd branch (of=)", () => {
		assert.equal(
			mod.findUnsafeWriteInBash("dd if=/dev/zero of=/etc/outside.txt bs=1 count=1", SB),
			"outside sandbox: /etc/outside.txt",
		);
	});

	it("detector priority: first detector that fires wins (left-to-right)", () => {
		assert.equal(
			mod.findUnsafeWriteInBash("echo x > /etc/a && cp y /etc/b", SB),
			"outside sandbox: /etc/a",
		); // redirect before cp
		assert.equal(
			mod.findUnsafeWriteInBash("cp y /etc/b && ln -s /etc/passwd L", SB),
			"outside sandbox: /etc/b",
		); // cp before ln
		assert.equal(
			mod.findUnsafeWriteInBash("ln -s /etc/passwd L && cp y /etc/b", SB),
			"outside sandbox: /etc/passwd",
		); // ln before cp
		assert.equal(
			mod.findUnsafeWriteInBash("dd of=/etc/a if=/dev/zero && echo x > /etc/b", SB),
			"outside sandbox: /etc/a",
		); // dd before redirect
		assert.equal(
			mod.findUnsafeWriteInBash("cp y /etc/b && dd of=/etc/a if=/dev/zero", SB),
			"outside sandbox: /etc/b",
		); // cp before dd
	});

	it("`>` is not a SEPARATOR, so scan continues past it (checkWriteDest pins)", () => {
		assert.equal(mod.findUnsafeWriteInBash("touch /etc/x > /etc/y", SB), "outside sandbox: /etc/y");
	});

	it("boundaries: null for safe/empty input", () => {
		assert.equal(mod.findUnsafeWriteInBash("", SB), null);
		assert.equal(mod.findUnsafeWriteInBash("echo hi", SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`ln /etc/passwd ${SB}/link`, SB), null); // hard link: dest only
		assert.equal(mod.findUnsafeWriteInBash(`echo x > ${SB}/ok.txt`, SB), null);
	});

	it("env-resolved empty token still followed by detected target", () => {
		assert.equal(
			mod.findUnsafeWriteInBash("echo $UNSET_VAR > /tmp/x", SB),
			"outside sandbox: /tmp/x",
		);
	});

	it("absolute paths with .. that escape sandbox are blocked (traversal)", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`echo x > ${SB}/../../../../etc/passwd`, SB),
			`outside sandbox: ${SB}/../../../../etc/passwd`,
		);
		assert.equal(
			mod.findUnsafeWriteInBash(`cp a ${SB}/../../../tmp/out`, SB),
			`outside sandbox: ${SB}/../../../tmp/out`,
		);
	});

	it("in-sandbox .. targets stay null (not over-blocked)", () => {
		assert.equal(mod.findUnsafeWriteInBash(`touch ${SB}/sub/../new.txt`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`echo x > ${SB}/sub/../out.txt`, SB), null);
	});

	it("all inside-sandbox variants pass", () => {
		assert.equal(mod.findUnsafeWriteInBash(`echo x > ${SB}/out.txt`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`cp ${SB}/a.txt ${SB}/b.txt`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`mv ${SB}/a.txt ${SB}/b.txt`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`touch ${SB}/new.txt`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`echo x | tee ${SB}/out.txt`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`install -m 755 f ${SB}/bin`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`dd if=/dev/zero of=${SB}/out bs=1 count=1`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`ln -s ${SB}/target ${SB}/link`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`ln ${SB}/a ${SB}/b`, SB), null);
	});
});

describe("byte-identical: findUnsafeCd raw-scan strings (co-location guard)", () => {
	it("pins exact raw-scan returns that shell-quote parse() would destroy", () => {
		assert.equal(mod.findUnsafeCd("cd $HOME", SB), "$HOME");
		assert.equal(mod.findUnsafeCd('cd "$HOME"', SB), '"$HOME"');
		assert.equal(mod.findUnsafeCd("cd ~", SB), "~");
		assert.equal(mod.findUnsafeCd("cd ~/subdir", SB), "~/subdir");
		assert.equal(mod.findUnsafeCd("cd ~otheruser", SB), "~otheruser");
		assert.equal(mod.findUnsafeCd("cd $(echo /etc)", SB), "$(echo");
		assert.equal(mod.findUnsafeCd("cd `echo /etc`", SB), "`echo");
		assert.equal(mod.findUnsafeCd("cd \\$HOME", SB), "\\$HOME");
		assert.equal(mod.findUnsafeCd("cd", SB), "<HOME>");
		assert.equal(mod.findUnsafeCd("cd -", SB), "<previous-dir>");
		assert.equal(mod.findUnsafeCd("cd -- /etc", SB), "/etc");
		assert.equal(mod.findUnsafeCd("echo | cd /etc", SB), "/etc");
	});
});
