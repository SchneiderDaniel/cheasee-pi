// ─── Write-command grammars ─────────────────────────────────────
// Declarative operand/option tables for the write-detector: which operand is a
// destination and which options consume a value. Split out of unsafe-write.ts
// (issue #2033); the policy entry point stays findUnsafeWriteInBash.

/**
 * Declarative write grammar for commands whose file operands are not all
 * destinations in the same position.
 *
 * - `operands: "all"`  → every non-flag operand is a write target (tee, touch)
 * - `operands: "last"` → only the final operand is a destination (cp, mv, install)
 * - `targetDirectoryOptions` → option whose value is the destination directory
 *   (`-t DIR`, `-tDIR`, `--target-directory=DIR`)
 * - `valueOptions` → option whose following token is a value, not a path
 *   (prevents false blocks such as `touch -r /etc/hosts ok.txt`)
 * - `contentSink` → every operand is a pure byte sink, so a side-effect-free
 *   device (`/dev/null`) is a legal destination. True only for `tee`, whose
 *   destination open neither unlinks nor renames a directory entry. `cp` is
 *   excluded even though it usually only truncates: `--remove-destination`
 *   unlinks the destination before opening it, and `-b`/`--backup`/`--suffix`
 *   rename it — so it is not side-effect-free for `/dev/null`.
 */
export type WriteGrammar = {
	operands: "all" | "last";
	contentSink?: true;
	targetDirectoryOptions?: readonly string[];
	valueOptions?: readonly string[];
};

export const WRITE_COMMAND_GRAMMARS: Record<string, WriteGrammar> = {
	cp: {
		operands: "last",
		targetDirectoryOptions: ["-t", "--target-directory"],
		valueOptions: ["-S", "--suffix"],
	},
	mv: {
		operands: "last",
		targetDirectoryOptions: ["-t", "--target-directory"],
		valueOptions: ["-S", "--suffix"],
	},
	install: {
		operands: "last",
		targetDirectoryOptions: ["-t", "--target-directory"],
		valueOptions: ["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"],
	},
	tee: { operands: "all", contentSink: true }, // -a/-i/-p/--output-error take no separate value
	touch: { operands: "all", valueOptions: ["-d", "-r", "-t", "--date", "--reference", "--time"] },
};

// Hard-link `ln` (no `-s`) is single-destination like `cp`: the last operand.
export const LN_HARD_LINK_GRAMMAR: WriteGrammar = { operands: "last" };
