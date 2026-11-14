package main

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// The cobra adapter tests: runUpE stays a parse-only adapter, mutates no
// package global, and hands every flag to the use case verbatim.

func TestStartSession_sequentialRunsGetFreshEnv(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)

	type runResult struct {
		sessionID string
		reaper    string
	}
	run := func() runResult {
		exec := stubExecPIContainer(t)
		stubUpFlow(t, root, false)
		rec := recordDockerSeams(t)
		testutil.CaptureStderr(t, func() {
			if err := startSession(context.Background(), startOptions{Workdir: root}); err != nil {
				t.Fatalf("startSession: %v", err)
			}
		})
		reapers := rec.callsContaining("killing session")
		if len(reapers) != 1 {
			t.Fatalf("expected exactly one session reaper call, got %v", reapers)
		}
		return runResult{sessionID: exec.env["CHEASEE_SESSION_ID"], reaper: reapers[0]}
	}

	first := run()
	second := run()

	if first.sessionID == "" || second.sessionID == "" {
		t.Fatalf("both runs must carry a session marker, got %q and %q",
			first.sessionID, second.sessionID)
	}
	if first.sessionID == second.sessionID {
		t.Errorf("each run must mint its own session marker, both were %q", first.sessionID)
	}
	if !strings.Contains(first.reaper, "CHEASEE_SESSION_ID="+first.sessionID) {
		t.Errorf("run 1's reaper must join on its own marker, got %s", first.reaper)
	}
	if !strings.Contains(second.reaper, "CHEASEE_SESSION_ID="+second.sessionID) {
		t.Errorf("run 2's reaper must join on its own marker, got %s", second.reaper)
	}
	if strings.Contains(second.reaper, first.sessionID) {
		t.Error("run 2 must not reap run 1's session")
	}
}

func TestRunUpE_leavesTheNameGlobalUntouched(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	upName = "" // no --name on the command
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if upName != "" {
		t.Errorf("runUpE must not mutate upName, got %q", upName)
	}
	if exec.name != containerName(root) {
		t.Errorf("exec name = %q, want the derived %q", exec.name, containerName(root))
	}
}

func TestRunUpE_customNameReachesTheUseCaseVerbatim(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	cmd := &cobra.Command{}
	cmd.Flags().StringVar(&upName, "name", "", "container name override")
	if err := cmd.Flags().Set("name", "custom-name"); err != nil {
		t.Fatalf("set --name: %v", err)
	}

	testutil.CaptureStderr(t, func() {
		if err := runUpE(cmd, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if exec.name != "custom-name" {
		t.Errorf("exec name = %q, want the --name value verbatim", exec.name)
	}
	if upName != "custom-name" {
		t.Errorf("runUpE must not rewrite --name, got %q", upName)
	}
}

// sourceFuncBody returns the source text of one top-level function.
func sourceFuncBody(t *testing.T, file, name string) string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	src := string(data)
	start := strings.Index(src, "func "+name+"(")
	if start < 0 {
		t.Fatalf("%s: no func %s", file, name)
	}
	end := strings.Index(src[start:], "\n}\n")
	if end < 0 {
		t.Fatalf("%s: unterminated func %s", file, name)
	}
	return src[start : start+end]
}

func TestRunUpE_isAParseOnlyAdapter(t *testing.T) {
	body := sourceFuncBody(t, "up_run.go", "runUpE")
	if !strings.Contains(body, "startSession(") {
		t.Error("runUpE must delegate to startSession")
	}
	for _, banned := range []string{
		"docker", "execPIContainer", "ensureContainerReady", "scanOrphans",
		"codeflowHostPort", "upName =",
	} {
		if strings.Contains(body, banned) {
			t.Errorf("runUpE must stay a parse adapter, found %q in its body", banned)
		}
	}
}
