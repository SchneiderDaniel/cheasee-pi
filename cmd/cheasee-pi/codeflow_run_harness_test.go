package main

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// stubAnalyzerScript is a minimal stand-in for run-analysis.mjs. Behaviour is
// configured per shim through a JSON file pointed at by STUB_CONFIG, so one
// script drives every run-route test. It never touches the network; it only
// consumes argv (sourceDir, uiDir, outDir) and emits report artifacts.
const stubAnalyzerScript = `import json, os, sys, time
src, ui, out = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {}
p = os.environ.get("STUB_CONFIG")
if p and os.path.exists(p):
    cfg = json.load(open(p))
if cfg.get("counter"):
    open(cfg["counter"], "a").write("x\n")
if cfg.get("list_source"):
    entries = []
    for root, dirs, files in os.walk(src):
        for f in files:
            entries.append(os.path.relpath(os.path.join(root, f), src))
    open(cfg["list_source"], "w").write("\n".join(sorted(entries)))
if cfg.get("read_link"):
    p = os.path.join(src, cfg["read_link"])
    if os.path.lexists(p):
        try:
            open(cfg["read_link_out"], "w").write(open(p).read())
        except OSError as e:
            open(cfg["read_link_out"], "w").write("ERR:" + str(e))
if cfg.get("pid_file"):
    open(cfg["pid_file"], "w").write(str(os.getpid()))
if cfg.get("sleep"):
    time.sleep(cfg["sleep"])
if cfg.get("stderr"):
    sys.stderr.write(cfg["stderr"])
if cfg.get("exit"):
    sys.exit(cfg["exit"])
md = cfg.get("markdown", "MD")
if md is not None:
    open(os.path.join(out, "report.md"), "w").write(md)
if cfg.get("markdown_size"):
    open(os.path.join(out, "report.md"), "w").write("x" * cfg["markdown_size"])
js = cfg.get("json")
if js:
    open(os.path.join(out, "report.json"), "w").write(js)
if cfg.get("envelope", True):
    print(json.dumps({"markdown": "report.md", "json": ("report.json" if js else None), "analyzedAt": int(time.time() * 1000)}))
`

func writeStubAnalyzer(t *testing.T, cfg map[string]any) (cmd string, cfgDir string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "stub.py")
	if err := os.WriteFile(script, []byte(stubAnalyzerScript), 0644); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	cfgPath := filepath.Join(dir, "stub.json")
	blob, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal stub config: %v", err)
	}
	if err := os.WriteFile(cfgPath, blob, 0644); err != nil {
		t.Fatalf("write stub config: %v", err)
	}
	return "python3 " + script, cfgPath
}

// startRunShim starts a shim wired to the stub analyzer with the given config.
func startRunShim(t *testing.T, repoRoot string, cfg map[string]any, extraEnv ...string) *reportShim {
	t.Helper()
	cmd, cfgPath := writeStubAnalyzer(t, cfg)
	env := []string{"ANALYZER_CMD=" + cmd, "STUB_CONFIG=" + cfgPath, "RUN_TIMEOUT_S=5"}
	env = append(env, extraEnv...)
	return startReportShimEnv(t, repoRoot, t.TempDir(), env...)
}

func initRunRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	git := gitInit(t, root)
	git("init", "-q")
	git("config", "user.email", "t@t")
	git("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(root, "committed.txt"), []byte("yes"), 0644); err != nil {
		t.Fatalf("write committed file: %v", err)
	}
	git("add", "committed.txt")
	git("commit", "-q", "-m", "init")
	if err := os.WriteFile(filepath.Join(root, "untracked.txt"), []byte("no"), 0644); err != nil {
		t.Fatalf("write untracked file: %v", err)
	}
	return root
}

// gitInit returns a git runner bound to a temp repo root with deterministic
// committer/author identities.
func gitInit(t *testing.T, root string) func(args ...string) {
	t.Helper()
	return func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

// initRunRepoSymlink commits a symlink named "escape" pointing at linkTarget.
func initRunRepoSymlink(t *testing.T, linkTarget string) string {
	t.Helper()
	root := t.TempDir()
	git := gitInit(t, root)
	git("init", "-q")
	git("config", "user.email", "t@t")
	git("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(root, "committed.txt"), []byte("yes"), 0644); err != nil {
		t.Fatalf("write committed file: %v", err)
	}
	if err := os.Symlink(linkTarget, filepath.Join(root, "escape")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	git("add", "-A")
	git("commit", "-q", "-m", "init")
	return root
}

type runStatus struct {
	RunID      *string `json:"runId"`
	State      string  `json:"state"`
	StartedAt  *int64  `json:"startedAt"`
	FinishedAt *int64  `json:"finishedAt"`
	Reason     *string `json:"reason"`
	Error      *string `json:"error"`
	ReportAt   *int64  `json:"reportAt"`
	Produced   struct {
		Markdown bool `json:"markdown"`
		JSON     bool `json:"json"`
	} `json:"produced"`
}

func (s *reportShim) runStatus(t *testing.T) runStatus {
	t.Helper()
	status, _, body := s.do(t, http.MethodGet, "/api/analysis/run-status", nil, "")
	if status != http.StatusOK {
		t.Fatalf("run-status = %d, want 200\n%s", status, body)
	}
	var out runStatus
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("run-status is not JSON: %v\n%s", err, body)
	}
	return out
}

func (s *reportShim) waitTerminal(t *testing.T, timeout time.Duration) runStatus {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		st := s.runStatus(t)
		if st.State == "succeeded" || st.State == "failed" {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("run did not terminate within %s (state=%s)", timeout, st.State)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
