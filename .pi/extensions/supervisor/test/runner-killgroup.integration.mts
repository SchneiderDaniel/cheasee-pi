// ─── Integration: real process-group kill (Linux container) ──────
// Proves the "no orphaned Pi processes" criterion end-to-end on the real
// OS: a detached `sh` whose `sleep` grandchild holds the piped stdout is
// killed via the dead-line watchdog (killGroup = kill(-pid)). Both the
// leader and the grandchild must die, and the grandchild-held pipe must
// be released so 'close' fires — the exact "stuck run" symptom the
// per-agent timeout exists to bound.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/runner-killgroup.integration.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { armDeadlineWatchdog } from "../agent/runner/deadline.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("runner killGroup integration (real OS, Linux container)", () => {
	it(
		"SIGTERM → grace → SIGKILL terminates BOTH sh and its sleep grandchild; pipe released → close fires",
		{ timeout: 10_000 },
		async () => {
			const child = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			assert.ok(child.pid !== undefined, "child spawned with a pid");

			let sleepPid = 0;
			child.stdout.on("data", (d: Buffer) => {
				const parsed = parseInt(d.toString().trim(), 10);
				if (Number.isInteger(parsed) && parsed > 0) sleepPid = parsed;
			});
			assert.ok(isAlive(child.pid), "sh running before deadline");

			let closed = false;
			let closeCode: number | null = null;
			let closeSignal: string | null = null;
			child.on("close", (code, signal) => {
				closed = true;
				closeCode = code;
				closeSignal = signal;
			});

			try {
				// Real escalation ladder: SIGTERM ≈250ms, SIGKILL ≈400ms,
				// force-resolve ≈550ms (bounds an unkillable-pipe hang).
				await new Promise<void>((resolve) => {
					armDeadlineWatchdog({
						timeoutMs: 250,
						graceMs: 150,
						target: {
							killGroup: (sig) => {
								try {
									process.kill(-child.pid!, sig);
								} catch {
									/* group already gone — mirrors spawn.ts's ESRCH guard */
								}
							},
						},
						onForceResolve: resolve,
					});
				});

				// Allow SIGKILL/force timers + pipe drain to settle.
				await sleep(100);

				assert.ok(sleepPid > 0, `learned grandchild pid from stdout (got ${sleepPid})`);
				assert.equal(
					isAlive(sleepPid),
					false,
					"sleep grandchild is dead — no orphaned Pi process",
				);
				assert.equal(isAlive(child.pid!), false, "sh leader is dead");
				assert.equal(
					closed,
					true,
					"grandchild-held pipe released → 'close' fired (no indefinite stuck run)",
				);
				assert.notEqual(closeCode, 0, "killed run must not look like a clean exit");
			} finally {
				// Backstop: never leave the process group behind on failure.
				if (child.pid !== undefined && isAlive(child.pid)) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}
			}
		},
	);
});