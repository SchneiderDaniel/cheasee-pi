/**
 * Marker extension for the dogfooding resource-dedup load test
 * (test/dogfooding-dedup.test.sh, issue #1497).
 *
 * Appends one line to $MARKER_LOG (default /tmp/marker.log) as a top-level
 * side effect at load time. The test injects this extension into the mounted
 * repo's .pi/extensions/marker-dedup/ and counts log lines:
 *
 *   - 1 line  → the global ~/.pi/agent symlink and the project settings path
 *               resolved to one realpath (pi's mergePaths dedup) → single load
 *   - 2 lines → both paths loaded (duplication — detection disabled)
 *
 * The default export is a no-op factory: pi requires a valid factory function
 * and a load failure would break boot, polluting the diagnostics under test.
 */
import { appendFileSync } from "node:fs";

appendFileSync(process.env.MARKER_LOG ?? "/tmp/marker.log", `${Date.now()} marker:loaded\n`);

export default function dogfoodingMarkerDedup(_pi: unknown): void {
	// no-op — the load-time side effect above is the marker
}
