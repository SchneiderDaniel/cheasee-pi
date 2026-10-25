package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// procNetDev renders a /proc/net/dev document: the counter in
// scripts/net-bytes.sh parses that format, so the fixture has to keep both the
// header lines and the loopback row, which must not be counted.
func procNetDev(ethRx, ethTx, loRx, loTx int64) string {
	return "Inter-|   Receive                                                |  Transmit\n" +
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
		fmt.Sprintf("    lo: %d 1 0 0 0 0 0 0 %d 1 0 0 0 0 0 0\n", loRx, loTx) +
		fmt.Sprintf("  eth0: %d 1 0 0 0 0 0 0 %d 1 0 0 0 0 0 0\n", ethRx, ethTx)
}

func writeNetFixture(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	return path
}

func runNetBytes(t *testing.T, args ...string) (string, error) {
	t.Helper()
	script := filepath.Join("..", "..", "scripts", "net-bytes.sh")
	cmd := exec.Command("bash", append([]string{script}, args...)...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// snapshotOf renders what the workflow stores: `snapshot` output in a file. The
// delta only ever sees these files, so a test that feeds it /proc/net/dev
// directly is not testing the instrument the CI job runs.
func snapshotOf(t *testing.T, procNetDevPath string) string {
	t.Helper()
	out, err := runNetBytes(t, "snapshot", procNetDevPath)
	if err != nil {
		t.Fatalf("net-bytes.sh snapshot %s failed: %v\n%s", procNetDevPath, err, out)
	}
	return out
}

func TestNetBytesScript_DeltaCountsTheEgressInterfaceOnly(t *testing.T) {
	// Loopback is excluded: the replay's counting proxy runs over it, so counting
	// it would report the same bytes twice for a build the local proxy observed.
	before := writeNetFixture(t, "before", snapshotOf(t, writeNetFixture(t, "proc-before", procNetDev(1_000, 10, 9_000_000, 9_000_000))))
	after := writeNetFixture(t, "after", snapshotOf(t, writeNetFixture(t, "proc-after", procNetDev(3_500, 420, 99_000_000, 99_000_000))))

	out, err := runNetBytes(t, "delta", before, after)
	if err != nil {
		t.Fatalf("net-bytes.sh delta failed: %v\n%s", err, out)
	}
	// The label is the doc contract: docs/development.md quotes it verbatim.
	want := "build-cost wire rx=2500 B tx=410 B"
	if !strings.Contains(out, want) {
		t.Errorf("delta reported %q, want it to contain %q", strings.TrimSpace(out), want)
	}
}

func TestNetBytesScript_DeltaFailsLoudlyOnACounterReset(t *testing.T) {
	// A reboot or an interface flap resets the counters; a negative delta silently
	// truncated to zero would look like a build that downloaded nothing.
	before := writeNetFixture(t, "before", snapshotOf(t, writeNetFixture(t, "proc-before", procNetDev(3_500, 420, 0, 0))))
	after := writeNetFixture(t, "after", snapshotOf(t, writeNetFixture(t, "proc-after", procNetDev(1_000, 10, 0, 0))))

	out, err := runNetBytes(t, "delta", before, after)
	if err == nil {
		t.Fatalf("a shrinking counter must fail, got %q", strings.TrimSpace(out))
	}
	if !strings.Contains(strings.ToLower(out), "reset") {
		t.Errorf("the failure must say the counter reset, got %q", strings.TrimSpace(out))
	}
}

func TestNetBytesScript_DeltaRejectsARawProcNetDevDocument(t *testing.T) {
	// Regression for the run that left the end-to-end transfer uncaptured (#2053):
	// the delta re-parsed its snapshot files with the /proc/net/dev parser, so the
	// CI job's own one-line snapshots were rejected as "no interface counters".
	// A snapshot is two numbers; anything else has to fail, not print a delta.
	before := writeNetFixture(t, "before", procNetDev(1_000, 10, 0, 0))
	after := writeNetFixture(t, "after", procNetDev(3_500, 420, 0, 0))

	out, err := runNetBytes(t, "delta", before, after)
	if err == nil {
		t.Fatalf("delta must reject a /proc/net/dev document as a snapshot, got %q", strings.TrimSpace(out))
	}
	if !strings.Contains(strings.ToLower(out), "snapshot") {
		t.Errorf("the failure must name the snapshot format, got %q", strings.TrimSpace(out))
	}
}

func TestNetBytesScript_SnapshotAndBadArguments(t *testing.T) {
	// `snapshot` reads a path so the workflow can diff two files and the test can
	// feed one; a missing file and a bad verb must both fail, not print zero.
	fixture := writeNetFixture(t, "snap", procNetDev(7, 8, 1, 2))
	out, err := runNetBytes(t, "snapshot", fixture)
	if err != nil {
		t.Fatalf("net-bytes.sh snapshot failed: %v\n%s", err, out)
	}
	if got := strings.TrimSpace(out); got != "7 8" {
		t.Errorf("snapshot reported %q, want %q", got, "7 8")
	}

	if out, err := runNetBytes(t, "snapshot", filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Errorf("a missing /proc/net/dev path must fail, got %q", strings.TrimSpace(out))
	}
	if out, err := runNetBytes(t, "bogus"); err == nil {
		t.Errorf("an unknown verb must fail, got %q", strings.TrimSpace(out))
	}
	if out, err := runNetBytes(t, "delta", fixture); err == nil {
		t.Errorf("delta with one file must fail, got %q", strings.TrimSpace(out))
	}
}
