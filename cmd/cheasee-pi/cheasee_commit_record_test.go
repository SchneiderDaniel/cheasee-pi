package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

func TestAbout_reportsWorkspaceImageCommit(t *testing.T) {
	// about must surface the actual baked SHA (audit finding, issue #2054), not
	// just the file path — and it must be THIS workspace image's commit: a
	// record written by another workspace's build must never be reported.
	savedDir, savedRef := aboutCacheDir, aboutImageRef
	dir := t.TempDir()
	aboutCacheDir = func() (string, error) { return dir, nil }
	aboutImageRef = func() string { return "cheasee-pi-mine-cheasee-pi" }
	t.Cleanup(func() { aboutCacheDir, aboutImageRef = savedDir, savedRef })
	recordBakedCommit(dir, "cheasee-pi-mine-cheasee-pi", "main", "cafebabe")
	recordBakedCommit(dir, "cheasee-pi-other-cheasee-pi", "main", "deadbeef")

	cmd := &cobra.Command{Use: "about"}
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	if err := runAboutE(cmd, nil); err != nil {
		t.Fatalf("runAboutE: %v", err)
	}
	if !strings.Contains(out.String(), "cafebabe") {
		t.Errorf("about must report the baked cheasee-pi commit value\n--- about:\n%s", out.String())
	}
	if strings.Contains(out.String(), "deadbeef") {
		t.Errorf("about must report only THIS workspace image's commit\n--- about:\n%s", out.String())
	}
	if !strings.Contains(aboutText, "/opt/cheasee-pi/BUILD_COMMIT") {
		t.Errorf("about must report where the baked cheasee-pi commit is recorded\n--- about text:\n%s", aboutText)
	}
}

// TestAbout_omitsCommitWithoutBuildRecord pins that an unbuilt machine shows
// no commit line rather than a bogus one.
func TestAbout_omitsCommitWithoutBuildRecord(t *testing.T) {
	savedDir, savedRef := aboutCacheDir, aboutImageRef
	aboutCacheDir = func() (string, error) { return t.TempDir(), nil }
	aboutImageRef = func() string { return "cheasee-pi-mine-cheasee-pi" }
	t.Cleanup(func() { aboutCacheDir, aboutImageRef = savedDir, savedRef })

	cmd := &cobra.Command{Use: "about"}
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	if err := runAboutE(cmd, nil); err != nil {
		t.Fatalf("runAboutE: %v", err)
	}
	if strings.Contains(out.String(), "baked cheasee-pi commit") {
		t.Errorf("about must not invent a baked commit when none is recorded\n--- about:\n%s", out.String())
	}
}

// TestAboutImageRef_resolvesCurrentWorkspace pins the scoping key: the image
// ref comes from the workspace containing the cwd, and is empty outside a
// cheasee-pi workspace (no image to describe).
func TestAboutImageRef_resolvesCurrentWorkspace(t *testing.T) {
	ws := t.TempDir()
	if err := os.WriteFile(cheaseeSettingsPath(ws), []byte("{}\n"), 0644); err != nil {
		t.Fatalf("seed workspace marker: %v", err)
	}
	t.Chdir(ws)
	if got, want := aboutImageRef(), cheaseeImageRef(ws); got != want {
		t.Errorf("aboutImageRef = %q, want the cwd workspace's image %q", got, want)
	}

	t.Chdir(t.TempDir())
	if got := aboutImageRef(); got != "" {
		t.Errorf("aboutImageRef outside a workspace = %q, want empty", got)
	}
}

func TestDocs_BakedCloneRefreshPolicy(t *testing.T) {
	src := readRepoFile(t, filepath.Join("docs", "installation.md"))
	for _, want := range []string{"CHEASEE_COMMIT", "/opt/cheasee-pi/BUILD_COMMIT"} {
		if !strings.Contains(src, want) {
			t.Errorf("docs/installation.md must document the baked-clone refresh policy (%q)", want)
		}
	}
}

// TestVerifyScript_CheaseeCommitHeldConstantForCachedRebuild pins the manual
// #1603 cache harness against the new clone-layer key (issue #2054): its
// builds 2/3 bypass the CLI, so they must supply the same CHEASEE_COMMIT the
// CLI resolved — an empty value is a different cache key and would legitimately
// re-run the clone, voiding the harness's AC1 assertion.
func TestVerifyScript_CheaseeCommitHeldConstantForCachedRebuild(t *testing.T) {
	src := readRepoFile(t, filepath.Join("scripts", "verify-pi-layer-cache.sh"))
	if !strings.Contains(src, "git ls-remote") {
		t.Error("verify script must resolve the same upstream commit the CLI supplies")
	}
	if !strings.Contains(src, `CHEASEE_COMMIT="$CHEASEE_COMMIT"`) {
		t.Error("verify script must pass that commit to its direct compose builds")
	}
}

// TestCheaseeRef_defaultAndOverride pins the ref the baked copy tracks: a
// user-supplied CHEASEE_REF verbatim, the compose/Dockerfile default main
// otherwise.
func TestCheaseeRef_defaultAndOverride(t *testing.T) {
	t.Setenv("CHEASEE_REF", "v2.0.0")
	if got := cheaseeRef(); got != "v2.0.0" {
		t.Errorf("cheaseeRef = %q, want the user-set ref verbatim", got)
	}
	t.Setenv("CHEASEE_REF", "")
	if got := cheaseeRef(); got != "main" {
		t.Errorf("cheaseeRef with an empty CHEASEE_REF = %q, want main", got)
	}
}

// TestCheaseeCommitRecord_roundTripAndGuards pins the host record's format and
// its conservative failure modes: an unparsable record reads as zero rather
// than borrowing a commit from a record that is not about this image.
func TestCheaseeCommitRecord_roundTripAndGuards(t *testing.T) {
	dir := t.TempDir()

	recordBakedCommit(dir, "img-a", "main", "cafebabe")
	if got := readBakedCommit(dir, "img-a"); got.ref != "main" || got.commit != "cafebabe" {
		t.Errorf("record must round-trip ref+commit, got %+v", got)
	}

	// An empty commit is not a known revision and must never be persisted.
	recordBakedCommit(dir, "img-b", "main", "")
	if _, err := os.Stat(cheaseeCommitCachePath(dir, "img-b")); !os.IsNotExist(err) {
		t.Errorf("an empty commit must not be recorded (stat err = %v)", err)
	}

	if got := readBakedCommit(dir, "img-c"); got != (cheaseeCommitRecord{}) {
		t.Errorf("a missing record must read as zero, got %+v", got)
	}

	// A record without the space separator has no ref to attribute the commit
	// to: read it as zero rather than misattributing the commit.
	if err := os.WriteFile(cheaseeCommitCachePath(dir, "img-d"), []byte("cafebabe\n"), 0644); err != nil {
		t.Fatalf("seed malformed record: %v", err)
	}
	if got := readBakedCommit(dir, "img-d"); got != (cheaseeCommitRecord{}) {
		t.Errorf("a malformed record must read as zero, got %+v", got)
	}

	if cheaseeCommitCachePath(dir, "img-a") == cheaseeCommitCachePath(dir, "img-b") {
		t.Error("each image must own its record path")
	}
}

// TestBakedCommitForBuild_probeFailureWarnsWithinTimeout pins the offline path's
// observability and its bound: the probe runs under cheaseeCommitProbeTimeout
// (an unreachable remote must not stall a build) and its failure warns on
// stderr instead of silently falling back.
func TestBakedCommitForBuild_probeFailureWarnsWithinTimeout(t *testing.T) {
	saved := resolveCheaseeCommit
	t.Cleanup(func() { resolveCheaseeCommit = saved })

	var hasDeadline bool
	resolveCheaseeCommit = func(ctx context.Context, _ string) (string, error) {
		_, hasDeadline = ctx.Deadline()
		return "", errors.New("network down")
	}

	var got string
	stderr := testutil.CaptureStderr(t, func() {
		got = bakedCommitForBuild(context.Background(), t.TempDir(), "img-a")
	})
	if got != "" {
		t.Errorf("a failed probe with no record must leave the cache-bust input empty, got %q", got)
	}
	if !hasDeadline {
		t.Errorf("the probe must run under cheaseeCommitProbeTimeout (%s)", cheaseeCommitProbeTimeout)
	}
	if !strings.Contains(stderr, "cheasee-pi commit probe") {
		t.Errorf("a failed probe must be warned on stderr, got:\n%s", stderr)
	}
}

// TestComposeBuild_probeRunsAfterDiskGate pins the ordering: a build refused by
// the free-space gate never reaches the upstream probe (no network on a build
// that cannot run).
func TestComposeBuild_probeRunsAfterDiskGate(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	saved := resolveCheaseeCommit
	t.Cleanup(func() { resolveCheaseeCommit = saved })
	probes := 0
	resolveCheaseeCommit = func(context.Context, string) (string, error) { probes++; return "abc123", nil }

	testutil.CaptureStderr(t, func() {
		if err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err == nil {
			t.Error("a build refused by the disk gate must return an error")
		}
	})
	if probes != 0 {
		t.Errorf("a refused build must never probe the network, got %d probe(s)", probes)
	}
}

// TestAbout_warnsWhenCommitRecordUnavailable pins that an unresolvable record
// directory is reported and never turns `about` into a failure or a partial
// output: the glossary still prints, with no invented commit.
func TestAbout_warnsWhenCommitRecordUnavailable(t *testing.T) {
	savedDir, savedRef := aboutCacheDir, aboutImageRef
	aboutCacheDir = func() (string, error) { return "", errors.New("no user cache dir") }
	aboutImageRef = func() string { return "cheasee-pi-mine-cheasee-pi" }
	t.Cleanup(func() { aboutCacheDir, aboutImageRef = savedDir, savedRef })

	cmd := &cobra.Command{Use: "about"}
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	var err error
	stderr := testutil.CaptureStderr(t, func() { err = runAboutE(cmd, nil) })
	if err != nil {
		t.Fatalf("runAboutE: %v", err)
	}
	if !strings.Contains(stderr, "baked cheasee-pi commit") {
		t.Errorf("an unavailable commit record must be warned on stderr, got:\n%s", stderr)
	}
	if !strings.Contains(out.String(), "CHEASEE_REF") {
		t.Error("the glossary must still print when the commit record is unavailable")
	}
	if strings.Contains(out.String(), "baked cheasee-pi commit") {
		t.Errorf("about must not invent a baked commit from an unavailable record\n--- about:\n%s", out.String())
	}
}
