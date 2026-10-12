package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestCodeFlowServer_JsonReportStore pins the /api/analysis/report.json route:
// its own single slot with the JSON content type, independent of the markdown
// slot (the structured report carries the duplicates / layer-violation /
// suggestion categories the markdown exporter omits).
func TestCodeFlowServer_JsonReportStore(t *testing.T) {
	s := startReportShim(t, t.TempDir(), t.TempDir())
	defer s.stop(t)

	mdPayload := "# CodeFlow Analysis Report\n\n**Repository:** o/r\n"
	jsonPayload := `{"architectureIssues":[{"title":"x","affectedFiles":["src/a.ts"]}]}`

	t.Run("json get before post is 404", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, ""); status != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", status)
		}
	})

	t.Run("json post stores and get returns it byte-identical with the json content type", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", []byte(jsonPayload), "text/plain; charset=utf-8"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		status, hdr, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if string(body) != jsonPayload {
			t.Errorf("body = %q, want %q", body, jsonPayload)
		}
		if ct := hdr.Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Content-Type = %q", ct)
		}
		if cl := hdr.Get("Content-Length"); cl != strconv.Itoa(len(jsonPayload)) {
			t.Errorf("Content-Length = %q, want %d", cl, len(jsonPayload))
		}
	})

	t.Run("markdown slot is independent of the json slot", func(t *testing.T) {
		// JSON is stored; markdown is still absent.
		if status, _, _ := s.do(t, http.MethodGet, "/api/analysis/report", nil, ""); status != http.StatusNotFound {
			t.Fatalf("markdown status = %d, want 404 while only JSON was posted", status)
		}
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", []byte(mdPayload), "text/markdown"); status != http.StatusNoContent {
			t.Fatalf("markdown status = %d, want 204", status)
		}
		_, _, jsonBody := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if string(jsonBody) != jsonPayload {
			t.Errorf("json slot changed after markdown post: %q", jsonBody)
		}
		_, _, mdBody := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if string(mdBody) != mdPayload {
			t.Errorf("markdown body = %q, want %q", mdBody, mdPayload)
		}
	})

	t.Run("json oversize declared length is 413 and store unchanged", func(t *testing.T) {
		_, _, current := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		addr := strings.TrimPrefix(s.base, "http://")
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer conn.Close()
		req := "POST /api/analysis/report.json HTTP/1.0\r\nHost: shim\r\nContent-Length: " + strconv.Itoa(maxReportBytes+1) + "\r\n\r\n"
		if _, err := io.WriteString(conn, req); err != nil {
			t.Fatalf("write request: %v", err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("read response: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want 413", resp.StatusCode)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if !bytes.Equal(body, current) {
			t.Errorf("store mutated after 413")
		}
	})
}

// TestCodeFlowServer_Bridge pins the browser-bridge injection: the served
// index.html gains exactly one script tag, the bridge JS is served from a
// constant (independent of UI_DIR), and rewrites stay scoped to index.html.
func TestCodeFlowServer_Bridge(t *testing.T) {
	uiDir := t.TempDir()
	index := "<html><body><script>var x={repoSoft:300,repoMax:750};</script></body></html>"
	if err := os.WriteFile(filepath.Join(uiDir, "index.html"), []byte(index), 0644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	asset := "var y={repoSoft:300,repoMax:750};"
	if err := os.WriteFile(filepath.Join(uiDir, "main.js"), []byte(asset), 0644); err != nil {
		t.Fatalf("write main.js: %v", err)
	}

	s := startReportShim(t, t.TempDir(), uiDir)
	defer s.stop(t)

	t.Run("index.html gains exactly one bridge tag and existing rewrites", func(t *testing.T) {
		status, _, body := s.do(t, http.MethodGet, "/", nil, "")
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		html := string(body)
		if n := strings.Count(html, `<script src="codeflow-bridge.js" defer></script>`); n != 1 {
			t.Errorf("bridge tag count = %d, want 1", n)
		}
		if !strings.Contains(html, "repoSoft:10000,repoMax:10000") {
			t.Errorf("existing size-limit rewrite missing")
		}
		if strings.Contains(html, "repoSoft:300,repoMax:750") {
			t.Errorf("old size limit still present")
		}
	})

	t.Run("bridge js is served with the report endpoint", func(t *testing.T) {
		status, hdr, body := s.do(t, http.MethodGet, "/codeflow-bridge.js", nil, "")
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if ct := hdr.Get("Content-Type"); !strings.Contains(ct, "javascript") {
			t.Errorf("Content-Type = %q, want javascript", ct)
		}
		for _, want := range []string{"/api/analysis/report", "/api/analysis/report.json", "createObjectURL", "reportError", "unreachable", "codeflow-bridge-error"} {
			if !strings.Contains(string(body), want) {
				t.Errorf("bridge js missing %q", want)
			}
		}
		if node, err := exec.LookPath("node"); err == nil {
			tmp := filepath.Join(t.TempDir(), "bridge.js")
			if err := os.WriteFile(tmp, body, 0644); err != nil {
				t.Fatalf("write bridge.js: %v", err)
			}
			if out, err := exec.Command(node, "--check", tmp).CombinedOutput(); err != nil {
				t.Errorf("node --check failed: %v\n%s", err, out)
			}
		}
	})

	t.Run("rewrites never touch non-index assets", func(t *testing.T) {
		status, _, body := s.do(t, http.MethodGet, "/main.js", nil, "")
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if string(body) != asset {
			t.Errorf("main.js = %q, want unchanged %q", body, asset)
		}
	})

	t.Run("index without body tag is served unchanged", func(t *testing.T) {
		uiDir := t.TempDir()
		plain := "<html><body>no closing tag here"
		if err := os.WriteFile(filepath.Join(uiDir, "index.html"), []byte(plain), 0644); err != nil {
			t.Fatalf("write index.html: %v", err)
		}
		s2 := startReportShim(t, t.TempDir(), uiDir)
		defer s2.stop(t)
		status, _, body := s2.do(t, http.MethodGet, "/", nil, "")
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if strings.Contains(string(body), "codeflow-bridge.js") {
			t.Errorf("bridge injected into an index without </body>")
		}
	})

	t.Run("bridge js served even with an empty UI dir", func(t *testing.T) {
		s3 := startReportShim(t, t.TempDir(), t.TempDir())
		defer s3.stop(t)
		if status, _, _ := s3.do(t, http.MethodGet, "/codeflow-bridge.js", nil, ""); status != http.StatusOK {
			t.Errorf("status = %d, want 200", status)
		}
	})
}

// bridgeStatusEntry mirrors one route's telemetry in /api/analysis/bridge-status.
type bridgeStatusEntry struct {
	CapturedAt   *int64  `json:"capturedAt"`
	PostedAt     *int64  `json:"postedAt"`
	HTTPStatus   *int    `json:"httpStatus"`
	Bytes        *int64  `json:"bytes"`
	RejectedAt   *int64  `json:"rejectedAt"`
	RejectReason *string `json:"rejectReason"`
}

func (s *reportShim) bridgeStatus(t *testing.T) map[string]bridgeStatusEntry {
	t.Helper()
	status, _, body := s.do(t, http.MethodGet, "/api/analysis/bridge-status", nil, "")
	if status != http.StatusOK {
		t.Fatalf("bridge-status = %d, want 200", status)
	}
	var out map[string]bridgeStatusEntry
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("bridge-status is not JSON: %v\n%s", err, body)
	}
	return out
}

// TestCodeFlowServer_BridgeStatus pins the diagnostic route that distinguishes
// "the browser never POSTed the report" from "the shim received it but does not
// serve it" (issue #1976, item 6).
func TestCodeFlowServer_BridgeStatus(t *testing.T) {
	s := startReportShim(t, t.TempDir(), t.TempDir())
	defer s.stop(t)

	mdPayload := []byte("# CodeFlow Analysis Report\n\n**Repository:** o/r\n")
	jsonPayload := []byte(`{"architectureIssues":[{"title":"x","affectedFiles":["src/a.ts"]}]}`)

	t.Run("empty before any post, both routes present with nulls", func(t *testing.T) {
		st := s.bridgeStatus(t)
		for _, route := range []string{"/api/analysis/report", "/api/analysis/report.json"} {
			e, ok := st[route]
			if !ok {
				t.Fatalf("status missing route %s", route)
			}
			if e.CapturedAt != nil || e.PostedAt != nil || e.HTTPStatus != nil || e.Bytes != nil {
				t.Errorf("%s = %+v, want all null", route, e)
			}
		}
	})

	t.Run("markdown post records postedAt, bytes and 204; json stays null", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", mdPayload, "text/markdown"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		st := s.bridgeStatus(t)
		md := st["/api/analysis/report"]
		if md.PostedAt == nil || md.HTTPStatus == nil || *md.HTTPStatus != 204 || md.Bytes == nil || *md.Bytes != int64(len(mdPayload)) {
			t.Errorf("markdown status = %+v", md)
		}
		if st["/api/analysis/report.json"].PostedAt != nil {
			t.Errorf("json postedAt must stay null: %+v", st["/api/analysis/report.json"])
		}
	})

	t.Run("json post serves byte-identical and records 204", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report.json", jsonPayload, "text/plain"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		status, _, body := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if status != http.StatusOK || !bytes.Equal(body, jsonPayload) {
			t.Fatalf("json GET = %d %q", status, body)
		}
		st := s.bridgeStatus(t)
		js := st["/api/analysis/report.json"]
		if js.HTTPStatus == nil || *js.HTTPStatus != 204 || js.Bytes == nil || *js.Bytes != int64(len(jsonPayload)) {
			t.Errorf("json status = %+v", js)
		}
	})

	t.Run("oversize declared json length records 413 and keeps the store", func(t *testing.T) {
		_, _, before := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		addr := strings.TrimPrefix(s.base, "http://")
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer conn.Close()
		req := "POST /api/analysis/report.json HTTP/1.0\r\nHost: shim\r\nContent-Length: " + strconv.Itoa(maxReportBytes+1) + "\r\n\r\n"
		if _, err := io.WriteString(conn, req); err != nil {
			t.Fatalf("write: %v", err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", resp.StatusCode)
		}
		js := s.bridgeStatus(t)["/api/analysis/report.json"]
		if js.HTTPStatus == nil || *js.HTTPStatus != 413 || js.Bytes == nil || *js.Bytes != int64(maxReportBytes+1) {
			t.Errorf("json status after 413 = %+v", js)
		}
		_, _, after := s.do(t, http.MethodGet, "/api/analysis/report.json", nil, "")
		if !bytes.Equal(before, after) {
			t.Errorf("store mutated after 413")
		}
	})

	t.Run("restart loses the status history", func(t *testing.T) {
		fresh := startReportShim(t, t.TempDir(), t.TempDir())
		defer fresh.stop(t)
		for route, e := range fresh.bridgeStatus(t) {
			if e.PostedAt != nil || e.CapturedAt != nil {
				t.Errorf("fresh %s = %+v, want no history", route, e)
			}
		}
	})
}
