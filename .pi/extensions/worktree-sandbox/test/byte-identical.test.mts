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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParseEntry } from "shell-quote";
import * as mod from "../index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

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
		assert.equal("collectWriteTargets" in mod, false);
		assert.equal("WRITE_COMMAND_GRAMMARS" in mod, false);
		assert.equal("tokenizeCommandPreservingExpansions" in mod, false);
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

	it('multi-destination operands (tee/touch operands: "all")', () => {
		// The reported escape: only the last operand used to be checked.
		assert.equal(
			mod.findUnsafeWriteInBash("echo hi | tee /etc/outside/file backup.txt", SB),
			"outside sandbox: /etc/outside/file",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("touch /etc/outside/x ok.txt", SB),
			"outside sandbox: /etc/outside/x",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("echo hi | tee /etc/a /etc/b", SB),
			"outside sandbox: /etc/a", // first unsafe target wins
		);
		assert.equal(
			mod.findUnsafeWriteInBash("echo hi | tee -a - /etc/out", SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(mod.findUnsafeWriteInBash("echo hi | tee", SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`touch ${SB}/a ${SB}/b`, SB), null);
	});

	it("option-aware operands (valueOptions + targetDirectoryOptions)", () => {
		// -r value is a reference file, not a write target.
		assert.equal(mod.findUnsafeWriteInBash("touch -r /etc/hosts ok.txt", SB), null);
		assert.equal(
			mod.findUnsafeWriteInBash("touch -r /etc/hosts /etc/out", SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(mod.findUnsafeWriteInBash("cp -t /etc/out a b", SB), "outside sandbox: /etc/out");
		assert.equal(mod.findUnsafeWriteInBash("cp -t/etc/out a", SB), "outside sandbox: /etc/out");
		assert.equal(
			mod.findUnsafeWriteInBash("cp --target-directory=/etc/out a", SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("cp --target-directory /etc/out a", SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(mod.findUnsafeWriteInBash("mv -t /etc/out a", SB), "outside sandbox: /etc/out");
		assert.equal(
			mod.findUnsafeWriteInBash("install -t /etc/out src", SB),
			"outside sandbox: /etc/out",
		);
		// Bundled short options: `-at` is `-a` + `-t`, so its value is still a
		// destination (`-at /etc/out`). A value-taking option swallows the rest
		// of the bundle, so `-St.bak` does NOT bundle a `-t`.
		assert.equal(mod.findUnsafeWriteInBash("cp -at /etc/out src", SB), "outside sandbox: /etc/out");
		assert.equal(
			mod.findUnsafeWriteInBash("cp -at/etc/out src", SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("mv -bt /etc/out a", SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(
			mod.findUnsafeWriteInBash("install -at /etc/out src", SB),
			"outside sandbox: /etc/out",
		);
		assert.equal(mod.findUnsafeWriteInBash(`cp -at ${SB}/out a`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`mv -bt ${SB}/out a`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`install -at ${SB}/out src`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`cp -St.bak a ${SB}/b`, SB), null);
		assert.equal(mod.findUnsafeWriteInBash(`cp -S .bak a ${SB}/b`, SB), null);
		assert.equal(
			mod.findUnsafeWriteInBash(`install -m 755 -o root -g root src ${SB}/dst`, SB),
			null,
		);
	});

	it("glob operands/values fail closed (shell-quote glob tokens not dropped)", () => {
		// shell-quote parses `*`/`?`/`[` words as { op: "glob" }; the pattern is a
		// write target, not a skippable operator, and its metacharacter makes
		// checkWriteToken reject it (same reason shape as the redirect branch).
		assert.equal(mod.findUnsafeWriteInBash("echo hi | tee /etc/* safe.txt", SB), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("touch /etc/* ok.txt", SB), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("cp -t /etc/* src", SB), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("cp --target-directory=/etc/* src", SB), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("cp -t/etc/* src", SB), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("install -t /etc/* src", SB), "/etc/*");
		assert.equal(mod.findUnsafeWriteInBash("mv -t /etc/* a", SB), "/etc/*");
	});

	it("ln branch (symlink target checked)", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s /etc/passwd ${SB}/link`, SB),
			"outside sandbox: /etc/passwd",
		);
	});

	it("ln branch (link name checked — escape vector closed)", () => {
		// Escape vector: link name (the directory entry ln creates) outside sandbox
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s ${SB}/a.txt /etc/evil-link`, SB),
			"outside sandbox: /etc/evil-link",
		);
		// Target-first priority: unsafe target reported before unsafe link name
		assert.equal(
			mod.findUnsafeWriteInBash("ln -s /etc/passwd /etc/evil-link", SB),
			"outside sandbox: /etc/passwd",
		);
		// Single-arg form stays legal (no link name to create)
		assert.equal(mod.findUnsafeWriteInBash(`ln -s ${SB}/a.txt`, SB), null);
		// Single-arg unsafe target still blocked
		assert.equal(
			mod.findUnsafeWriteInBash("ln -s /etc/passwd", SB),
			"outside sandbox: /etc/passwd",
		);
		// Long --symbolic flag
		assert.equal(
			mod.findUnsafeWriteInBash(`ln --symbolic ${SB}/a.txt /etc/evil-link`, SB),
			"outside sandbox: /etc/evil-link",
		);
		// Short-option bundle with s (-sT)
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -sT ${SB}/a.txt /etc/evil-link`, SB),
			"outside sandbox: /etc/evil-link",
		);
		// Short-option bundle with s (-sv) — unsafe target reported first
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -sv /etc/passwd ${SB}/link`, SB),
			"outside sandbox: /etc/passwd",
		);
		// Bundle without s is not symlink mode → hard-link dest (last arg) checked
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -T ${SB}/a /etc/out`, SB),
			"outside sandbox: /etc/out",
		);
		// Unresolved env var in link name resolves to empty → fail closed
		const unsetCmd = `ln -s ${SB}/a.txt $UNSET`;
		assert.equal(mod.findUnsafeWriteInBash(unsetCmd, SB), unsetCmd);
		// Relative link name is safe (cwd pinned by `cd "${sandboxRoot}" &&` prefix)
		assert.equal(mod.findUnsafeWriteInBash(`ln -s ${SB}/a.txt evil-link`, SB), null);
		// Multi-arg form: target + last non-flag validated (intermediate are sources)
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s ${SB}/a.txt ${SB}/b.txt /etc/evil-dir`, SB),
			"outside sandbox: /etc/evil-dir",
		);
		// Flags between options and args don't break the scan
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s -v ${SB}/a.txt /etc/evil-link`, SB),
			"outside sandbox: /etc/evil-link",
		);
		// Separators bound the scan (isCommandStart)
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s ${SB}/a.txt ${SB}/l ; ln -s /etc/passwd ${SB}/l2`, SB),
			"outside sandbox: /etc/passwd",
		);
		// Bare ln -s with no args → no write dest
		assert.equal(mod.findUnsafeWriteInBash("ln -s", SB), null);
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

	it("`>` is not a SEPARATOR, so scan continues past it (operand-scan pins)", () => {
		// Intentional ordering delta: `touch` is multi-destination, so operands
		// are collected in argv order and the first unsafe target is reported.
		assert.equal(mod.findUnsafeWriteInBash("touch /etc/x > /etc/y", SB), "outside sandbox: /etc/x");
		assert.equal(
			mod.findUnsafeWriteInBash("echo hi | tee a >b /etc/out", SB),
			"outside sandbox: /etc/out",
		);
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

	it("shell expansion attached to an option token fails closed", () => {
		// shell-quote collapses an unresolved variable to "" and, when it is
		// attached to a word, drops the `$` (`cp -t$OUT src` → ["cp","-t","src"]).
		// With provenance kept, the option value stays visible and the command
		// fails closed with the same whole-command reason a bare variable gets.
		assert.equal(mod.findUnsafeWriteInBash("cp -t$OUT src", SB), "cp -t$OUT src");
		assert.equal(mod.findUnsafeWriteInBash("cp -at$OUT src", SB), "cp -at$OUT src");
		assert.equal(mod.findUnsafeWriteInBash("install -t$OUT src", SB), "install -t$OUT src");
		assert.equal(mod.findUnsafeWriteInBash("touch -r$REF ok.txt", SB), "touch -r$REF ok.txt");
		assert.equal(mod.findUnsafeWriteInBash("cp a $DEST", SB), "cp a $DEST");
	});

	it("command word built by expansion fails closed", () => {
		// The shell picks the command word at run time, so no write grammar can
		// be matched against the token — block instead of reading it as an
		// unknown (harmless) command.
		assert.equal(mod.findUnsafeWriteInBash("c$X -t /etc/out src", SB), "c$X -t /etc/out src");
		assert.equal(mod.findUnsafeWriteInBash("$(which tee) /etc/out", SB), "$(which tee) /etc/out");
		// A literal `[` (the test command) is not an expansion.
		assert.equal(mod.findUnsafeWriteInBash("[ -f x ]", SB), null);
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

describe("characterization: .fixcheck snapshot stays byte-identical", () => {
	it("unsafe-write.ts matches its .fixcheck snapshot", () => {
		const live = readFileSync(join(HERE, "..", "unsafe-write.ts"), "utf8");
		const snapshot = readFileSync(join(HERE, "..", ".fixcheck", "unsafe-write.ts"), "utf8");
		assert.equal(live, snapshot, "re-sync .fixcheck/unsafe-write.ts with the live detector");
	});

	it("meaningful-token.ts matches its .fixcheck snapshot", () => {
		const live = readFileSync(join(HERE, "..", "meaningful-token.ts"), "utf8");
		const snapshot = readFileSync(join(HERE, "..", ".fixcheck", "meaningful-token.ts"), "utf8");
		assert.equal(live, snapshot, "re-sync .fixcheck/meaningful-token.ts with the live token helpers");
	});
});
