package main

import (
	"bytes"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCodeFlowServer_FpFilterRewritePure drives the browser-parity rewrite for
// the false-positive filter directly (no HTTP): the page's own generateReport is
// wrapped in the same filter the headless runner applies, a second pass is a
// byte-identical no-op, and bytes without the anchor are untouched.
func TestCodeFlowServer_FpFilterRewritePure(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	src, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	dir := t.TempDir()
	serverPath := filepath.Join(dir, "server.py")
	if err := os.WriteFile(serverPath, src, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}
	script := `import runpy, sys, os

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]

src = b"<script>function generateReport(format){return format;}</script>"
out = pat.sub(lambda _: repl, src)
assert out.count(b"function __piFpGenerateReport(format){return format;}") == 1, out
assert out.count(b"piFpFilter.sanitizeAnalysisData(data, piFpFilter.readFileFrom(data))") == 1, out
assert b'if ("securityIssues" in __piFp.data) data.securityIssues = __piFp.data.securityIssues;' in out, out
assert b'if ("layerViolations" in __piFp.data) data.layerViolations = __piFp.data.layerViolations;' in out, out
assert b'if ("stats" in __piFp.data) data.stats = __piFp.data.stats;' in out, out
assert b"data = piFpFilter" not in out, "must not rebind data (const-safe): %r" % out
assert b'"use strict"' in out, out
assert b"throw e" in out, "sanitizer error must fail closed: %r" % out
assert b"__codeflowBridgeReportError" in out, "sanitizer failure must be visible: %r" % out
assert b"window.__codeflowBridgeReportError = reportError" in m["_BRIDGE_JS"], m["_BRIDGE_JS"]
assert b"return __piFpGenerateReport.apply(this, arguments)" in out, out
assert pat.sub(lambda _: repl, out) == out, "not idempotent"

raw = b"<script>no report function here</script>"
assert pat.sub(lambda _: repl, raw) == raw, "anchor-free bytes altered: %r" % pat.sub(lambda _: repl, raw)

bridge = m["_BRIDGE_SCRIPT"]
assert bridge.count(b"fp-filter.js") == 1, bridge
assert bridge.count(b"codeflow-bridge.js") == 1, bridge
assert m["_FP_FILTER_ROUTE"] == "/fp-filter.js"
assert os.path.basename(m["_FP_FILTER_PATH"]) == "fp-filter.js"
print("OK")
`
	scriptPath := filepath.Join(dir, "check_fp_filter.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath).CombinedOutput()
	if err != nil {
		t.Fatalf("false-positive wrapper checks failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}

// TestCodeFlowServer_FpFilterWrapperBehavior executes the served-page wrapper:
// the page declares `data` as a constant, so the old rebinding threw and fell
// back to the unfiltered report. The wrapper must filter by overwriting the
// array properties, a sanitizer error must fail closed (no unfiltered export),
// and a write a frozen `data` rejects must surface on the same visible error
// banner instead of aborting the export silently. The rewritten generateReport
// comes from the real server.py rewrite.
func TestCodeFlowServer_FpFilterWrapperBehavior(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	serverSrc, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	filterSrc, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/fp-filter.js")
	if err != nil {
		t.Fatalf("read embedded fp-filter.js: %v", err)
	}
	dir := t.TempDir()
	serverPath := filepath.Join(dir, "server.py")
	filterPath := filepath.Join(dir, "fp-filter.js")
	if err := os.WriteFile(serverPath, serverSrc, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}
	if err := os.WriteFile(filterPath, filterSrc, 0644); err != nil {
		t.Fatalf("write fp-filter.js: %v", err)
	}

	// Emit three CommonJS harnesses: one with a real `const data`, one whose
	// sanitizer throws, and one whose `data` is frozen so the in-place write
	// throws. All inline the rewrite server.py actually serves.
	script := `import runpy, sys

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]
rewritten = pat.sub(lambda _: repl, b"function generateReport(format){ return data; }").decode()

ok = """const data = { stats: { security: 1, violations: 0 }, securityIssues: [ { severity: 'high', title: 'Hardcoded Secret', code: '', path: 'x.ts' } ], layerViolations: [] };
const piFpFilter = require(process.argv[2]);
""" + rewritten + """
generateReport('md');
process.stdout.write('RESULT' + JSON.stringify({ security: data.securityIssues.length, layers: data.layerViolations.length, stats: data.stats }));
"""
open(sys.argv[3], "w").write(ok)

fail = """const data = { securityIssues: [] };
globalThis.__bridgeSaw = null;
globalThis.__codeflowBridgeReportError = function (m) { globalThis.__bridgeSaw = m; };
const piFpFilter = { sanitizeAnalysisData() { throw new Error('fp-filter exploded'); }, readFileFrom() { return () => null; } };
""" + rewritten + """
try { generateReport('md'); process.stdout.write('RESULTNO_THROW'); }
catch (e) { process.stdout.write('RESULTTHREW:' + e.message + ':' + globalThis.__codeflowFpFilterError + ':' + globalThis.__bridgeSaw); }
"""
open(sys.argv[4], "w").write(fail)

frozen = """const data = Object.freeze({ securityIssues: [ { severity: 'high', title: 'Hardcoded Secret', code: '', path: 'x.ts' } ], layerViolations: [] });
globalThis.__bridgeSaw = null;
globalThis.__codeflowBridgeReportError = function (m) { globalThis.__bridgeSaw = m; };
const piFpFilter = require(process.argv[2]);
""" + rewritten + """
try { generateReport('md'); process.stdout.write('FROZENNO_THROW'); }
catch (e) { process.stdout.write('FROZEN:' + e.constructor.name + ':' + globalThis.__codeflowFpFilterError + ':' + globalThis.__bridgeSaw); }
"""
open(sys.argv[5], "w").write(frozen)
`
	scriptPath := filepath.Join(dir, "emit_harness.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write emit script: %v", err)
	}
	okHarness := filepath.Join(dir, "ok.cjs")
	failHarness := filepath.Join(dir, "fail.cjs")
	frozenHarness := filepath.Join(dir, "frozen.cjs")
	if out, err := exec.Command(python, scriptPath, serverPath, filterPath, okHarness, failHarness, frozenHarness).CombinedOutput(); err != nil {
		t.Fatalf("emit harnesses: %v\n%s", err, out)
	}

	out, err := exec.Command(node, okHarness, filterPath).CombinedOutput()
	if err != nil {
		t.Fatalf("const-data harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "RESULT{\"security\":0,\"layers\":0,\"stats\":{\"security\":0,\"violations\":0}}") {
		t.Errorf("const `data` was not filtered in place (arrays and stats must both move): %s", out)
	}

	out, err = exec.Command(node, failHarness, filterPath).CombinedOutput()
	if err != nil {
		t.Fatalf("fail-closed harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "RESULTTHREW:fp-filter exploded:fp-filter exploded:false-positive filter failed; report not exported: fp-filter exploded") {
		t.Errorf("sanitizer error must fail closed and surface the failure, got: %s", out)
	}

	out, err = exec.Command(node, frozenHarness, filterPath).CombinedOutput()
	if err != nil {
		t.Fatalf("frozen-data harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "FROZEN:TypeError:") {
		t.Errorf("a frozen data binding must fail closed, got: %s", out)
	}
	if !strings.Contains(string(out), "false-positive filter failed; report not exported:") {
		t.Errorf("a frozen-data write failure must surface on the visible error handler, got: %s", out)
	}
}

// TestCodeFlowServer_FpFilterServed is the serve-path contract: /fp-filter.js is
// served byte-verbatim as JavaScript, the served index.html references it exactly
// once next to the bridge and wraps generateReport in it.
func TestCodeFlowServer_FpFilterServed(t *testing.T) {
	uiDir := t.TempDir()
	writeFile(t, uiDir, "index.html",
		"<script>function generateReport(format){return format;}</script>\n</body>")
	base := startShim(t, t.TempDir(), uiDir)

	resp, body := getStatus(t, newNoRedirectClient(), base+"/fp-filter.js")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /fp-filter.js status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("fp-filter.js Content-Type = %q, want text/javascript", ct)
	}
	want, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/fp-filter.js")
	if err != nil {
		t.Fatalf("read embedded fp-filter.js: %v", err)
	}
	if !bytes.Equal(body, want) {
		t.Errorf("served /fp-filter.js is not byte-verbatim (%d want %d bytes)", len(body), len(want))
	}

	resp, body = getStatus(t, newNoRedirectClient(), base+"/")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200\nbody: %s", resp.StatusCode, body)
	}
	for _, want := range []string{
		"<script src=\"fp-filter.js\" defer></script><script src=\"codeflow-bridge.js\" defer></script>",
		"if (\"securityIssues\" in __piFp.data) data.securityIssues = __piFp.data.securityIssues;",
		"if (\"layerViolations\" in __piFp.data) data.layerViolations = __piFp.data.layerViolations;",
		"if (\"stats\" in __piFp.data) data.stats = __piFp.data.stats;",
		"function __piFpGenerateReport(format){return format;}",
	} {
		if n := bytes.Count(body, []byte(want)); n != 1 {
			t.Errorf("served index.html must contain %q exactly once, got %d\nbody: %s", want, n, body)
		}
	}
}
