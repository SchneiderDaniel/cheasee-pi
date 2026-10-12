package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

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
