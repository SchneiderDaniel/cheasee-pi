package main

import (
	"context"
	"os"
	"path/filepath"
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

func TestRunDownE_fromSubdirTargetsWorkspaceRoot(t *testing.T) {
	// down resolves the workspace root like start does: from a subdirectory
	// the ancestor holding cheasee-settings.json wins over the cwd — the
	// derived project and mounts target the workspace, not the subdir.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	parent, root := mkWorkspace(t, `{}`) // project cheasee-pi-alice-repo-a
	writeBareRemote(t, parent, "https://github.com/alice/repo-a.git")
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	chdir(t, sub)

	composeCmd, _ := stubDownFlow(t, "cheasee-pi-alice-repo-a\n")
	if err := runDownE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runDownE: %v", err)
	}
	if got := composeEnvValue(composeCmd.env, "COMPOSE_PROJECT_NAME"); got != "cheasee-pi-alice-repo-a" {
		t.Errorf("down from a subdir must target the workspace's derived project, got %q (env %v)", got, composeCmd.env)
	}
	if !slices.Contains(composeCmd.env, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("down from a subdir must mount the ancestor workspace root (not cwd), got %v", composeCmd.env)
	}
}
