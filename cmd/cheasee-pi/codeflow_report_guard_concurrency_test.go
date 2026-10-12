package main

import (
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

// TestCodeFlowServer_ConcurrentGuard pins that concurrent guarded posts and
// reads never tear or store an empty body (issue #1993).
func TestCodeFlowServer_ConcurrentGuard(t *testing.T) {
	s := startReportShim(t, t.TempDir(), t.TempDir())
	defer s.stop(t)
	s.seedMarkdown(t, richMD)
	s.seedJSON(t, richJSON)

	const n = 20
	valid := make([][]byte, n)
	set := map[string]bool{richJSON: true}
	for i := range valid {
		valid[i] = []byte(fmt.Sprintf(`{"architectureIssues":[{"title":"v%02d"}]}`, i))
		set[string(valid[i])] = true
	}

	var wg sync.WaitGroup
	errs := make(chan error, n*2+64)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json"); status != http.StatusConflict {
				errs <- fmt.Errorf("empty post = %d, want 409", status)
			}
			if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", valid[i], "application/json"); status != http.StatusNoContent {
				errs <- fmt.Errorf("rich post = %d, want 204", status)
			}
		}(i)
	}
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := 0; k < 5; k++ {
				status, hdr, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
				if status != http.StatusOK {
					continue
				}
				if hdr.Get("Content-Length") != strconv.Itoa(len(body)) {
					errs <- fmt.Errorf("Content-Length %q != body len %d", hdr.Get("Content-Length"), len(body))
					return
				}
				if !set[string(body)] {
					errs <- fmt.Errorf("torn/empty body: %q", body)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

// TestCodeFlowServer_ConcurrentGuardFromEmpty starts both slots empty and
// races empty stubs against rich JSON posts. The consistency check and the
// slot write must share one lock hold: a stub that checks before a rich body
// stores must not then overwrite it (issue #1993 audit).
func TestCodeFlowServer_ConcurrentGuardFromEmpty(t *testing.T) {
	// A tight GIL switch interval makes the interleaving frequent enough to
	// exercise the guard's check-then-store window on every run.
	s := startReportShimEnv(t, t.TempDir(), t.TempDir(), "CF_SWITCH_INTERVAL=0.00005")
	defer s.stop(t)

	const n = 20
	rich := make([][]byte, n)
	set := map[string]bool{}
	for i := range rich {
		rich[i] = []byte(fmt.Sprintf(`{"architectureIssues":[{"title":"r%02d"}]}`, i))
		set[string(rich[i])] = true
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	var richSeen atomic.Bool
	errs := make(chan error, n+64)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			// A stub is accepted only while no finding-carrying body is stored,
			// so 204 before and 409 after a rich post are both correct.
			status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json")
			if status != http.StatusNoContent && status != http.StatusConflict {
				errs <- fmt.Errorf("empty post = %d, want 204 or 409", status)
			}
			if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", rich[i], "application/json"); status != http.StatusNoContent {
				errs <- fmt.Errorf("rich post = %d, want 204", status)
			}
		}(i)
	}
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for k := 0; k < 10; k++ {
				status, hdr, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
				if status == http.StatusNotFound {
					continue // nothing stored yet
				}
				if status != http.StatusOK {
					errs <- fmt.Errorf("get = %d, want 200/404", status)
					return
				}
				if hdr.Get("Content-Length") != strconv.Itoa(len(body)) {
					errs <- fmt.Errorf("Content-Length %q != body len %d", hdr.Get("Content-Length"), len(body))
					return
				}
				switch {
				case set[string(body)]:
					richSeen.Store(true)
				case string(body) == emptyJSON:
					// A stub is legal until a rich body lands; after that it can only
					// be a lost update.
					if richSeen.Load() {
						errs <- fmt.Errorf("stub stored after a rich body: %q", body)
						return
					}
				default:
					errs <- fmt.Errorf("torn/unknown body: %q", body)
					return
				}
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}

	// Every rich post lands, so the final slot must be one of them — never a
	// stub that could only have stored while both slots were still empty.
	status, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
	if status != http.StatusOK || !set[string(body)] {
		t.Fatalf("final slot = %d %q, want a rich payload", status, body)
	}
}
