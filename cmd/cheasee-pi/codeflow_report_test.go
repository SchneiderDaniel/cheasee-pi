package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// maxReportBytes mirrors the 16 MiB cap in server.py.
const maxReportBytes = 16 * 1024 * 1024

// reportShim is a running embedded codeflow shim subprocess.
type reportShim struct {
	base   string
	client *http.Client
	cmd    *exec.Cmd
	done   chan error
	log    *bytes.Buffer
}

// startShim launches the embedded server.py on a free loopback port with the
// given repo/UI dirs and waits until it accepts connections.
func startReportShim(t *testing.T, repoRoot, uiDir string) *reportShim {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	serverPath := filepath.Join(t.TempDir(), "server.py")
	src, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	if err := os.WriteFile(serverPath, src, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}

	s := &reportShim{
		base:   fmt.Sprintf("http://127.0.0.1:%d", port),
		client: &http.Client{Timeout: 10 * time.Second},
		done:   make(chan error, 1),
		log:    &bytes.Buffer{},
	}
	s.cmd = exec.Command(python, serverPath)
	s.cmd.Env = append(os.Environ(),
		"REPO_ROOT="+repoRoot,
		"UI_DIR="+uiDir,
		"CONFIG_FILE="+filepath.Join(t.TempDir(), "missing-config.json"),
		fmt.Sprintf("PORT=%d", port),
		"HOST=127.0.0.1",
		"PYTHONUNBUFFERED=1",
	)
	s.cmd.Stdout = s.log
	s.cmd.Stderr = s.log
	if err := s.cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	go func() { s.done <- s.cmd.Wait() }()

	deadline := time.Now().Add(15 * time.Second)
	for {
		select {
		case <-s.done:
			t.Fatalf("server exited early:\n%s", s.log.String())
		default:
		}
		r, err := s.client.Get(s.base + "/api/repos/o/r")
		if err == nil {
			r.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			_ = s.cmd.Process.Kill()
			t.Fatalf("server did not come up: %v\nlog:\n%s", err, s.log.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	return s
}

// stop kills the server and fails the test if it logged a traceback.
func (s *reportShim) stop(t *testing.T) {
	t.Helper()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Error("server process did not exit after Kill")
	}
	if strings.Contains(s.log.String(), "Traceback") {
		t.Errorf("server log contains a traceback:\n%s", s.log.String())
	}
}

// do issues a request and returns status, headers and body.
func (s *reportShim) do(t *testing.T, method, path string, body []byte, contentType string) (int, http.Header, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, s.base+path, rdr)
	if err != nil {
		t.Fatalf("new request %s %s: %v", method, path, err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body %s %s: %v", method, path, err)
	}
	return resp.StatusCode, resp.Header, got
}

// postRaw sends a hand-crafted request with an explicit Content-Length header
// and no body, so oversize/missing-length paths can be exercised without
// shipping the payload. Returns the parsed status code.
func (s *reportShim) postRaw(t *testing.T, contentLength string) int {
	t.Helper()
	addr := strings.TrimPrefix(s.base, "http://")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	req := "POST /api/analysis/report HTTP/1.0\r\nHost: shim\r\n"
	if contentLength != "" {
		req += "Content-Length: " + contentLength + "\r\n"
	}
	req += "\r\n"
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

// TestCodeFlowServer_ReportStore pins the POST/GET /api/analysis/report
// contract: single-slot storage, status codes, size cap, and restart amnesia.
func TestCodeFlowServer_ReportStore(t *testing.T) {
	s := startReportShim(t, t.TempDir(), t.TempDir())
	defer s.stop(t)

	payload := "# CodeFlow Analysis Report\n\n**Repository:** o/r\n"
	var capPayload []byte

	t.Run("get before post is 404", func(t *testing.T) {
		if status, _, _ := s.do(t, http.MethodGet, "/api/analysis/report", nil, ""); status != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", status)
		}
	})

	t.Run("post stores and returns 204 with empty body", func(t *testing.T) {
		status, _, body := s.do(t, http.MethodPost, "/api/analysis/report", []byte(payload), "text/markdown; charset=utf-8")
		if status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		if len(body) != 0 {
			t.Errorf("204 body = %q, want empty", body)
		}
	})

	t.Run("get returns byte-identical markdown with headers", func(t *testing.T) {
		status, hdr, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if string(body) != payload {
			t.Errorf("body = %q, want %q", body, payload)
		}
		if ct := hdr.Get("Content-Type"); ct != "text/markdown; charset=utf-8" {
			t.Errorf("Content-Type = %q", ct)
		}
		if cl := hdr.Get("Content-Length"); cl != strconv.Itoa(len(payload)) {
			t.Errorf("Content-Length = %q, want %d", cl, len(payload))
		}
		at, err := strconv.ParseInt(hdr.Get("X-Codeflow-Analysis-At"), 10, 64)
		if err != nil {
			t.Fatalf("X-Codeflow-Analysis-At = %q: %v", hdr.Get("X-Codeflow-Analysis-At"), err)
		}
		if at <= 1_600_000_000_000 {
			t.Errorf("X-Codeflow-Analysis-At = %d, want epoch-ms", at)
		}
	})

	t.Run("second post replaces the single slot", func(t *testing.T) {
		second := payload + "second\n"
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", []byte(second), "text/markdown"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		status, _, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if status != http.StatusOK || string(body) != second {
			t.Fatalf("status=%d body=%q, want 200 and %q", status, body, second)
		}
	})

	t.Run("utf-8 body round-trips", func(t *testing.T) {
		utf8 := "# CodeFlow — analyse ✓\n# 日本語\n"
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", []byte(utf8), "text/markdown; charset=utf-8"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if string(body) != utf8 {
			t.Errorf("body = %q, want %q", body, utf8)
		}
	})

	t.Run("zero-length body is 400 and store unchanged", func(t *testing.T) {
		_, _, current := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", []byte{}, "text/markdown"); status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if !bytes.Equal(body, current) {
			t.Errorf("store mutated after 400")
		}
	})

	t.Run("wrong post path is 404 and store unchanged", func(t *testing.T) {
		_, _, current := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		for _, path := range []string{"/api/analysis/other", "/api/repos/o/r"} {
			if status, _, _ := s.do(t, http.MethodPost, path, []byte(payload), "text/markdown"); status != http.StatusNotFound {
				t.Errorf("POST %s status = %d, want 404", path, status)
			}
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if !bytes.Equal(body, current) {
			t.Errorf("store mutated after wrong-path POST")
		}
	})

	t.Run("missing content-length is 411", func(t *testing.T) {
		if status := s.postRaw(t, ""); status != http.StatusLengthRequired {
			t.Errorf("status = %d, want 411", status)
		}
	})

	t.Run("invalid content-length is 411", func(t *testing.T) {
		if status := s.postRaw(t, "not-a-number"); status != http.StatusLengthRequired {
			t.Errorf("status = %d, want 411", status)
		}
	})

	t.Run("oversize declared length is 413 and store unchanged", func(t *testing.T) {
		_, _, current := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if status := s.postRaw(t, strconv.Itoa(maxReportBytes+1)); status != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want 413", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if !bytes.Equal(body, current) {
			t.Errorf("store mutated after 413")
		}
	})

	t.Run("body at the cap is accepted", func(t *testing.T) {
		capPayload = bytes.Repeat([]byte("x"), maxReportBytes)
		if status, _, _ := s.do(t, http.MethodPost, "/api/analysis/report", capPayload, "text/markdown"); status != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", status)
		}
		_, _, body := s.do(t, http.MethodGet, "/api/analysis/report", nil, "")
		if !bytes.Equal(body, capPayload) {
			t.Errorf("capped payload did not round-trip (%d bytes)", len(body))
		}
	})

	t.Run("concurrent posts never tear", func(t *testing.T) {
		const n = 20
		payloads := make([][]byte, n)
		for i := range payloads {
			payloads[i] = []byte(strings.Repeat(fmt.Sprintf("payload-%02d ", i), 200))
		}
		set := make(map[string]bool, n)
		for _, p := range payloads {
			set[string(p)] = true
		}
		// The cap payload from the previous subtest is still in the slot and is
		// a valid GET response until the first concurrent POST lands.
		set[string(capPayload)] = true
		var wg sync.WaitGroup
		errs := make(chan error, n*2)
		for i := 0; i < n; i++ {
			wg.Add(2)
			go func(i int) {
				defer wg.Done()
				req, _ := http.NewRequest(http.MethodPost, s.base+"/api/analysis/report", bytes.NewReader(payloads[i]))
				req.Header.Set("Content-Type", "text/markdown")
				resp, err := s.client.Do(req)
				if err != nil {
					errs <- err
					return
				}
				resp.Body.Close()
			}(i)
			go func() {
				defer wg.Done()
				resp, err := s.client.Get(s.base + "/api/analysis/report")
				if err != nil {
					errs <- err
					return
				}
				body, err := io.ReadAll(resp.Body)
				resp.Body.Close()
				if err != nil {
					errs <- err
					return
				}
				if resp.StatusCode != http.StatusOK {
					return // slot not yet filled
				}
				if resp.Header.Get("Content-Length") != strconv.Itoa(len(body)) {
					errs <- fmt.Errorf("Content-Length header %q != body len %d", resp.Header.Get("Content-Length"), len(body))
					return
				}
				if !set[string(body)] {
					errs <- fmt.Errorf("torn read: %d-byte body matches no posted payload", len(body))
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Error(err)
		}
	})

	t.Run("restart loses the in-memory slot", func(t *testing.T) {
		fresh := startReportShim(t, t.TempDir(), t.TempDir())
		defer fresh.stop(t)
		if status, _, _ := fresh.do(t, http.MethodGet, "/api/analysis/report", nil, ""); status != http.StatusNotFound {
			t.Errorf("status = %d, want 404 on fresh server", status)
		}
	})
}

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
		for _, want := range []string{"/api/analysis/report", "/api/analysis/report.json", "createObjectURL", "aria-label", "export-option", "reportError", "unreachable", "codeflow-bridge-error"} {
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
	CapturedAt *int64 `json:"capturedAt"`
	PostedAt   *int64 `json:"postedAt"`
	HTTPStatus *int   `json:"httpStatus"`
	Bytes      *int64 `json:"bytes"`
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
