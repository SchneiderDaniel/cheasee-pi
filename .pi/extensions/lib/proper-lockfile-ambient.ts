/**
 * Ambient type declarations for proper-lockfile v4.x
 * https://github.com/moxystudio/node-proper-lockfile
 *
 * This file provides type information for the proper-lockfile JS module.
 * No exports — treated as ambient declaration by TypeScript.
 */

declare module "proper-lockfile" {
	interface RetryOptions {
		retries?: number;
		factor?: number;
		minTimeout?: number;
		maxTimeout?: number;
		randomize?: boolean;
	}

	interface LockOptions {
		stale?: number;
		update?: number;
		retries?: number | RetryOptions;
		realpath?: boolean;
		fs?: typeof import("node:fs");
		onCompromised?: (err: Error) => void;
		lockfilePath?: string;
	}

	interface UnlockOptions {
		realpath?: boolean;
		fs?: typeof import("node:fs");
		lockfilePath?: string;
	}

	interface CheckOptions {
		stale?: number;
		realpath?: boolean;
		fs?: typeof import("node:fs");
		lockfilePath?: string;
	}

	function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	function unlock(file: string, options?: UnlockOptions): Promise<void>;
	function check(file: string, options?: CheckOptions): Promise<boolean>;
	function lockSync(file: string, options?: LockOptions): () => void;
	function unlockSync(file: string, options?: UnlockOptions): void;
	function checkSync(file: string, options?: CheckOptions): boolean;
}
