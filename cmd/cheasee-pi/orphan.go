package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// inUseClaimDir is the container-side path of the live-session claim directory
// on the shared workspace mount. `start` writes one file per session id; the ui
// sidecar (same mount, separate PID namespace) reads it to refuse attaching a
// second process to a live terminal session. Dot-prefixed so the flat
// `.jsonl` session scan ignores it.
const inUseClaimDir = "/workspaces/main/.pi/sessions/.cheasee-inuse"

// orphanScanBash is the shell script that scans /proc for orphaned pi processes.
// Two reapers, both gated on `pi_is_session` — an argv-token match, never a
// `*pi*` substring (avoids false positives on python/pipewire):
//  1. PPid=1: processes reparented to tini after their parent died.
//  2. Age (gated on CHEASEE_MAX_AGE_MIN>0): docker exec clients that
//     disconnect leave pi running — the process's parent stays the host-side
//     containerd shim, invisible inside the container PID namespace, so PPid
//     reads 0 (never 1) and reaper 1 can't see it. Sessions older than the
//     threshold are detached stragglers and get reaped by age.
//
// `pi_is_session` tokenizes /proc/<pid>/cmdline (NUL-separated) instead of
// prefix-matching the joined string: a shebang-launched pi has argv[0]=node and
// argv[1]=<...>/pi-coding-agent/dist/cli.js, so an anchored `"/usr/bin/pi"*`
// match is dead for the common install. It accepts a direct `/usr/bin/pi` or
// `pi` argv[0], a `pi-coding-agent` path anywhere in argv, or an adjacent
// `--session`/`--session-id` flag pair.
//
// CHEASEE_DRY_RUN=1 makes the script only report matches ("killing ..."
// lines) without signalling them — scanOrphans uses it as a preview pass.
// TOCTOU races between stat read and kill are tolerated — ESRCH is silently
// swallowed by 2>/dev/null.
const orphanScanBash = `pi_is_session() {
  local -a argv=()
  while IFS= read -r -d '' tok; do argv+=("$tok"); done < "$1/cmdline" 2>/dev/null
  [ "${#argv[@]}" -gt 0 ] || return 1
  case "${argv[0]}" in
    "/usr/bin/pi"|pi|*/pi) return 0 ;;
  esac
  local a
  for a in "${argv[@]}"; do
    case "$a" in
      *pi-coding-agent*) return 0 ;;
    esac
  done
  local i
  for ((i=0; i+1<${#argv[@]}; i++)); do
    case "${argv[$i]}" in
      --session|--session-id) return 0 ;;
    esac
  done
  return 1
}
for pid in /proc/[0-9]*/stat; do
  ppid=$(awk '{print $4}' "$pid" 2>/dev/null)
  dir="${pid%/stat}"
  [ "$ppid" = "1" ] && pi_is_session "$dir" && \
    echo "killing $(basename "$dir")" && \
    { [ "${CHEASEE_DRY_RUN:-0}" = "1" ] || kill "$(basename "$dir")" 2>/dev/null; }
  if [ "${CHEASEE_MAX_AGE_MIN:-0}" -gt 0 ] 2>/dev/null; then
    pi_is_session "$dir" && {
      start=$(awk '{print $22}' "$pid" 2>/dev/null)
      now=$(awk '{print int($1*100)}' /proc/uptime 2>/dev/null)
      age_min=$(( (now - start) / 6000 ))
      [ "$age_min" -gt "${CHEASEE_MAX_AGE_MIN:-0}" ] && \
        echo "killing $(basename "$dir") (age ${age_min}m)" && \
        { [ "${CHEASEE_DRY_RUN:-0}" = "1" ] || kill "$(basename "$dir")" 2>/dev/null; }
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
// CHEASEE_SESSION_ID env marker and purges its live-session claim. start runs
// it after the docker exec client detaches: pi survives client disconnect (its
// parent stays the host-side containerd shim, so it never becomes a PPid=1
// orphan and the orphan scan can't see it), and this kills it by its unique
// marker. The claim purge keeps the cross-container in-use guard from outliving
// the session it guards; a missing claim is fine. Best-effort: a stopped
// container or an already-exited session are fine.
func killSessionByMarker(ctx context.Context, name, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	script := fmt.Sprintf(`for p in /proc/[0-9]*/environ; do
  if tr '\0' '\n' < "$p" 2>/dev/null | grep -qx "CHEASEE_SESSION_ID=%s"; then
    echo "killing session $(basename "$(dirname "$p")")" && kill "$(basename "$(dirname "$p")")" 2>/dev/null
  fi
done || true
rm -f %s/%s 2>/dev/null
rmdir %s 2>/dev/null || true`, sessionID, inUseClaimDir, sessionID, inUseClaimDir)
	if _, err := runCommandContext(ctx, "docker", "exec", name, "bash", "-c", script).CombinedOutput(); err != nil {
		return fmt.Errorf("session reaper: %w", err)
	}
	return nil
}

// writeInUseClaim records that a session is live so the UI's cross-container
// guard can refuse a second attach. The claim lives on the shared workspace
// mount, so both containers see the same file; the ui sidecar reads it, the
// terminal side writes and removes it. Best-effort at the call site: a missing
// claim degrades the guard to advisory, never a failed start.
func writeInUseClaim(sessionDir, sessionID, container string) error {
	if sessionID == "" {
		return nil
	}
	dir := filepath.Join(sessionDir, ".cheasee-inuse")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{
		"container": container,
		"startedAt": time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, sessionID), body, 0o644)
}

// removeInUseClaim drops the claim for one session. A missing claim is not an
// error: the container-side purge in killSessionByMarker may have run first.
func removeInUseClaim(sessionDir, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	err := os.Remove(filepath.Join(sessionDir, ".cheasee-inuse", sessionID))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// purgeInUseClaims removes the whole claim directory for a workspace. clean and
// down remove the containers that own the sessions, so the claims must not
// outlive them — a stale claim would block a resume forever.
func purgeInUseClaims(sessionDir string) error {
	if sessionDir == "" {
		return nil
	}
	if err := os.RemoveAll(filepath.Join(sessionDir, ".cheasee-inuse")); err != nil {
		return fmt.Errorf("purge in-use claims: %w", err)
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
