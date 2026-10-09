package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Report fixtures for the JSON-slot guard (issue #1993). `richMD`/`richJSON`
// carry findings; `emptyJSON`/`emptyAllJSON` are structurally empty stubs.
const (
	richMD         = "# CodeFlow Analysis Report\n\n## Architecture Issues\n\n### Circular dependency\n\n- **Affected:** src/a.ts -> src/b.ts\n"
	cleanMD        = "# CodeFlow Analysis Report\n\n## Architecture Issues\n\nNo architecture issues found.\n"
	markerMD       = "# CodeFlow Analysis Report\n"
	emptySectionMD = "# CodeFlow Analysis Report\n\n## Architecture Issues\n\n## Security Issues\n"
	emptyJSON      = `{"architectureIssues":[]}`
	emptyAllJSON   = `{"architectureIssues":[],"duplicates":[],"layerViolations":[],"suggestions":[]}`
	richJSON       = `{"architectureIssues":[{"title":"a","affectedFiles":["src/a.ts"]}],"duplicates":[{"files":["src/a.ts","src/b.ts"]}],"layerViolations":[{"from":"UI","to":"DB"}],"suggestions":[{"text":"split module"}]}`
	richJSON2      = `{"architectureIssues":[{"title":"b"}],"duplicates":[{"files":["src/c.ts","src/d.ts"]}],"layerViolations":[],"suggestions":[]}`
)

func (s *reportShim) seedMarkdown(t *testing.T, body string) {
	t.Helper()
	if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", []byte(body), "text/markdown"); status != http.StatusNoContent {
		t.Fatalf("seed markdown = %d, want 204", status)
	}
}

func (s *reportShim) seedJSON(t *testing.T, body string) {
	t.Helper()
	if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(body), "application/json"); status != http.StatusNoContent {
		t.Fatalf("seed json = %d, want 204", status)
	}
}

// postRawTo sends a hand-crafted request with an explicit Content-Length to an
// arbitrary path, so oversize paths can be exercised without the payload.
func (s *reportShim) postRawTo(t *testing.T, path, contentLength string) int {
	t.Helper()
	addr := strings.TrimPrefix(s.base, "http://")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	req := "POST " + path + " HTTP/1.0\r\nHost: shim\r\nContent-Length: " + contentLength + "\r\n\r\n"
	if _, err := io.WriteString(conn, req); err != nil {
		t.Fatalf("write request: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

// TestCodeFlowServer_JsonReportValidation pins the JSON-route format gate:
// only a JSON object may enter the slot; a malformed or non-object body is a
// 400 and never displaces the stored report (issue #1993, defect 1).
func TestCodeFlowServer_JsonReportValidation(t *testing.T) {
	s := startReportShim(t, t.TempDir(), t.TempDir())
	defer s.stop(t)

	bad := []struct {
		name string
		body string
	}{
		{"markdown bytes", richMD},
		{"malformed json", "{"},
		{"json array", "[]"},
		{"json string", `"x"`},
		{"json null", "null"},
	}
	for _, tc := range bad {
		t.Run("rejects "+tc.name, func(t *testing.T) {
			status, _, body := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(tc.body), "application/json")
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", status)
			}
			if !json.Valid(body) {
				t.Errorf("400 body is not JSON: %q", body)
			}
			if got, _, _ := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, ""); got != http.StatusNotFound {
				t.Errorf("slot = %d, want 404 after 400", got)
			}
			st := s.bridgeStatus(t)["/api/analysis/report.json"]
			if st.HTTPStatus == nil || *st.HTTPStatus != 400 {
				t.Errorf("bridge-status httpStatus = %v, want 400", st.HTTPStatus)
			}
		})
	}

	t.Run("accepts empty json when nothing carries findings", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if string(body) != emptyJSON {
			t.Fatalf("body = %q, want %q", body, emptyJSON)
		}
	})

	t.Run("non-finding keys are treated as empty", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(`{"summary":{}}`), "application/json"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
	})

	t.Run("accepts rich json with no markdown", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(richJSON), "application/json"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if string(body) != richJSON {
			t.Fatalf("body = %q, want %q", body, richJSON)
		}
	})

	t.Run("body at the cap is accepted", func(t *testing.T) {
		const prefix = `{"architectureIssues":[{"title":"`
		const suffix = `"}]}`
		capJSON := prefix + strings.Repeat("x", maxReportBytes-len(prefix)-len(suffix)) + suffix
		if len(capJSON) != maxReportBytes {
			t.Fatalf("cap payload = %d bytes, want %d", len(capJSON), maxReportBytes)
		}
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(capJSON), "application/json"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if !bytes.Equal(body, []byte(capJSON)) {
			t.Fatalf("capped json did not round-trip (%d bytes)", len(body))
		}
	})

	t.Run("declared length over the cap is 413 and store unchanged", func(t *testing.T) {
		_, _, before := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if status := s.postRawTo(t, "/api/analysis/report.json", strconv.Itoa(maxReportBytes+1)); status != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", status)
		}
		_, _, after := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if !bytes.Equal(before, after) {
			t.Errorf("slot mutated after 413")
		}
	})
}

// TestCodeFlowServer_CrossRouteConsistencyGuard pins the core defect fix: a
// structurally empty JSON export must not displace a slot that carries
// findings (issue #1993).
func TestCodeFlowServer_CrossRouteConsistencyGuard(t *testing.T) {
	postEmpty := func(t *testing.T, s *reportShim) {
		t.Helper()
		status, _, body := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json")
		if status != http.StatusConflict {
			t.Fatalf("empty json = %d, want 409 (%s)", status, body)
		}
		if !json.Valid(body) {
			t.Errorf("409 body is not JSON: %q", body)
		}
	}

	t.Run("empty json cannot displace a rich markdown slot with no json", func(t *testing.T) {
		s := startReportShim(t, t.TempDir(), t.TempDir())
		defer s.stop(t)
		s.seedMarkdown(t, richMD)
		postEmpty(t, s)
		if status, _, _ := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, ""); status != http.StatusNotFound {
			t.Errorf("json slot = %d, want 404 (stub not stored)", status)
		}
	})

	t.Run("empty json cannot displace a populated json slot", func(t *testing.T) {
		s := startReportShim(t, t.TempDir(), t.TempDir())
		defer s.stop(t)
		s.seedMarkdown(t, richMD)
		s.seedJSON(t, richJSON)
		_, hdrBefore, _ := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		postEmpty(t, s)
		status, hdrAfter, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if status != http.StatusOK || string(body) != richJSON {
			t.Fatalf("json slot = %d %q, want byte-identical rich json", status, body)
		}
		if hdrBefore.Get("X-Codeflow-Analysis-At") != hdrAfter.Get("X-Codeflow-Analysis-At") {
			t.Errorf("X-Codeflow-Analysis-At changed: %q -> %q",
				hdrBefore.Get("X-Codeflow-Analysis-At"), hdrAfter.Get("X-Codeflow-Analysis-At"))
		}
	})

	t.Run("empty-all json is rejected too", func(t *testing.T) {
		s := startReportShim(t, t.TempDir(), t.TempDir())
		defer s.stop(t)
		s.seedMarkdown(t, richMD)
		s.seedJSON(t, richJSON)
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyAllJSON), "application/json"); status != http.StatusConflict {
			t.Fatalf("status = %d, want 409", status)
		}
	})

	t.Run("rich json is always accepted", func(t *testing.T) {
		s := startReportShim(t, t.TempDir(), t.TempDir())
		defer s.stop(t)
		s.seedMarkdown(t, richMD)
		s.seedJSON(t, richJSON)
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(richJSON2), "application/json"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if string(body) != richJSON2 {
			t.Fatalf("body = %q, want %q", body, richJSON2)
		}
	})

	t.Run("rejected empty then accepted rich lands", func(t *testing.T) {
		s := startReportShim(t, t.TempDir(), t.TempDir())
		defer s.stop(t)
		s.seedMarkdown(t, richMD)
		s.seedJSON(t, richJSON)
		postEmpty(t, s)
		s.seedJSON(t, richJSON2)
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if string(body) != richJSON2 {
			t.Fatalf("body = %q, want %q", body, richJSON2)
		}
	})

	t.Run("clean and marker markdown accept an empty json", func(t *testing.T) {
		for _, md := range []string{cleanMD, markerMD, emptySectionMD} {
			s := startReportShim(t, t.TempDir(), t.TempDir())
			s.seedMarkdown(t, md)
			status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json")
			s.stop(t)
			if status != http.StatusNoContent {
				t.Fatalf("md %q: status = %d, want 204", md, status)
			}
		}
	})

	// Order edge: an empty export accepted before any markdown is stored, then
	// a finding-carrying markdown report lands. The guard only sees the JSON
	// slot at POST time, so the residual disagreement persists — recorded here
	// as current behaviour (see the non-gating hardening in the test plan).
	t.Run("order edge leaves a residual disagreement", func(t *testing.T) {
		s := startReportShim(t, t.TempDir(), t.TempDir())
		defer s.stop(t)
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json"); status != http.StatusNoContent {
			t.Fatalf("first empty json = %d, want 204", status)
		}
		s.seedMarkdown(t, richMD)
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if string(body) != emptyJSON {
			t.Errorf("residual json = %q, want the empty stub", body)
		}
	})
}

// TestCodeFlowServer_RejectionTelemetry pins bridge-status reporting of a
// refused structured export (issue #1993, acceptance #1).
func TestCodeFlowServer_RejectionTelemetry(t *testing.T) {
	s := startReportShim(t, t.TempDir(), t.TempDir())
	defer s.stop(t)

	t.Run("fresh routes have null rejection fields", func(t *testing.T) {
		for route, e := range s.bridgeStatus(t) {
			if e.RejectedAt != nil || e.RejectReason != nil {
				t.Errorf("%s = %+v, want null rejection fields", route, e)
			}
		}
	})

	t.Run("409 records rejectedAt and rejectReason", func(t *testing.T) {
		s.seedMarkdown(t, richMD)
		s.seedJSON(t, richJSON)
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json"); status != http.StatusConflict {
			t.Fatalf("status = %d, want 409", status)
		}
		e := s.bridgeStatus(t)["/api/analysis/report.json"]
		if e.HTTPStatus == nil || *e.HTTPStatus != 409 {
			t.Errorf("httpStatus = %v, want 409", e.HTTPStatus)
		}
		if e.PostedAt == nil {
			t.Errorf("postedAt = nil, want set")
		}
		if e.Bytes == nil || *e.Bytes != int64(len(emptyJSON)) {
			t.Errorf("bytes = %v, want %d", e.Bytes, len(emptyJSON))
		}
		if e.RejectedAt == nil {
			t.Errorf("rejectedAt = nil, want set")
		}
		if e.RejectReason == nil || *e.RejectReason == "" {
			t.Errorf("rejectReason = %v, want non-empty", e.RejectReason)
		}
		md := s.bridgeStatus(t)["/api/analysis/report"]
		if md.RejectedAt != nil || md.RejectReason != nil {
			t.Errorf("markdown slot polluted: %+v", md)
		}
	})

	t.Run("accepted post clears rejection fields", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(richJSON2), "application/json"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		e := s.bridgeStatus(t)["/api/analysis/report.json"]
		if e.RejectedAt != nil || e.RejectReason != nil {
			t.Errorf("rejection fields not cleared: %+v", e)
		}
		if e.HTTPStatus == nil || *e.HTTPStatus != 204 {
			t.Errorf("httpStatus = %v, want 204", e.HTTPStatus)
		}
		if e.Bytes == nil || *e.Bytes != int64(len(richJSON2)) {
			t.Errorf("bytes = %v, want %d", e.Bytes, len(richJSON2))
		}
	})

	t.Run("analysis-at survives a rejection", func(t *testing.T) {
		_, before, _ := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json"); status != http.StatusConflict {
			t.Fatalf("status = %d, want 409", status)
		}
		_, after, _ := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if before.Get("X-Codeflow-Analysis-At") != after.Get("X-Codeflow-Analysis-At") {
			t.Errorf("analysis-at changed across rejection")
		}
	})
}

// TestCodeFlowServer_RejectedPostNeverMutates pins that a refused export leaves
// the stored bytes untouched (issue #1993, store integrity).
func TestCodeFlowServer_RejectedPostNeverMutates(t *testing.T) {
	s := startReportShim(t, t.TempDir(), t.TempDir())
	defer s.stop(t)
	s.seedMarkdown(t, richMD)
	s.seedJSON(t, richJSON)
	_, _, before := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
	for i := 0; i < 10; i++ {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(emptyJSON), "application/json"); status != http.StatusConflict {
			t.Fatalf("iteration %d status = %d, want 409", i, status)
		}
	}
	_, _, after := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
	if !bytes.Equal(before, after) {
		t.Errorf("rejected posts mutated the stored bytes")
	}
}

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
