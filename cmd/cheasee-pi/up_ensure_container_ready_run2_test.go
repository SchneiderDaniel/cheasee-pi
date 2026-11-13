package main

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRunUpE_runningStaleSidecarWarnsAndProceeds(t *testing.T) {
	// runUpE on a running container with a stale sidecar: succeeds, exec
	// still targets the MAIN container, the warning lands on stderr, and
	// the compose count stays zero.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	staleCache := filepath.Join(t.TempDir(), "cheasee-pi", "0.54.0")
	staleJSON := mustJSON(codeflowInspectDoc(staleCache, strings.Repeat("0", 64), "9000"))
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "inspect") {
			if slices.Contains(arg, "{{json .}}") {
				return codeflowInspectRunner(staleJSON)
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		if slices.Contains(arg, "port") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("0.0.0.0:9000"), nil }}
		}
		return &mockCmd{}
	})
	c.states = allStackStates(root, "running")

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if len(c.composeArgs) != 0 {
		t.Errorf("running container must skip compose even with a stale sidecar, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
	if exec.name != containerName(root) {
		t.Errorf("exec must still target the main container, got name=%q", exec.name)
	}
	if !strings.Contains(stderr, "stale") || !strings.Contains(stderr, "cheasee-pi start --build") {
		t.Errorf("stale sidecar must warn with the recovery command, got: %q", stderr)
	}
}
