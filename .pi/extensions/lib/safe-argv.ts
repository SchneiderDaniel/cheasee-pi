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

export interface ArgvCommand {
	readonly program: string;
	readonly args: readonly string[];
}

function fail(field: string, reason: string): never {
	throw new UnsafeArgvError(field, reason);
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
export function assertSafeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	for (const key of Object.keys(env)) {
		if (NUL.test(key)) fail(`env.${key}`, "must not contain NUL");
		const value = env[key];
		if (typeof value === "string" && NUL.test(value)) {
			fail(`env.${key}`, "must not contain NUL");
		}
	}
	return env;
}
