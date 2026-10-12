package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

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
