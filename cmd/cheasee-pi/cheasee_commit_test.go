package main

import (
	"bytes"
	"context"
	"errors"
	"io"
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
	buildCommit := func() string {
		t.Helper()
		testutil.CaptureStderr(t, func() {
			if err := composeBuild(context.Background(), composeDir, t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
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
	t.Setenv("CHEASEE_REF", "main")
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "abc123", nil }
	if got := runComposeBuildCommitArg(t, composeDir, ""); got != "abc123" {
		t.Fatalf("main build must pass the resolved commit, got %q", got)
	}

	t.Setenv("CHEASEE_REF", "v2.0.0")
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "", errors.New("network down") }
	if got := runComposeBuildCommitArg(t, composeDir, ""); got != "" {
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
	if got := runComposeBuildCommitArg(t, composeDir, "baked999\n"); got != "" {
		t.Fatalf("failed first-build probe must pass an empty cache-bust input, got %q", got)
	}
	if got := readBakedCommit(composeDir); got.ref != "main" || got.commit != "baked999" {
		t.Errorf("baked commit must be captured from the built image, got %+v", got)
	}
}

// runComposeBuildCommitArg runs one composeBuild against a shared composeDir
// with the standard docker stubs and returns the CHEASEE_COMMIT it passed.
// imageOutput is what the capture probe reads back from the built image.
func runComposeBuildCommitArg(t *testing.T, composeDir, imageOutput string) string {
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
		if err := composeBuild(context.Background(), composeDir, t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
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

func TestAbout_reportsBakedCommitValue(t *testing.T) {
	// about must surface the actual baked SHA (audit finding, issue #2054), not
	// just the file path. readBakedCommit consumes what recordBakedCommit
	// writes; point aboutCacheDir at a temp dir and seed that record.
	saved := aboutCacheDir
	dir := t.TempDir()
	aboutCacheDir = func() (string, error) { return dir, nil }
	t.Cleanup(func() { aboutCacheDir = saved })
	if err := atomicWrite(filepath.Join(dir, cheaseeCommitCacheFile), []byte("main cafebabe\n"), 0644, false); err != nil {
		t.Fatalf("seed baked commit: %v", err)
	}

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
	if !strings.Contains(aboutText, "/opt/cheasee-pi/BUILD_COMMIT") {
		t.Errorf("about must report where the baked cheasee-pi commit is recorded\n--- about text:\n%s", aboutText)
	}
}

// TestAbout_omitsCommitWithoutBuildRecord pins that an unbuilt machine shows
// no commit line rather than a bogus one.
func TestAbout_omitsCommitWithoutBuildRecord(t *testing.T) {
	saved := aboutCacheDir
	aboutCacheDir = func() (string, error) { return t.TempDir(), nil }
	t.Cleanup(func() { aboutCacheDir = saved })

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

func TestDocs_BakedCloneRefreshPolicy(t *testing.T) {
	src := readRepoFile(t, filepath.Join("docs", "installation.md"))
	for _, want := range []string{"CHEASEE_COMMIT", "/opt/cheasee-pi/BUILD_COMMIT"} {
		if !strings.Contains(src, want) {
			t.Errorf("docs/installation.md must document the baked-clone refresh policy (%q)", want)
		}
	}
}
