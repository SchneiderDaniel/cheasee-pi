package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"
)

// orphanScanBash is the shell script that scans /proc for orphaned pi processes.
// Two reapers, both gated on the same anchored /usr/bin/pi|pi cmdline match
// (no *pi* substring — avoids false positives on python/pipewire):
//  1. PPid=1: processes reparented to tini after their parent died.
//  2. Age (gated on CHEASEE_MAX_AGE_MIN>0): docker exec clients that
//     disconnect leave pi running — the process's parent stays the host-side
//     containerd shim, invisible inside the container PID namespace, so PPid
//     reads 0 (never 1) and reaper 1 can't see it. Sessions older than the
//     threshold are detached stragglers and get reaped by age.
//
// CHEASEE_DRY_RUN=1 makes the script only report matches ("killing ..."
// lines) without signalling them — scanOrphans uses it as a preview pass.
// TOCTOU races between stat read and kill are tolerated — ESRCH is silently
// swallowed by 2>/dev/null.
const orphanScanBash = `for pid in /proc/[0-9]*/stat; do
  ppid=$(awk '{print $4}' "$pid" 2>/dev/null)
  cmdline=$(tr '\0' ' ' < "${pid%/stat}/cmdline" 2>/dev/null)
  [ "$ppid" = "1" ] && { [[ "$cmdline" == "/usr/bin/pi"* ]] || [[ "$cmdline" == "pi "* ]] || [[ "$cmdline" == "pi" ]]; } && \
    echo "killing $(basename "$(dirname "$pid")")" && \
    { [ "${CHEASEE_DRY_RUN:-0}" = "1" ] || kill "$(basename "$(dirname "$pid")")" 2>/dev/null; }
  if [ "${CHEASEE_MAX_AGE_MIN:-0}" -gt 0 ] 2>/dev/null; then
    { [[ "$cmdline" == "/usr/bin/pi"* ]] || [[ "$cmdline" == "pi "* ]] || [[ "$cmdline" == "pi" ]]; } && {
      start=$(awk '{print $22}' "$pid" 2>/dev/null)
      now=$(awk '{print int($1*100)}' /proc/uptime 2>/dev/null)
      age_min=$(( (now - start) / 6000 ))
      [ "$age_min" -gt "${CHEASEE_MAX_AGE_MIN:-0}" ] && \
        echo "killing $(basename "$(dirname "$pid")") (age ${age_min}m)" && \
        { [ "${CHEASEE_DRY_RUN:-0}" = "1" ] || kill "$(basename "$(dirname "$pid")")" 2>/dev/null; }
    }
  fi
done || true`

// scanOrphans runs the orphan-scan bash inside the container and returns the
// "killing ..." report lines — one per session that matched a reaper. With
// dryRun=true the script only reports matches without signalling them, so the
// result doubles as a preview. Returns (nil, nil) if the container is not
// running (graceful skip). Best-effort: TOCTOU races are tolerated.
// maxAgeMinutes > 0 additionally reaps pi sessions older than the threshold
// (detached docker exec stragglers — see orphanScanBash); 0 keeps the
// original PPid=1-only behaviour.
func scanOrphans(ctx context.Context, name string, maxAgeMinutes int, dryRun bool) ([]string, error) {
	// Check the container is running — exact line-compare against the
	// substring name filter (a sibling `cheasee-pi-foo-bar` must never make
	// `cheasee-pi-foo` look running).
	running, err := containerRunning(ctx, name)
	if err != nil {
		return nil, err
	}
	if !running {
		return nil, nil
	}

	dryFlag := "0"
	if dryRun {
		dryFlag = "1"
	}
	output, err := runCommandContext(ctx, "docker", "exec",
		"-e", fmt.Sprintf("CHEASEE_MAX_AGE_MIN=%d", maxAgeMinutes),
		"-e", "CHEASEE_DRY_RUN="+dryFlag,
		name, "bash", "-c", orphanScanBash).CombinedOutput()
	if err != nil {
		// A canceled scan must not be mislabeled as a bash-less container:
		// surface the ctx error, keep the warn-skip only for genuine exec
		// failures on a live ctx.
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Sidecar images (e.g. the codeflow/code-server container) ship
		// without bash — the scan script cannot run there and no pi process
		// ever does. Aborting the whole clean over a container that has
		// nothing to reap is worse than skipping: warn and move on.
		fmt.Fprintf(os.Stderr, "  ⚠ orphan scan skipped for %s: %v\n", name, err)
		return nil, nil
	}

	var killed []string
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.HasPrefix(line, "killing ") {
			killed = append(killed, line)
		}
	}
	return killed, nil
}

// killSessionByMarker reaps the pi session that carries the given
// CHEASEE_SESSION_ID env marker. start runs it after the docker exec client
// detaches: pi survives client disconnect (its parent stays the host-side
// containerd shim, so it never becomes a PPid=1 orphan and the orphan scan
// can't see it), and this kills it by its unique marker. Best-effort: a
// stopped container or an already-exited session are fine.
func killSessionByMarker(ctx context.Context, name, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	script := fmt.Sprintf(`for p in /proc/[0-9]*/environ; do
  if tr '\0' '\n' < "$p" 2>/dev/null | grep -qx "CHEASEE_SESSION_ID=%s"; then
    echo "killing session $(basename "$(dirname "$p")")" && kill "$(basename "$(dirname "$p")")" 2>/dev/null
  fi
done || true`, sessionID)
	if _, err := runCommandContext(ctx, "docker", "exec", name, "bash", "-c", script).CombinedOutput(); err != nil {
		return fmt.Errorf("session reaper: %w", err)
	}
	return nil
}

// newSessionID returns a short random hex id used as the CHEASEE_SESSION_ID
// env marker for a session launched by start.
func newSessionID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano()) // fallback: still unique per launch
	}
	return hex.EncodeToString(b)
}
