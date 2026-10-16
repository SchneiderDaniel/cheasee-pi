/**
 * Shared test fixtures for the context-info extension.
 *
 * Eliminates three duplication families across codeflow.test.mts and
 * ui.test.mts:
 * 1. makeWorkspace — the temp workspace marker fixture
 * 2. makeBareWithRemote — the sibling bare-clone fixture
 * 3. withEnvVar — the save/restore env boilerplate (was withEnv + withUnresolved)
 *
 * Test scaffolding only; never imported by production code.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Temp workspace root with an optional cheasee-settings.json (always written
 * — the file IS the workspace marker; `{}` when not specified). */
export function makeWorkspace(
	prefix: string,
	settingsContent?: string,
): { root: string; parent: string } {
	const parent = mkdtempSync(join(tmpdir(), prefix));
	const root = join(parent, "ws");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "cheasee-settings.json"), settingsContent ?? "{}");
	return { root, parent };
}

/** Creates the sibling <parent>/.bare bare clone with a remote URL. */
export function makeBareWithRemote(parent: string, url: string): void {
	const bare = join(parent, ".bare");
	mkdirSync(bare, { recursive: true });
	execSync(`git --git-dir "${bare}" init --bare`, { stdio: "ignore" });
	execSync(`git --git-dir "${bare}" config remote.origin.url "${url}"`, { stdio: "ignore" });
}

/** Runs `fn` with `name` set to `value` (deleted when undefined), restoring the
 * prior value — including on throw. Touches no other env key. */
export function withEnvVar(
	name: string,
	value: string | undefined,
	fn: () => Promise<void>,
): Promise<void> {
	const saved = process.env[name];
	return (async () => {
		try {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
			await fn();
		} finally {
			if (saved === undefined) delete process.env[name];
			else process.env[name] = saved;
		}
	})();
}
