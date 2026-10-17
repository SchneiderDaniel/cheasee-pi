package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// Issue #2054: the baked /opt/cheasee-pi clone layer must be invalidated
// deliberately by a CLI-supplied, content-addressed input (CHEASEE_COMMIT),
// not only by build-cache eviction. These tests pin that wiring so it cannot
// silently revert to the constant-only clone layer that froze for months.

func TestDockerfile_CloneLayerCacheBustCommit(t *testing.T) {
	content := readDockerfile(t)
	// The ARG must exist and the clone RUN must reference it — BuildKit only
	// folds a referenced ARG into the layer's cache key; an unreferenced one
	// would invalidate nothing.
	if !strings.Contains(content, "ARG CHEASEE_COMMIT") {
		t.Fatal("Dockerfile must declare ARG CHEASEE_COMMIT (clone-layer cache-bust input)")
	}
	cloneIdx := strings.Index(content, "git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi")
	if cloneIdx == -1 {
		t.Fatal("clone layer marker missing")
	}
	if !strings.Contains(content[cloneIdx:], "${CHEASEE_COMMIT}") {
		t.Error("clone RUN must reference ${CHEASEE_COMMIT} so a changed upstream commit invalidates the layer")
	}
	// Fail closed on a mid-build ref move: caching the clone under the probed
	// commit's cache key is only safe when the clone's HEAD actually IS that
	// commit; otherwise the layer would pin unreviewed content to a stale key.
	if !strings.Contains(content[cloneIdx:], "upstream moved mid-build") || !strings.Contains(content[cloneIdx:], "exit 1") {
		t.Error("clone RUN must fail the build when the clone's HEAD differs from CHEASEE_COMMIT")
	}
	// The baked commit is recorded for observability (AC2).
	if !strings.Contains(content, "/opt/cheasee-pi/BUILD_COMMIT") {
		t.Error("clone layer must record the baked commit at /opt/cheasee-pi/BUILD_COMMIT")
	}
	if !strings.Contains(content, "git -C /opt/cheasee-pi rev-parse HEAD") {
		t.Error("clone layer must derive the baked commit from the clone's HEAD")
	}
	// The cache-bust ARG must be declared before (or at) the clone RUN — a
	// later declaration could not affect this layer's cache key.
	argIdx := strings.Index(content, "ARG CHEASEE_COMMIT")
	if argIdx > cloneIdx {
		t.Errorf("ARG CHEASEE_COMMIT (offset %d) must precede the clone RUN (offset %d)", argIdx, cloneIdx)
	}
}

func TestCompose_CheaseeCommitScopedToPiService(t *testing.T) {
	compose := readCompose(t)
	if got := composeBuildArgs(t, compose, "cheasee-pi")["CHEASEE_COMMIT"]; got != "${CHEASEE_COMMIT:-}" {
		t.Errorf("cheasee-pi build arg CHEASEE_COMMIT = %v, want ${CHEASEE_COMMIT:-}", got)
	}
	for _, svc := range []string{"ui", "codeflow"} {
		if _, present := composeBuildArgs(t, compose, svc)["CHEASEE_COMMIT"]; present {
			t.Errorf("%s must not declare CHEASEE_COMMIT (the clone layer is the agent image only)", svc)
		}
	}
}

func TestApplyComposeEnv_CheaseeCommitSuppliedOnce(t *testing.T) {
	// An inherited CHEASEE_COMMIT must be stripped and replaced by the single
	// CLI-owned entry (duplicate entries resolve nondeterministically).
	t.Setenv("CHEASEE_COMMIT", "stale")

	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir(), "CHEASEE_COMMIT=deadbeef")

	var hits []string
	for _, e := range cmd.env {
		if k, v, ok := strings.Cut(e, "="); ok && k == "CHEASEE_COMMIT" {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 || hits[0] != "deadbeef" {
		t.Errorf("exactly one CLI-resolved CHEASEE_COMMIT entry expected, got %v", hits)
	}
}

// TestComposeBuild_SuppliesResolvedCheaseeCommit pins the build-path wiring:
// the resolver's SHA must land in the compose env as CHEASEE_COMMIT, the only
// place the clone layer's cache key is set.
func TestComposeBuild_SuppliesResolvedCheaseeCommit(t *testing.T) {
	saved := resolveCheaseeCommit
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "abc123", nil }
	t.Cleanup(func() { resolveCheaseeCommit = saved })

	stubStatfsAmple(t)
	var built *mockCmd
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("/var/lib/docker\n"), nil }}
		}
		if name == "docker" && slices.Contains(arg, "compose") {
			built = &mockCmd{}
			return built
		}
		return &mockCmd{}
	})

	testutil.CaptureStderr(t, func() {
		if err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
			t.Fatalf("composeBuild: %v", err)
		}
	})
	if built == nil {
		t.Fatal("no compose build invocation captured")
	}
	var hits []string
	for _, e := range built.env {
		if k, v, ok := strings.Cut(e, "="); ok && k == "CHEASEE_COMMIT" {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 || hits[0] != "abc123" {
		t.Errorf("compose env must carry exactly one resolved CHEASEE_COMMIT, got %v", hits)
	}
}

// TestComposeBuild_ProbeFailureReusesLastCommit pins the offline fallback: a
// probe that fails after a successful resolution must keep passing the last
// resolved commit, because a changed (e.g. empty) ARG would give the clone
// layer a new cache key and force a network clone even though a usable cached
// layer exists.
func TestComposeBuild_ProbeFailureReusesLastCommit(t *testing.T) {
	stubStatfsAmple(t)
	var built []*mockCmd
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("/var/lib/docker\n"), nil }}
		}
		if name == "docker" && slices.Contains(arg, "compose") {
			built = append(built, &mockCmd{})
			return built[len(built)-1]
		}
		return &mockCmd{}
	})

	saved := resolveCheaseeCommit
	t.Cleanup(func() { resolveCheaseeCommit = saved })
	composeDir := t.TempDir()
	// One workspace across both builds: the record is keyed by image, so a
	// fresh temp dir per build would legitimately miss it.
	workspace := t.TempDir()
	buildCommit := func() string {
		t.Helper()
		testutil.CaptureStderr(t, func() {
			if err := composeBuild(context.Background(), composeDir, workspace, "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
				t.Fatalf("composeBuild: %v", err)
			}
		})
		if len(built) == 0 {
			t.Fatal("no compose build invocation captured")
		}
		var hits []string
		for _, e := range built[len(built)-1].env {
			if k, v, ok := strings.Cut(e, "="); ok && k == "CHEASEE_COMMIT" {
				hits = append(hits, v)
			}
		}
		if len(hits) != 1 {
			t.Fatalf("exactly one CHEASEE_COMMIT entry expected, got %v", hits)
		}
		return hits[0]
	}

	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "abc123", nil }
	if got := buildCommit(); got != "abc123" {
		t.Fatalf("first build must pass the resolved commit, got %q", got)
	}

	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "", errors.New("network down") }
	if got := buildCommit(); got != "abc123" {
		t.Errorf("failed probe must reuse the last resolved commit (cache key unchanged), got %q", got)
	}
}

// TestComposeBuild_ProbeFailureDoesNotReuseCrossRefCommit pins the ref-keyed
// fallback (issue #2054 audit): switching CHEASEE_REF and then losing probe
// connectivity must NOT reuse another ref's commit — the clone layer's cache
// key and HEAD guard would then describe the wrong revision.
func TestComposeBuild_ProbeFailureDoesNotReuseCrossRefCommit(t *testing.T) {
	saved := resolveCheaseeCommit
	t.Cleanup(func() { resolveCheaseeCommit = saved })

	composeDir := t.TempDir()
	workspace := t.TempDir()
	t.Setenv("CHEASEE_REF", "main")
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "abc123", nil }
	if got := runComposeBuildCommitArg(t, composeDir, workspace, ""); got != "abc123" {
		t.Fatalf("main build must pass the resolved commit, got %q", got)
	}

	t.Setenv("CHEASEE_REF", "v2.0.0")
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "", errors.New("network down") }
	if got := runComposeBuildCommitArg(t, composeDir, workspace, ""); got != "" {
		t.Errorf("failed probe on a NEW ref must not reuse main's commit, got %q", got)
	}
}

// TestComposeBuild_FirstBuildFailedProbeCapturesBakedCommit pins the second
// audit finding: with no prior same-ref record a failed probe leaves the ARG
// empty, so after a SUCCESSFUL build the commit the image actually baked must
// be captured into the host record — otherwise `about` reports nothing.
func TestComposeBuild_FirstBuildFailedProbeCapturesBakedCommit(t *testing.T) {
	saved := resolveCheaseeCommit
	t.Cleanup(func() { resolveCheaseeCommit = saved })
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "", errors.New("network down") }
	t.Setenv("CHEASEE_REF", "main")

	composeDir := t.TempDir()
	workspace := t.TempDir()
	if got := runComposeBuildCommitArg(t, composeDir, workspace, "baked999\n"); got != "" {
		t.Fatalf("failed first-build probe must pass an empty cache-bust input, got %q", got)
	}
	if got := readBakedCommit(composeDir, cheaseeImageRef(workspace)); got.ref != "main" || got.commit != "baked999" {
		t.Errorf("baked commit must be captured from the built image, got %+v", got)
	}
}

// TestComposeBuild_RecordsCommitPerImage pins the audit finding that a single
// version-wide record let a build in workspace B overwrite what `cheasee-pi
// about` reports for workspace A: each workspace image owns its record.
func TestComposeBuild_RecordsCommitPerImage(t *testing.T) {
	saved := resolveCheaseeCommit
	t.Cleanup(func() { resolveCheaseeCommit = saved })
	t.Setenv("CHEASEE_REF", "main")

	composeDir := t.TempDir()
	wsA, wsB := t.TempDir(), t.TempDir()
	if cheaseeImageRef(wsA) == cheaseeImageRef(wsB) {
		t.Fatal("test setup: workspaces must map to distinct images")
	}

	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "aaaa1111", nil }
	if got := runComposeBuildCommitArg(t, composeDir, wsA, ""); got != "aaaa1111" {
		t.Fatalf("workspace A build must pass its commit, got %q", got)
	}
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "bbbb2222", nil }
	if got := runComposeBuildCommitArg(t, composeDir, wsB, ""); got != "bbbb2222" {
		t.Fatalf("workspace B build must pass its commit, got %q", got)
	}

	if got := readBakedCommit(composeDir, cheaseeImageRef(wsA)); got.commit != "aaaa1111" {
		t.Errorf("workspace A's record must survive workspace B's build, got %+v", got)
	}
	if got := readBakedCommit(composeDir, cheaseeImageRef(wsB)); got.commit != "bbbb2222" {
		t.Errorf("workspace B must have its own record, got %+v", got)
	}
}

// TestComposeBuild_CaptureFailureIsSurfaced pins the audit remedy for the
// post-build read: with an empty cache-bust ARG the image is the only source
// of truth, so a failed (or empty) read must reach stderr and must not be
// recorded as if it were a known revision — a silent blank record is what left
// `about` reporting nothing with no warning.
func TestComposeBuild_CaptureFailureIsSurfaced(t *testing.T) {
	saved := resolveCheaseeCommit
	t.Cleanup(func() { resolveCheaseeCommit = saved })
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "", errors.New("network down") }
	t.Setenv("CHEASEE_REF", "main")

	for _, tc := range []struct {
		name string
		out  string
		err  error
	}{
		{name: "docker run fails", err: errors.New("no such image")},
		{name: "BUILD_COMMIT empty", out: "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			composeDir, workspace := t.TempDir(), t.TempDir()
			stderr := runComposeBuildCapture(t, composeDir, workspace, tc.out, tc.err)
			if !strings.Contains(stderr, "baked cheasee-pi commit") {
				t.Errorf("a failed read of the baked commit must be surfaced on stderr, got:\n%s", stderr)
			}
			if got := readBakedCommit(composeDir, cheaseeImageRef(workspace)); got.commit != "" {
				t.Errorf("a failed read must not record a commit, got %+v", got)
			}
		})
	}
}

// runComposeBuildCommitArg runs one composeBuild for `workspace` against a
// shared composeDir with the standard docker stubs and returns the
// CHEASEE_COMMIT it passed. imageOutput is what the capture probe reads back
// from the built image.
func runComposeBuildCommitArg(t *testing.T, composeDir, workspace, imageOutput string) string {
	t.Helper()
	stubStatfsAmple(t)
	var built *mockCmd
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		switch {
		case name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}"):
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("/var/lib/docker\n"), nil }}
		case name == "docker" && len(arg) > 0 && arg[0] == "run":
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(imageOutput), nil }}
		case name == "docker" && slices.Contains(arg, "compose"):
			built = &mockCmd{}
			return built
		}
		return &mockCmd{}
	})

	testutil.CaptureStderr(t, func() {
		if err := composeBuild(context.Background(), composeDir, workspace, "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
			t.Fatalf("composeBuild: %v", err)
		}
	})
	if built == nil {
		t.Fatal("no compose build invocation captured")
	}
	var hits []string
	for _, e := range built.env {
		if k, v, ok := strings.Cut(e, "="); ok && k == "CHEASEE_COMMIT" {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 {
		t.Fatalf("exactly one CHEASEE_COMMIT entry expected, got %v", hits)
	}
	return hits[0]
}

// runComposeBuildCapture runs one composeBuild whose post-build image read
// returns imageOutput/imageErr, and returns what the build wrote to stderr.
func runComposeBuildCapture(t *testing.T, composeDir, workspace, imageOutput string, imageErr error) string {
	t.Helper()
	stubStatfsAmple(t)
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		switch {
		case name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}"):
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("/var/lib/docker\n"), nil }}
		case name == "docker" && len(arg) > 0 && arg[0] == "run":
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(imageOutput), imageErr }}
		}
		return &mockCmd{}
	})

	return testutil.CaptureStderr(t, func() {
		if err := composeBuild(context.Background(), composeDir, workspace, "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
			t.Fatalf("composeBuild: %v", err)
		}
	})
}

func TestResolveCheaseeCommit_ParsesLsRemote(t *testing.T) {
	var gotName string
	var gotArg []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		gotName, gotArg = name, arg
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("1111111111111111111111111111111111111111\trefs/heads/feature-main\n2222222222222222222222222222222222222222\trefs/heads/main\n"), nil
		}}
	})

	got, err := resolveCheaseeCommitFn(context.Background(), "main")
	if err != nil {
		t.Fatalf("resolveCheaseeCommitFn: %v", err)
	}
	if got != "2222222222222222222222222222222222222222" {
		t.Errorf("must prefer the exact refs/heads/main match, got %q", got)
	}
	if gotName != "git" || len(gotArg) < 3 || gotArg[0] != "ls-remote" || gotArg[1] != cheaseePiRepoURL || gotArg[2] != "main" {
		t.Errorf("probe must run `git ls-remote %s main`, got %s %v", cheaseePiRepoURL, gotName, gotArg)
	}
}

// TestResolveCheaseeCommit_PeelsAnnotatedTag pins the annotated-tag case (#2054
// audit): ls-remote lists the tag object AND its peeled commit, and only the
// peeled hash is what `git clone --branch <tag>` checks out — so the tag object
// must never be returned, or the clone layer's HEAD comparison fails the build.
func TestResolveCheaseeCommit_PeelsAnnotatedTag(t *testing.T) {
	stubRunCommandContext(t, func(context.Context, string, ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("1111111111111111111111111111111111111111\trefs/tags/v1.2.3\n2222222222222222222222222222222222222222\trefs/tags/v1.2.3^{}\n"), nil
		}}
	})

	got, err := resolveCheaseeCommitFn(context.Background(), "v1.2.3")
	if err != nil {
		t.Fatalf("resolveCheaseeCommitFn: %v", err)
	}
	if got != "2222222222222222222222222222222222222222" {
		t.Errorf("annotated tag must resolve to its peeled commit, got %q (tag object?)", got)
	}
}

// TestResolveCheaseeCommit_LightweightTag pins that a tag with no peeled line
// (a lightweight tag points straight at the commit) still resolves.
func TestResolveCheaseeCommit_LightweightTag(t *testing.T) {
	stubRunCommandContext(t, func(context.Context, string, ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("3333333333333333333333333333333333333333\trefs/tags/v1.2.3\n"), nil
		}}
	})

	got, err := resolveCheaseeCommitFn(context.Background(), "v1.2.3")
	if err != nil {
		t.Fatalf("resolveCheaseeCommitFn: %v", err)
	}
	if got != "3333333333333333333333333333333333333333" {
		t.Errorf("lightweight tag must resolve to its commit, got %q", got)
	}
}

func TestResolveCheaseeCommit_ErrorsAreSurfaced(t *testing.T) {
	sentinel := errors.New("network down")
	stubRunCommandContext(t, func(context.Context, string, ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, sentinel }}
	})
	if _, err := resolveCheaseeCommitFn(context.Background(), "main"); !errors.Is(err, sentinel) {
		t.Errorf("probe failure must surface the git error, got %v", err)
	}
	// Empty output (e.g. an unknown ref) is an error, never a silent "".
	stubRunCommandContext(t, func(context.Context, string, ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("\n"), nil }}
	})
	if _, err := resolveCheaseeCommitFn(context.Background(), "main"); err == nil {
		t.Error("no ls-remote match must be an error, not a silent empty commit")
	}
}

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
