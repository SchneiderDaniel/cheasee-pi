/**
 * Shared fixtures for the lsp-auditor suites.
 *
 * Replaces the duplicated `makeGitFixture` / `errorDiag` pair in
 * lsp-auditor-command-output.test.mts and lsp-auditor-run-pre-audit.test.mts.
 * `makeCtx` stays local: the two suites' ctx shapes diverge.
 *
 * Test scaffolding only; never imported by production code.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A severity-1 diagnostic on the first character of line 0. */
export function errorDiag(message = "mock error") {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: 1,
		message,
	};
}

/** Committed `main` repo with a modified src/app.ts and a .pi/settings.json LSP config. */
export function makeGitFixture(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src/app.ts"), "const x: number = 1;\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
	// Modify the tracked file so `git diff main --name-only` reports it
	writeFileSync(join(dir, "src/app.ts"), "const x: number = 'bad';\n");
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		join(dir, ".pi/settings.json"),
		JSON.stringify({
			lspAuditor: {
				servers: [
					{ extensions: [".ts"], command: "mock-lsp", args: [], severityThreshold: "warning" },
				],
			},
		}),
	);
	return dir;
}
