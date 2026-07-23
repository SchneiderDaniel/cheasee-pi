package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// orphanScanBash is the shell script that scans /proc for orphaned pi processes.
// Targets processes with PPid=1 (reparented to tini after parent disconnects)
// and cmdline matching /usr/bin/pi or pi (anchored — no *pi* substring to avoid
// false positives on python/pipewire). TOCTOU races between stat read and kill
// are tolerated — ESRCH is silently swallowed by 2>/dev/null.
const orphanScanBash = `for pid in /proc/[0-9]*/stat; do
  ppid=$(awk '{print $4}' "$pid" 2>/dev/null)
  cmdline=$(tr '\0' ' ' < "${pid%/stat}/cmdline" 2>/dev/null)
  [ "$ppid" = "1" ] && { [[ "$cmdline" == "/usr/bin/pi"* ]] || [[ "$cmdline" == "pi "* ]] || [[ "$cmdline" == "pi" ]]; } && \
    echo "killing $(basename "$(dirname "$pid")")" && \
    kill "$(basename "$(dirname "$pid")")" 2>/dev/null
done || true`

// cmdIface is the subset of *exec.Cmd used by scanOrphans.
type cmdIface interface {
	Output() ([]byte, error)
	CombinedOutput() ([]byte, error)
}

// execCommand is os/exec.Command wrapped in cmdIface, overridable in tests.
var execCommand = func(name string, arg ...string) cmdIface {
	return exec.Command(name, arg...)
}

// scanOrphans runs the orphan-scan bash inside the container and returns the
// number of PIDs that were signalled. Returns (0, nil) if the container is
// not running (graceful skip). Best-effort: TOCTOU races are tolerated.
func scanOrphans(ctx context.Context, name string) (int, error) {
	// Check container is running
	cmd := execCommand("docker", "ps", "--filter", fmt.Sprintf("name=%s", name), "--format", "{{.Names}}")
	out, err := cmd.Output()
	if err != nil {
		return 0, fmt.Errorf("docker ps: %w", err)
	}
	if strings.TrimSpace(string(out)) != name {
		return 0, nil
	}

	execCmd := execCommand("docker", "exec", name, "bash", "-c", orphanScanBash)
	output, err := execCmd.CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("orphan scan: %w", err)
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	count := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "killing ") {
			count++
		}
	}
	return count, nil
}
