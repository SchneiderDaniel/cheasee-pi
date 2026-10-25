/**
 * argv-safety invariant for extension child-process spawns.
 *
 * The CodeFlow-flagged sites all spawn with an argv array (no shell), so the
 * real defect is unvalidated arguments, not shell injection. This module is
 * that validation plus a forced `shell:false`, so a caller can never opt a
 * spawn back into a shell. Pure, zero-dependency — the same role
 * path-containment.ts plays for CWE-22.
 */

/** Stable code so callers branch without string-matching the message. */
export class UnsafeArgvError extends Error {
	readonly code = "UNSAFE_ARGV";
	constructor(field: string, reason: string) {
		super(`Unsafe ${field}: ${reason}`);
		this.name = "UnsafeArgvError";
	}
}

/** NUL is the only byte an argv entry or env value cannot carry. */
const NUL = /\u0000/;

/**
 * Interpreters that run a program handed to them through argv (`node -e`,
 * `python -c`, `sh -c`, `perl -e`, `php -r`, …). Kept in sync with the
 * CodeFlow fp-filter's `INTERPRETER_PROGRAM`. The regex is tested against the
 * bare program name (no quotes, no directory).
 */
const INTERPRETER_PROGRAM =
	/(?:^|[\\/])(?:node|nodejs|deno|bun|python\d*(?:\.\d+)?|perl|ruby|php\d*|lua|luajit|osascript|rscript|pwsh|powershell|cmd|sh|bash|zsh|dash)(?:\.exe)?$/i;
/**
 * An interpreter flag that makes the interpreter execute code from argv:
 * the eval/print forms (`node -e`, `python -c`), the module-loading forms that
 * run a file the flag points at (`node --require`, `--import`, `--loader`,
 * `python -m`), and the attached single-letter forms the interpreters accept
 * (`perl -Mmodule`, `python -mmodule`, `python -cprint(1)`, `sh -cecho x`,
 * `bash -lc cmd`) — including combined short flags where the code letter is not
 * first. The letter class covers every code flag (`c`/`C` for Python and the
 * shells, plus `e`/`E`/`m`/`M`/`r`/`R`/`p`/`P`), so an attached or combined
 * form cannot hide the code. A lone `-` (script from stdin) is rejected too.
 * Kept in sync with the CodeFlow fp-filter's `CODE_EVAL_TOKEN`.
 */
const CODE_EVAL_FLAG =
	/^(?:-|eval|\/(?:c|k)|--?(?:eval|exec(?:ute)?|command|c|print|p|e|r|require|import|loader|preload|module|m|experimental-loader)(?:=.*)?|-[a-zA-Z]*[cCeEmMrRpP][\s\S]*)$/i;

export interface ArgvCommand {
	readonly program: string;
	readonly args: readonly string[];
}

function fail(field: string, reason: string): never {
	throw new UnsafeArgvError(field, reason);
}

/**
 * True when `program` is an interpreter and `args` carry its code flag, i.e.
 * the argv runs attacker-supplied code even without a shell (`node -e code`).
 * The static argv-safety proof in the CodeFlow fp-filter relies on this
 * rejection, so the two must agree.
 */
function isInterpreterCodeExecution(program: string, args: readonly string[]): boolean {
	if (!INTERPRETER_PROGRAM.test(program)) return false;
	return args.some((arg) => CODE_EVAL_FLAG.test(arg.trim()));
}

/** Validate a program + argv pair; returns a frozen copy safe to hand to spawn. */
export function argvCommand(program: string, args: readonly string[]): ArgvCommand {
	if (typeof program !== "string") fail("program", "must be a string");
	if (program.trim() === "") fail("program", "must not be blank");
	if (program.startsWith("-")) fail("program", "must not start with '-' (option injection)");
	if (NUL.test(program)) fail("program", "must not contain NUL");
	if (!Array.isArray(args)) fail("args", "must be an array");
	for (const arg of args) {
		if (typeof arg !== "string") fail("arg", "must be a string");
		if (NUL.test(arg)) fail("arg", "must not contain NUL");
	}
	if (isInterpreterCodeExecution(program, args)) {
		fail("args", "must not hand an interpreter its code flag (e.g. `node -e`)");
	}
	return Object.freeze({ program, args: Object.freeze([...args]) });
}

/** Force `shell:false`; throws when a caller asks for a shell. Never mutates input. */
export function assertNoShell<T extends object>(options: T | undefined): T & { shell: false } {
	const opts: object = options ?? {};
	if ((opts as { shell?: unknown }).shell) {
		fail("options.shell", "must be false — argv arrays only, never a shell string");
	}
	return { ...opts, shell: false } as T & { shell: false };
}

/**
 * The single argv-array spawn seam: validate `command`/`args` through the
 * policy and force `shell:false` before the injected `spawnFn` runs, so no
 * caller can reach a real spawn with an unvalidated program or a shell. The
 * `spawnFn` binding is the only thing a caller supplies — the argv is not.
 */
export function spawnArgv(
	spawnFn: (program: string, args: string[], options: object) => unknown,
	command: string,
	args: readonly string[],
	options?: object,
): unknown {
	const { program, args: safeArgs } = argvCommand(command, args);
	return spawnFn(program, [...safeArgs], assertNoShell(options));
}

/** Reject NUL in env keys/values (Node throws ERR_INVALID_ARG_VALUE); other bytes pass. */
export function assertSafeEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	for (const key of Object.keys(env)) {
		if (NUL.test(key)) fail(`env.${key}`, "must not contain NUL");
		const value = env[key];
		if (typeof value === "string" && NUL.test(value)) {
			fail(`env.${key}`, "must not contain NUL");
		}
	}
	return env;
}

/**
 * Variables that make the *environment* name code the argv never shows: node
 * loads a module from `NODE_OPTIONS`, the loader a library from `LD_PRELOAD`,
 * git runs `core.sshCommand` from `GIT_CONFIG_*`/`GIT_SSH_COMMAND`, a shell its
 * startup script from `BASH_ENV`/`ENV`. A spawn that forwards its caller's
 * environment is not argv-safe however clean the argv is, so these are dropped.
 */
const EXECUTION_ENV_KEYS = new Set([
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_REPL_EXTERNAL_MODULE",
	"LD_PRELOAD",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"BASH_ENV",
	"ENV",
	"PS4",
	"PERL5OPT",
	"PERL5LIB",
	"RUBYOPT",
	"RUBYLIB",
	"PYTHONSTARTUP",
	"PYTHONHOME",
	"GCONV_PATH",
	"GLIBC_TUNABLES",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_EXTERNAL_DIFF",
	"GIT_ASKPASS",
	"GIT_PROXY_COMMAND",
	"GIT_PAGER",
	"GIT_EDITOR",
	"GIT_SEQUENCE_EDITOR",
]);

/**
 * The env a child process may receive: the caller's variables minus every
 * execution channel above (and `GIT_CONFIG_*`, whose names carry an index).
 * NUL still throws — that is a malformed env, not a risky one. Windows-style
 * case variants are not honoured on POSIX, so exact names are enough.
 */
export function sanitizeSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
	assertSafeEnv(env);
	const safe: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		if (EXECUTION_ENV_KEYS.has(key) || key.startsWith("GIT_CONFIG_")) continue;
		safe[key] = value;
	}
	return safe;
}
