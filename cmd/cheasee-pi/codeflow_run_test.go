package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
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

// TestCodeFlowServer_Run pins the on-demand headless run route and its state
// machine (issue #1983).
func TestCodeFlowServer_Run(t *testing.T) {
	t.Run("fresh status is idle with zeroed fields", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{})
		defer s.stop(t)

		st := s.runStatus(t)
		if st.State != "idle" || st.RunID != nil || st.StartedAt != nil || st.FinishedAt != nil ||
			st.Reason != nil || st.Error != nil || st.ReportAt != nil {
			t.Fatalf("idle status = %+v", st)
		}
		if st.Produced.Markdown || st.Produced.JSON {
			t.Fatalf("idle produced = %+v, want false/false", st.Produced)
		}
	})

	t.Run("idle run yields 202, single flight, completion fills both slots", func(t *testing.T) {
		counter := filepath.Join(t.TempDir(), "spawns")
		s := startRunShim(t, initRunRepo(t), map[string]any{
			"counter":  counter,
			"markdown": "# CodeFlow Analysis Report\n\nHEADLESS\n",
			"json":     `{"architectureIssues":[{"title":"x"}]}`,
			"sleep":    0.6,
		})
		defer s.stop(t)

		status, _, body := s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if status != http.StatusAccepted {
			t.Fatalf("POST run = %d, want 202\n%s", status, body)
		}
		var created struct {
			RunID     string `json:"runId"`
			State     string `json:"state"`
			StartedAt int64  `json:"startedAt"`
		}
		if err := json.Unmarshal(body, &created); err != nil {
			t.Fatalf("202 body: %v\n%s", err, body)
		}
		if created.RunID == "" || created.State != "running" || created.StartedAt <= 1_600_000_000_000 {
			t.Fatalf("202 body = %+v", created)
		}

		// Second POST while in flight: 409 with the same runId/startedAt, no spawn.
		status2, _, body2 := s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if status2 != http.StatusConflict {
			t.Fatalf("second POST = %d, want 409\n%s", status2, body2)
		}
		var conflict struct {
			RunID     string `json:"runId"`
			State     string `json:"state"`
			StartedAt int64  `json:"startedAt"`
		}
		if err := json.Unmarshal(body2, &conflict); err != nil {
			t.Fatalf("409 body: %v\n%s", err, body2)
		}
		if conflict.RunID != created.RunID || conflict.StartedAt != created.StartedAt || conflict.State != "running" {
			t.Fatalf("409 body = %+v, want same run as %+v", conflict, created)
		}

		st := s.waitTerminal(t, 20*time.Second)
		if st.State != "succeeded" || st.FinishedAt == nil || st.ReportAt == nil {
			t.Fatalf("terminal status = %+v", st)
		}
		if !st.Produced.Markdown || !st.Produced.JSON {
			t.Fatalf("produced = %+v, want both true", st.Produced)
		}
		if spawns, _ := os.ReadFile(counter); len(bytes.Split(bytes.TrimSpace(spawns), []byte("\n"))) != 1 {
			t.Fatalf("spawn count = %q, want exactly one", spawns)
		}

		code, hdr, md := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if code != http.StatusOK || !strings.Contains(string(md), "HEADLESS") {
			t.Fatalf("report = %d %q", code, md)
		}
		if got := hdr.Get("X-Codeflow-Analysis-At"); got != strconv.FormatInt(*st.ReportAt, 10) {
			t.Fatalf("X-Codeflow-Analysis-At = %q, want %d", got, *st.ReportAt)
		}
		codeJSON, hdrJSON, jsonBody := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if codeJSON != http.StatusOK || !strings.Contains(string(jsonBody), "architectureIssues") {
			t.Fatalf("json report = %d %q", codeJSON, jsonBody)
		}
		if got := hdrJSON.Get("X-Codeflow-Analysis-At"); got != strconv.FormatInt(*st.ReportAt, 10) {
			t.Fatalf("json X-Codeflow-Analysis-At = %q, want %d", got, *st.ReportAt)
		}
	})

	t.Run("markdown without JSON succeeds with the JSON slot empty", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{
			"markdown": "# CodeFlow Analysis Report\n\nMD\n",
		})
		defer s.stop(t)

		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/run", nil, ""); status != http.StatusAccepted {
			t.Fatalf("POST run status = %d, want 202", status)
		}
		st := s.waitTerminal(t, 20*time.Second)
		if st.State != "succeeded" || !st.Produced.Markdown || st.Produced.JSON {
			t.Fatalf("status = %+v, want succeeded md-only", st)
		}
		if status, _, _ := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, ""); status != http.StatusNotFound {
			t.Fatalf("json slot = %d, want 404", status)
		}
	})

	t.Run("empty markdown fails with no-markdown and writes no slot", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{"markdown": ""})
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		st := s.waitTerminal(t, 20*time.Second)
		if st.State != "failed" || st.Reason == nil || *st.Reason != "no-markdown" {
			t.Fatalf("status = %+v, want failed/no-markdown", st)
		}
		if st.Produced.Markdown || st.Produced.JSON || st.ReportAt != nil {
			t.Fatalf("produced/reportAt = %+v/%v, want false/nil", st.Produced, st.ReportAt)
		}
		if status, _, _ := s.do(t, http.MethodGet, "/api/analysis/report", nil, ""); status != http.StatusNotFound {
			t.Fatalf("md slot = %d, want 404", status)
		}
	})

	t.Run("nonzero exit fails analyzer-error, slots unchanged, error bounded", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{
			"exit":   3,
			"stderr": strings.Repeat("boom ", 2000),
		})
		defer s.stop(t)

		// Seed a slot so "unchanged" is meaningful.
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", []byte("OLD-MD"), "text/markdown"); status != http.StatusNoContent {
			t.Fatalf("seed post = %d", status)
		}
		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		st := s.waitTerminal(t, 20*time.Second)
		if st.State != "failed" || st.Reason == nil || *st.Reason != "analyzer-error" {
			t.Fatalf("status = %+v, want failed/analyzer-error", st)
		}
		if st.Error == nil || len(*st.Error) == 0 || len(*st.Error) > 4096 {
			t.Fatalf("error length = %d, want 1..4096", len(strOrEmpty(st.Error)))
		}
		if _, _, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, ""); string(body) != "OLD-MD" {
			t.Fatalf("slot changed to %q, want OLD-MD", body)
		}
	})

	t.Run("oversize artifact fails and never writes a slot", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{"markdown_size": maxReportBytes + 1})
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		st := s.waitTerminal(t, 30*time.Second)
		if st.State != "failed" || st.Reason == nil || *st.Reason != "analyzer-error" {
			t.Fatalf("status = %+v, want failed/analyzer-error", st)
		}
		if status, _, _ := s.do(t, http.MethodGet, "/api/analysis/report", nil, ""); status != http.StatusNotFound {
			t.Fatalf("md slot = %d, want 404", status)
		}
	})

	t.Run("analyzer unavailable is 503, state stays idle, no spawn", func(t *testing.T) {
		counter := filepath.Join(t.TempDir(), "spawns")
		missing := filepath.Join(t.TempDir(), "nope.py")
		s := startReportShimEnv(t, initRunRepo(t), t.TempDir(),
			"ANALYZER_CMD=python3 "+missing, "STUB_CONFIG="+filepath.Join(t.TempDir(), "x.json"))
		defer s.stop(t)

		status, _, body := s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if status != http.StatusServiceUnavailable {
			t.Fatalf("POST run = %d, want 503\n%s", status, body)
		}
		if !strings.Contains(string(body), "analyzer-unavailable") {
			t.Fatalf("503 body = %q", body)
		}
		if st := s.runStatus(t); st.State != "idle" {
			t.Fatalf("state = %s, want idle", st.State)
		}
		if _, err := os.Stat(counter); err == nil {
			t.Fatalf("spawned the analyzer despite unavailability")
		}
	})

	t.Run("timeout fails, kills the process group, and is safe to re-run", func(t *testing.T) {
		pidFile := filepath.Join(t.TempDir(), "pid")
		s := startRunShim(t, initRunRepo(t), map[string]any{
			"pid_file": pidFile,
			"sleep":    30,
			"markdown": "# CodeFlow Analysis Report\n\nLATE\n",
		}, "RUN_TIMEOUT_S=1")
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		st := s.waitTerminal(t, 20*time.Second)
		if st.State != "failed" || st.Reason == nil || *st.Reason != "timeout" {
			t.Fatalf("status = %+v, want failed/timeout", st)
		}
		raw, err := os.ReadFile(pidFile)
		if err != nil {
			t.Fatalf("stub did not record its pid: %v", err)
		}
		pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
		if pid <= 0 {
			t.Fatalf("stub pid = %q", raw)
		}
		// Give the OS a moment to reap the killed process.
		deadline := time.Now().Add(5 * time.Second)
		for {
			proc, _ := os.FindProcess(pid)
			if proc.Signal(syscall.Signal(0)) != nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("stub pid %d still alive after timeout kill", pid)
			}
			time.Sleep(100 * time.Millisecond)
		}
	})

	t.Run("snapshot is git archive HEAD and the temp dir is cleaned up", func(t *testing.T) {
		repo := initRunRepo(t)
		tmpRoot := t.TempDir()
		listing := filepath.Join(t.TempDir(), "listing")
		s := startRunShim(t, repo, map[string]any{
			"list_source": listing,
			"markdown":    "# CodeFlow Analysis Report\n\nSNAPSHOT\n",
		}, "TMPDIR="+tmpRoot)
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := s.waitTerminal(t, 20*time.Second); st.State != "succeeded" {
			t.Fatalf("status = %+v, want succeeded", st)
		}
		raw, err := os.ReadFile(listing)
		if err != nil {
			t.Fatalf("stub did not record the source listing: %v", err)
		}
		files := strings.Split(strings.TrimSpace(string(raw)), "\n")
		sort.Strings(files)
		if len(files) != 1 || files[0] != "committed.txt" {
			t.Fatalf("source snapshot = %v, want [committed.txt]", files)
		}
		entries, err := os.ReadDir(tmpRoot)
		if err != nil {
			t.Fatalf("read TMPDIR: %v", err)
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "codeflow-run-") {
				t.Fatalf("snapshot temp dir %q not removed", e.Name())
			}
		}
	})

	t.Run("committed symlink escaping the snapshot is never extracted or read", func(t *testing.T) {
		secret := filepath.Join(t.TempDir(), "secret.txt")
		if err := os.WriteFile(secret, []byte("TOP-SECRET"), 0600); err != nil {
			t.Fatalf("write secret: %v", err)
		}
		repo := initRunRepoSymlink(t, secret)
		listing := filepath.Join(t.TempDir(), "listing")
		readOut := filepath.Join(t.TempDir(), "read-link")
		s := startRunShim(t, repo, map[string]any{
			"list_source":   listing,
			"read_link":     "escape",
			"read_link_out": readOut,
			"markdown":      "# CodeFlow Analysis Report\n\nSYMLINK\n",
		})
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := s.waitTerminal(t, 20*time.Second); st.State != "succeeded" {
			t.Fatalf("status = %+v, want succeeded", st)
		}
		raw, err := os.ReadFile(listing)
		if err != nil {
			t.Fatalf("stub did not record the source listing: %v", err)
		}
		files := strings.Split(strings.TrimSpace(string(raw)), "\n")
		if len(files) != 1 || files[0] != "committed.txt" {
			t.Fatalf("source snapshot = %v, want [committed.txt] (escaping symlink dropped)", files)
		}
		if data, err := os.ReadFile(readOut); err == nil {
			t.Fatalf("escaping symlink was read: %q", data)
		}
	})

	t.Run("run status is isolated from bridge telemetry", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{"markdown": "# CodeFlow Analysis Report\n\nMD\n"})
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := s.waitTerminal(t, 20*time.Second); st.State != "succeeded" {
			t.Fatalf("status = %+v", st)
		}
		for route, e := range s.bridgeStatus(t) {
			if e.CapturedAt != nil || e.PostedAt != nil {
				t.Errorf("headless run polluted %s telemetry: %+v", route, e)
			}
		}
	})

	t.Run("slot write is atomic: new markdown is never paired with old JSON", func(t *testing.T) {
		// Seed both slots with the OLD pair, then run a producer that writes a
		// new pair. Readers fetch markdown first, then JSON; the run must never
		// expose new markdown while JSON is still the old pair.
		s := startRunShim(t, initRunRepo(t), map[string]any{
			"markdown": "# CodeFlow Analysis Report\n\nNEW\n",
			"json":     `{"architectureIssues":[{"title":"NEW"}]}`,
			"sleep":    0.3,
		})
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/report", []byte("# CodeFlow Analysis Report\n\nOLD\n"), "text/markdown")
		s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(`{"architectureIssues":[{"title":"OLD"}]}`), "text/plain")

		var wg sync.WaitGroup
		errs := make(chan error, 64)
		stop := make(chan struct{})
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					_, _, md := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
					if bytes.Contains(md, []byte("NEW")) {
						_, _, js := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
						if !bytes.Contains(js, []byte("NEW")) {
							errs <- fmt.Errorf("new markdown paired with stale JSON: %q", js)
							return
						}
					}
				}
			}()
		}
		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		s.waitTerminal(t, 20*time.Second)
		time.Sleep(200 * time.Millisecond)
		close(stop)
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Error(err)
		}
	})
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// TestCodeFlowServer_RunGuards pins method/path guards, restart amnesia and the
// config-driven timeout.
func TestCodeFlowServer_RunGuards(t *testing.T) {
	t.Run("wrong method/path combinations are 404", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{})
		defer s.stop(t)
		cases := []struct{ method, path string }{
			{http.MethodGet, "/api/analysis/run"},
			{http.MethodPost, "/api/analysis/run-status"},
		}
		for _, c := range cases {
			if status, _, _ := s.do(t, c.method, c.path, nil, ""); status != http.StatusNotFound {
				t.Errorf("%s %s = %d, want 404", c.method, c.path, status)
			}
		}
	})

	t.Run("restart loses run history", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{"markdown": "# CodeFlow Analysis Report\n\nMD\n"})
		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := s.waitTerminal(t, 20*time.Second); st.State != "succeeded" {
			t.Fatalf("status = %+v", st)
		}
		s.stop(t)

		fresh := startRunShim(t, initRunRepo(t), map[string]any{})
		defer fresh.stop(t)
		if st := fresh.runStatus(t); st.State != "idle" || st.RunID != nil {
			t.Fatalf("fresh status = %+v, want idle", st)
		}
	})

	t.Run("concurrent status polls during a run never tear", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), map[string]any{
			"markdown": "# CodeFlow Analysis Report\n\nMD\n",
			"sleep":    0.4,
		})
		defer s.stop(t)

		var wg sync.WaitGroup
		stop := make(chan struct{})
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				resp, err := s.client.Get(s.base + "/api/analysis/run-status")
				if err != nil {
					continue
				}
				body, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				var st runStatus
				if resp.StatusCode == http.StatusOK {
					if err := json.Unmarshal(body, &st); err != nil {
						t.Errorf("torn status: %v\n%s", err, body)
						return
					}
				}
			}
		}()
		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		s.waitTerminal(t, 20*time.Second)
		close(stop)
		wg.Wait()
	})

	t.Run("config.json run_timeout_s is read and absent falls back to the default", func(t *testing.T) {
		// Configured 1s: the sleeping stub times out.
		cfgFile := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(cfgFile, []byte(`{"run_timeout_s": 1}`), 0644); err != nil {
			t.Fatalf("write config: %v", err)
		}
		cmd, stubCfg := writeStubAnalyzer(t, map[string]any{"sleep": 30, "markdown": "# CodeFlow Analysis Report\n\nLATE\n"})
		short := startShimFull(t, initRunRepo(t), t.TempDir(), cfgFile,
			"ANALYZER_CMD="+cmd, "STUB_CONFIG="+stubCfg)
		defer short.stop(t)
		short.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := short.waitTerminal(t, 20*time.Second); st.State != "failed" || st.Reason == nil || *st.Reason != "timeout" {
			t.Fatalf("configured timeout status = %+v, want failed/timeout", st)
		}

		// Absent key: the default (600s) lets a short sleep finish.
		cmd2, stubCfg2 := writeStubAnalyzer(t, map[string]any{"sleep": 0.2, "markdown": "# CodeFlow Analysis Report\n\nMD\n"})
		empty := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(empty, []byte(`{}`), 0644); err != nil {
			t.Fatalf("write config: %v", err)
		}
		long := startShimFull(t, initRunRepo(t), t.TempDir(), empty,
			"ANALYZER_CMD="+cmd2, "STUB_CONFIG="+stubCfg2)
		defer long.stop(t)
		long.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := long.waitTerminal(t, 20*time.Second); st.State != "succeeded" {
			t.Fatalf("default timeout status = %+v, want succeeded", st)
		}
	})
}

// TestCodeFlowServer_RunJsonPassthrough pins that the headless producer's rich
// JSON reaches the slot verbatim, bypassing the browser-POST guard, and can
// replace an accepted empty slot (issue #1993, acceptance #3).
func TestCodeFlowServer_RunJsonPassthrough(t *testing.T) {
	const richRunJSON = `{"architectureIssues":[{"title":"a"}],"duplicates":[{"files":["x","y"]}],"layerViolations":[{"from":"UI","to":"DB"}],"suggestions":[{"text":"split"}]}`
	cfg := map[string]any{
		"markdown": "# CodeFlow Analysis Report\n\n### Run finding\n",
		"json":     richRunJSON,
	}

	t.Run("run fills json with all JSON-only categories", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), cfg)
		defer s.stop(t)

		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := s.waitTerminal(t, 20*time.Second); st.State != "succeeded" {
			t.Fatalf("status = %+v, want succeeded", st)
		}
		status, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if status != http.StatusOK || string(body) != richRunJSON {
			t.Fatalf("json report = %d %q", status, body)
		}
		for _, key := range []string{"duplicates", "layerViolations", "suggestions"} {
			if !strings.Contains(string(body), key) {
				t.Errorf("json report missing %q", key)
			}
		}
		if e := s.bridgeStatus(t)["/api/analysis/report.json"]; e.RejectedAt != nil || e.RejectReason != nil {
			t.Errorf("run path set rejection telemetry: %+v", e)
		}
	})

	t.Run("run replaces an accepted empty json slot", func(t *testing.T) {
		s := startRunShim(t, initRunRepo(t), cfg)
		defer s.stop(t)

		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(`{"architectureIssues":[]}`), "application/json"); status != http.StatusNoContent {
			t.Fatalf("seed empty json = %d, want 204", status)
		}
		s.do(t, http.MethodPost, "/api/analysis/run", nil, "")
		if st := s.waitTerminal(t, 20*time.Second); st.State != "succeeded" {
			t.Fatalf("status = %+v", st)
		}
		status, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if status != http.StatusOK || string(body) != richRunJSON {
			t.Fatalf("json report = %d %q, want run payload", status, body)
		}
	})
}
