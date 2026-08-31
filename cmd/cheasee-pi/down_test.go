package main

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// stubDownFlow stubs the single exec seam for runDownE tests: project-container
// enumeration (docker ps) and the compose down invocation, capturing argv +
// env. git reads fall through to the real seam so fixture .bare remotes
// resolve.
func stubDownFlow(t *testing.T, psOutput string) (*mockCmd, *[]string) {
	t.Helper()
	composeCmd := &mockCmd{}
	composeArgs := &[]string{}
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			return saved(ctx, name, arg...)
		}
		if name == "docker" && slices.Contains(arg, "compose") {
			*composeArgs = append([]string(nil), arg...)
			return composeCmd
		}
		if name == "docker" && slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(psOutput), nil }}
		}
		return &mockCmd{}
	})
	return composeCmd, composeArgs
}

func TestRunDownE_targetsWorkspaceProjectOnly(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	parentA, rootA := mkWorkspace(t, `{}`) // project cheasee-pi-ws
	writeBareRemote(t, parentA, "https://github.com/alice/repo-a.git")
	chdir(t, rootA)

	composeCmd, composeArgs := stubDownFlow(t, "cheasee-pi-alice-repo-a\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runDownE: %v", err)
		}
	})

	if !slices.Contains(*composeArgs, "down") || !slices.Contains(*composeArgs, "-f") {
		t.Fatalf("compose down args wrong: %v", *composeArgs)
	}
	project := composeEnvValue(composeCmd.env, "COMPOSE_PROJECT_NAME")
	if project != "cheasee-pi-alice-repo-a" {
		t.Errorf("down must target the workspace's derived project, got %q (env %v)", project, composeCmd.env)
	}
	if !slices.Contains(composeCmd.env, "CHEASEEPI_CONTAINER=cheasee-pi-alice-repo-a") {
		t.Errorf("down env must carry the workspace container name, got %v", composeCmd.env)
	}
	if !strings.Contains(stderr, "Container stopped and removed") {
		t.Errorf("down must confirm removal, got %q", stderr)
	}
}

func TestRunDownE_parallelWorkspaceUntouched(t *testing.T) {
	// ws1's down must not carry ws2's project name (label-scoped compose down
	// cannot touch the sibling project's container).
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	parentA, rootA := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentA, "https://github.com/alice/repo-a.git")
	chdir(t, rootA)
	parentB, _ := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentB, "https://github.com/bob/repo-b.git")

	composeCmd, _ := stubDownFlow(t, "cheasee-pi-alice-repo-a\n")
	if err := runDownE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runDownE: %v", err)
	}
	if got := composeEnvValue(composeCmd.env, "COMPOSE_PROJECT_NAME"); got != "cheasee-pi-alice-repo-a" {
		t.Errorf("down must target ws1's project only, got %q", got)
	}
	if got := composeEnvValue(composeCmd.env, "COMPOSE_PROJECT_NAME"); got == "cheasee-pi-bob-repo-b" {
		t.Errorf("down must not target the sibling workspace's project, got %q", got)
	}
}

func TestRunDownE_noContainerNoop(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// cwd is a temp dir outside any workspace — the project derives from its
	// basename and nothing matches.
	chdir(t, t.TempDir())

	composeCalled := false
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "compose") {
			composeCalled = true
		}
		if name == "docker" && slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runDownE outside a workspace must not error, got %v", err)
		}
	})
	if composeCalled {
		t.Error("no-op down must not invoke compose")
	}
	if !strings.Contains(stderr, "nothing to stop") {
		t.Errorf("no-op down must say so, got %q", stderr)
	}
}

func TestRunDownE_legacyProjectNotTargeted(t *testing.T) {
	// Pre-derivation containers belong to the fixed project "cheasee-pi"; the
	// derived-project down no-ops instead of stopping them (documented shift).
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	chdir(t, t.TempDir())

	composeCalled := false
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "compose") {
			composeCalled = true
		}
		if name == "docker" && slices.Contains(arg, "ps") {
			// Only the legacy fixed-project container exists on the host.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})

	if err := runDownE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runDownE: %v", err)
	}
	if composeCalled {
		t.Error("derived-project down must not target the legacy fixed project")
	}
}

// composeEnvValue extracts a KEY=value entry from an env slice.
func composeEnvValue(env []string, key string) string {
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok && k == key {
			return v
		}
	}
	return ""
}

// chdir changes into dir for the test duration (serial suite — no
// t.Parallel).
func chdir(t *testing.T, dir string) {
	t.Helper()
	oldwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(oldwd) })
}
