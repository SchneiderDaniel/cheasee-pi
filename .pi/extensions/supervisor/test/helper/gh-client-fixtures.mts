// ─── Shared fixtures: gh-client suites ────────────────────────────
// `writeHosts` is used by BOTH gh-client.test.mts (the per-child GH_TOKEN
// injection path) and gh-client-token.test.mts (the resolution policy), so
// it is declared once here instead of twice.
//
// Not named `*.test.mts`, so `node --test` never loads it as a suite.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Write a gh hosts.yml holding `oauth_token: <token>` under `home`. */
export function writeHosts(home: string, token: string): void {
	mkdirSync(join(home, ".config", "gh"), { recursive: true });
	writeFileSync(
		join(home, ".config", "gh", "hosts.yml"),
		`github.com:\n    oauth_token: ${token}\n`,
	);
}
