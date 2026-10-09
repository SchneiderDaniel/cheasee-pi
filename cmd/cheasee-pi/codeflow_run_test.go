package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeFakeRunner writes a python stand-in for report-runner.js. It records the
// checkout listing the shim handed it (proving the committed-HEAD snapshot) and
// writes the two artifacts the shim expects. `exitCode`/`message` drive the
// failure path; `sleep` holds the run open for the concurrency case.
func writeFakeRunner(t *testing.T, exitCode int, message string, sleep float64) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-runner.py")
	script := fmt.Sprintf(`import os, sys, time
args = sys.argv[1:]
tree = args[args.index("--path") + 1]
out = args[args.index("--out") + 1]
if %f:
    time.sleep(%f)
if %d != 0:
    sys.stderr.write(%q + "\n")
    sys.exit(%d)
os.makedirs(out, exist_ok=True)
names = sorted(os.listdir(tree))
with open(os.path.join(out, "codeflow-report.md"), "w") as fh:
    fh.write("# CodeFlow Analysis Report\n\n" + ",".join(names) + "\n")
with open(os.path.join(out, "codeflow-report.json"), "w") as fh:
    fh.write('{"architectureIssues":[]}')
`, sleep, sleep, exitCode, message, exitCode)
	if err := os.WriteFile(path, []byte(script), 0644); err != nil {
		t.Fatalf("write fake runner: %v", err)
	}
	return path
}

// startRunShim boots a shim wired to the given fake runner against a git repo
// holding one committed file and one untracked file.
func startRunShim(t *testing.T, runner string) *reportShim {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	repoRoot := t.TempDir()
	initGitRepo(t, repoRoot)
	writeFile(t, repoRoot, "tracked.txt", "t\n")
	gitAddAll(t, repoRoot)
	gitCommit(t, repoRoot)
	writeFile(t, repoRoot, "untracked.txt", "u\n")
	return startReportShim(t, repoRoot, writeUIDir(t),
		"CODEFLOW_NODE="+python,
		"CODEFLOW_RUNNER="+runner,
	)
}

// waitRunState polls the run status until it reports want.
func waitRunState(t *testing.T, s *reportShim, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var last map[string]any
	for time.Now().Before(deadline) {
		code, _, body := s.do(t, "GET", "/api/analysis/run-status", nil, "")
		if code != 200 {
			t.Fatalf("run-status = HTTP %d (%s)", code, body)
		}
		if err := json.Unmarshal(body, &last); err != nil {
			t.Fatalf("run-status JSON: %v (%s)", err, body)
		}
		if last["state"] == want {
			return last
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("run never reached %q; last status %v", want, last)
	return nil
}

// TestCodeFlowServer_RunRoute covers the happy path: POST starts the run, the
// status reaches done, and both report slots then serve the runner's artifacts.
func TestCodeFlowServer_RunRoute(t *testing.T) {
	s := startRunShim(t, writeFakeRunner(t, 0, "", 0))
	defer s.stop(t)

	code, _, body := s.do(t, "POST", "/api/analysis/run", nil, "")
	if code != 202 {
		t.Fatalf("POST run = HTTP %d (%s), want 202", code, body)
	}
	status := waitRunState(t, s, "done")
	if status["error"] != nil {
		t.Fatalf("run recorded an error: %v", status["error"])
	}

	code, headers, body := s.do(t, "GET", "/api/analysis/report", nil, "")
	if code != 200 {
		t.Fatalf("report = HTTP %d (%s)", code, body)
	}
	if headers.Get("X-Codeflow-Analysis-At") == "" {
		t.Error("report is missing X-Codeflow-Analysis-At")
	}
	// The runner sees the committed HEAD checkout, never the working tree.
	if !strings.Contains(string(body), "tracked.txt") {
		t.Errorf("report does not list the committed file: %s", body)
	}
	if strings.Contains(string(body), "untracked.txt") {
		t.Errorf("runner analyzed the working tree, not HEAD: %s", body)
	}

	code, _, body = s.do(t, "GET", "/api/analysis/report.json", nil, "")
	if code != 200 || !strings.Contains(string(body), "architectureIssues") {
		t.Fatalf("json report = HTTP %d (%s)", code, body)
	}
}

// TestCodeFlowServer_RunRouteFailure covers a crashing runner: the status turns
// to error with the runner's message and no report is published.
func TestCodeFlowServer_RunRouteFailure(t *testing.T) {
	s := startRunShim(t, writeFakeRunner(t, 1, "runner boom", 0))
	defer s.stop(t)

	if code, _, body := s.do(t, "POST", "/api/analysis/run", nil, ""); code != 202 {
		t.Fatalf("POST run = HTTP %d (%s), want 202", code, body)
	}
	status := waitRunState(t, s, "error")
	if got := fmt.Sprint(status["error"]); !strings.Contains(got, "runner boom") {
		t.Fatalf("run error = %q, want the runner's message", got)
	}

	if code, _, _ := s.do(t, "GET", "/api/analysis/report", nil, ""); code != 404 {
		t.Fatalf("report after a failed run = HTTP %d, want 404", code)
	}
	if code, _, _ := s.do(t, "GET", "/api/analysis/run-status", nil, ""); code != 200 {
		t.Fatalf("run-status after failure = HTTP %d, want 200", code)
	}
}

// TestCodeFlowServer_RunRouteConcurrent covers the single-slot guard: a second
// POST while a run is in flight is refused instead of queueing another analysis.
func TestCodeFlowServer_RunRouteConcurrent(t *testing.T) {
	s := startRunShim(t, writeFakeRunner(t, 0, "", 2))
	defer s.stop(t)

	if code, _, body := s.do(t, "POST", "/api/analysis/run", nil, ""); code != 202 {
		t.Fatalf("first POST run = HTTP %d (%s), want 202", code, body)
	}
	if code, _, body := s.do(t, "POST", "/api/analysis/run", nil, ""); code != 409 {
		t.Fatalf("second POST run = HTTP %d (%s), want 409", code, body)
	}
	waitRunState(t, s, "done")
}
