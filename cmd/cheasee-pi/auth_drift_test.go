package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Phase 5: credential drift warning (stderr-observable)
//
// `cheasee-pi start` must stay zero-compose on the all-running path, so a
// credential change the running container cannot see (file-backed consumers are
// pinned to the inode resolved at creation) surfaces as a warning carrying the
// exact recovery command — never an implicit recreate.
// ──────────────────────────────────────────────

// fixtureAuthPath writes the host credential fixture the drift tests stamp and
// returns its path.
func fixtureAuthPath(t *testing.T) string {
	t.Helper()
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"github_token":"`+FakeGitHubToken+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWarnIfAuthDrift_MatchingSilent(t *testing.T) {
	path := fixtureAuthPath(t)
	_, root := mkWorkspace(t, `{}`)
	stubDockerInspect(t, authInspectJSON(authInspectDoc(liveAuthSpec(t, path))), nil)

	stderr := testutil.CaptureStderr(t, func() {
		warnIfAuthDrift(context.Background(), root)
	})
	if stderr != "" {
		t.Errorf("a container created from the current credentials must be silent, got: %q", stderr)
	}
}

func TestWarnIfAuthDrift_MissingLabelWarns(t *testing.T) {
	// The pre-change container (label-less, credential DIRECTORIES mounted
	// read-write) is exactly the state this feature must surface.
	fixtureAuthPath(t)
	_, root := mkWorkspace(t, `{}`)
	stubDockerInspect(t, authInspectJSON(authInspectDoc("")), nil)

	stderr := testutil.CaptureStderr(t, func() {
		warnIfAuthDrift(context.Background(), root)
	})
	if !strings.Contains(stderr, "cheasee-pi start --build") {
		t.Errorf("missing credential stamp must name the recovery command, got: %q", stderr)
	}
	if !strings.Contains(strings.ToLower(stderr), "credential") {
		t.Errorf("warning must name the stale credential state, got: %q", stderr)
	}
}

func TestWarnIfAuthDrift_StampMismatchWarns(t *testing.T) {
	// The credential file was rewritten (atomicWrite → new inode) after the
	// container was created: the running container still reads the old file.
	path := fixtureAuthPath(t)
	if err := atomicWrite(path, []byte(`{"github_token":"`+FakeGitHubToken+`","extra":true}`), 0600, false); err != nil {
		t.Fatal(err)
	}
	_, root := mkWorkspace(t, `{}`)
	stubDockerInspect(t, authInspectJSON(authInspectDoc("0123456789abcdef")), nil)

	stderr := testutil.CaptureStderr(t, func() {
		warnIfAuthDrift(context.Background(), root)
	})
	if !strings.Contains(stderr, "cheasee-pi start --build") {
		t.Errorf("stamp mismatch must name the recovery command, got: %q", stderr)
	}
	if !strings.Contains(strings.ToLower(stderr), "credential") {
		t.Errorf("warning must name the stale credential state, got: %q", stderr)
	}
}

func TestWarnIfAuthDrift_MissingContainerWarns(t *testing.T) {
	fixtureAuthPath(t)
	_, root := mkWorkspace(t, `{}`)
	stubDockerInspect(t, "Error: No such object: "+containerName(root), exitStatusError(1))

	stderr := testutil.CaptureStderr(t, func() {
		warnIfAuthDrift(context.Background(), root)
	})
	if strings.TrimSpace(stderr) == "" {
		t.Fatal("a missing container must warn, not stay silent")
	}
	if !strings.Contains(stderr, "cheasee-pi start --build") {
		t.Errorf("missing container warning must name the recovery command, got: %q", stderr)
	}
}

func TestWarnIfAuthDrift_InspectErrorNonFatal(t *testing.T) {
	fixtureAuthPath(t)
	_, root := mkWorkspace(t, `{}`)
	stubDockerInspect(t, "Cannot connect to the Docker daemon", exitStatusError(1))

	stderr := testutil.CaptureStderr(t, func() {
		// No error return: an unverifiable check is a warning, never a start
		// failure.
		warnIfAuthDrift(context.Background(), root)
	})
	if !strings.Contains(strings.ToLower(stderr), "could not verify") {
		t.Errorf("inspect failure must degrade to a visible 'could not verify' warning, got: %q", stderr)
	}
}

func TestWarnIfAuthDrift_NoComposeInvocation(t *testing.T) {
	// Zero-compose contract on the running path: drift detection may only
	// READ (`docker inspect`), never build/recreate.
	path := fixtureAuthPath(t)
	_, root := mkWorkspace(t, `{}`)
	var calls [][]string
	saved := runCommandContext
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" {
			calls = append(calls, append([]string{name}, arg...))
			if len(arg) > 0 && arg[0] == "inspect" {
				return &mockCmd{combinedFn: func() ([]byte, error) {
					return []byte(authInspectJSON(authInspectDoc(liveAuthSpec(t, path)))), nil
				}}
			}
		}
		return saved(context.Background(), name, arg...)
	})

	_ = testutil.CaptureStderr(t, func() {
		warnIfAuthDrift(context.Background(), root)
	})
	if len(calls) == 0 {
		t.Fatal("drift check must inspect the running container")
	}
	for _, argv := range calls {
		if slices.Contains(argv, "compose") {
			t.Errorf("drift check must never invoke compose, got %v", argv)
		}
	}
}

func TestWarnIfAuthDrift_NoSecretInOutput(t *testing.T) {
	// Warnings name files, stamps and recovery commands — never values.
	path := fixtureAuthPath(t)
	_, root := mkWorkspace(t, `{}`)
	stubDockerInspect(t, authInspectJSON(authInspectDoc("stale")), nil)

	_ = path
	stderr := testutil.CaptureStderr(t, func() {
		warnIfAuthDrift(context.Background(), root)
	})
	if strings.Contains(stderr, FakeGitHubToken) {
		t.Errorf("drift warning must never print the credential value, got: %q", stderr)
	}
}

func TestWarnIfAuthDrift_StoppedContainerWarns(t *testing.T) {
	// The stamp is creation-time metadata, readable on a stopped container —
	// which is precisely the one a start reuses as-is (issue #2076 audit).
	fixtureAuthPath(t)
	_, root := mkWorkspace(t, `{}`)
	doc := authInspectDoc("0123456789abcdef")
	doc["State"] = map[string]any{"Running": false}
	stubDockerInspect(t, authInspectJSON(doc), nil)

	stderr := testutil.CaptureStderr(t, func() {
		warnIfAuthDrift(context.Background(), root)
	})
	wantSubstrings(t, stderr, authRecoveryHint, "auth.json")
}
