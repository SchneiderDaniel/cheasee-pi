package main

import (
	"bytes"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// stageFPFilterModules copies the embedded `codeflow/fp-filter/` tree into
// `dir/fp-filter/`, one file per walk entry, so the staged server finds exactly
// the modules the Dockerfile COPYs. It lives next to the route test that consumes
// it; the shared harness only calls it.
func stageFPFilterModules(t *testing.T, dir string) {
	t.Helper()
	root := "embedded/docker/codeflow/fp-filter"
	err := fs.WalkDir(embeddedFS, root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		src, err := fs.ReadFile(embeddedFS, path)
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, "embedded/docker/codeflow/")
		dest := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}
		return os.WriteFile(dest, src, 0644)
	})
	if err != nil {
		t.Fatalf("stage embedded fp-filter modules: %v", err)
	}
}

// TestCodeFlowServer_FpFilterRewritePure drives the browser-parity rewrite for
// the false-positive filter directly (no HTTP): the page's own generateReport is
// wrapped in the same filter the headless runner applies, a second pass is a
// byte-identical no-op, and bytes without the anchor are untouched.
func TestCodeFlowServer_FpFilterRewritePure(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	dir := t.TempDir()
	serverPath := stageCodeflowShim(t, dir)
	script := `import runpy, sys, os

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]

src = b"<script>function generateReport(format){return format;}</script>"
out = pat.sub(lambda _: repl, src)
assert out.count(b"function __piFpGenerateReport(format){return format;}") == 1, out
assert out.count(b"piFpFilter.sanitizeAnalysisData(data, piFpFilter.readFileFrom(data), { deriveSuggestions: function (d) {") == 1, out
assert b'if ("securityIssues" in __piFp.data) data.securityIssues = __piFp.data.securityIssues;' in out, out
assert b'if ("layerViolations" in __piFp.data) data.layerViolations = __piFp.data.layerViolations;' in out, out
assert b'if ("stats" in __piFp.data) data.stats = __piFp.data.stats;' in out, out
assert b"data = piFpFilter" not in out, "must not rebind data (const-safe): %r" % out
assert b'"fp-filter: suppressed "' in out, "suppression log must keep the headless wording: %r" % out
assert b"__piFp.suppressed.hygiene.length" in out, "the hygiene count must be reported: %r" % out
assert b'" hygiene finding(s), "' in out, out
assert b"__piFpDead + \" unused function(s), \"" in out, "the dead-function count must be reported: %r" % out
assert b"__piFp.suppressed.duplicates" in out, "the duplicate count must be reported: %r" % out
assert b'" duplicate group(s)");' in out, out
assert b'if ("duplicates" in __piFp.data) data.duplicates = __piFp.data.duplicates;' in out, out
assert b'if ("issues" in __piFp.data) data.issues = __piFp.data.issues;' in out, out
assert b"data.files.forEach(function (f) { if (f) f.piFpSource = null; })" in out, "the retained source must be released: %r" % out
assert b"Parser.generateSuggestions" in out, "the page's own deriver must be passed: %r" % out
assert b'if ("suggestions" in __piFp.data) data.suggestions = __piFp.data.suggestions;' in out, out
assert b"derived suggestion(s): derivation unavailable" in out, out
assert b'"use strict"' in out, out
assert b"throw e" in out, "sanitizer error must fail closed: %r" % out
assert b"__codeflowBridgeReportError" in out, "sanitizer failure must be visible: %r" % out
assert b"window.__codeflowBridgeReportError = reportError" in m["_BRIDGE_JS"], m["_BRIDGE_JS"]
assert b"return __piFpGenerateReport.apply(this, arguments)" in out, out
assert pat.sub(lambda _: repl, out) == out, "not idempotent"

raw = b"<script>no report function here</script>"
assert pat.sub(lambda _: repl, raw) == raw, "anchor-free bytes altered: %r" % pat.sub(lambda _: repl, raw)

# The analyzer frees each file's source before generateReport; the served page
# must keep it on piFpSource so the in-page filter can resolve references.
src_keep = [rw for rw in m["_UI_REWRITES"] if b"f.piFpSource=f.content" in rw[1]]
assert len(src_keep) == 1, src_keep
keep_pat, keep_repl = src_keep[0]
freed = b"analyzed.forEach(function(f){f.content=null;});"
kept = keep_pat.sub(lambda _: keep_repl, freed)
assert kept == b"analyzed.forEach(function(f){f.piFpSource=f.content;f.content=null;});", kept
assert keep_pat.sub(lambda _: keep_repl, kept) == kept, "source-keep rewrite not idempotent"
assert keep_pat.sub(lambda _: keep_repl, b"nothing to keep here") == b"nothing to keep here", "anchor-free bytes altered"

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
	dir := t.TempDir()
	serverPath := stageCodeflowShim(t, dir)
	filterPath := filepath.Join(dir, "fp-filter.js")

	// Emit three CommonJS harnesses: one with a real `const data`, one whose
	// sanitizer throws, and one whose `data` is frozen so the in-place write
	// throws. All inline the rewrite server.py actually serves.
	script := `import runpy, sys

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]
rewritten = pat.sub(lambda _: repl, b"function generateReport(format){ return data; }").decode()

ok = """const data = { stats: { security: 1, violations: 0 }, securityIssues: [ { severity: 'high', title: 'Hardcoded Secret', code: '', path: 'x.ts' }, { severity: 'low', title: 'Code Comments', code: '', path: 'src/widget.test.ts' } ], layerViolations: [] };
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
	if !strings.Contains(
		string(out),
		"fp-filter: suppressed 1 security issue(s), 0 layer violation(s), 1 hygiene finding(s)",
	) {
		t.Errorf("the served wrapper must log the same suppression line as the headless runner, got: %s", out)
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
// once after the policy-module tags and wraps generateReport in it.
func TestCodeFlowServer_FpFilterServed(t *testing.T) {
	uiDir := t.TempDir()
	writeShimFile(t, uiDir, "index.html",
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
	// The index tag is the only occurrence of `fp-filter.js`: the module tags are
	// `fp-filter/<name>.js`, which does not contain that substring.
	if n := bytes.Count(body, []byte("fp-filter.js")); n != 1 {
		t.Errorf("served index.html must reference fp-filter.js once, got %d", n)
	}
}

// TestCodeFlowServer_FpFilterModulesServed pins the module load path of issue
// #2100: one `<script>` per allowlisted policy module, in `_FP_FILTER_MODULES`
// order, all before the index tag; every tag resolves to the embedded bytes
// verbatim; and the allowlist is the only thing that turns a request into a path,
// so an unlisted or climbing name is a 404 and never a filesystem read.
func TestCodeFlowServer_FpFilterModulesServed(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	dir := t.TempDir()
	serverPath := stageCodeflowShim(t, dir)
	// The tag list, the allowlist and the served bytes come from the shim itself,
	// so the tag set cannot drift from the source tree.
	script := `import runpy, sys

m = runpy.run_path(sys.argv[1])
for name in m["_FP_FILTER_MODULES"]:
    print(name)
print("BRIDGE\t" + m["_BRIDGE_SCRIPT"].decode())
print("ROUTE\t" + m["_FP_FILTER_MODULE_ROUTE"])
`
	scriptPath := filepath.Join(dir, "emit_fp_filter_modules.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write emit script: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath).CombinedOutput()
	if err != nil {
		t.Fatalf("emit fp-filter modules: %v\n%s", err, out)
	}
	var modules []string
	var bridge, route string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		switch {
		case strings.HasPrefix(line, "BRIDGE\t"):
			bridge = strings.TrimPrefix(line, "BRIDGE\t")
		case strings.HasPrefix(line, "ROUTE\t"):
			route = strings.TrimPrefix(line, "ROUTE\t")
		default:
			modules = append(modules, line)
		}
	}
	if len(modules) == 0 {
		t.Fatalf("no fp-filter modules emitted, got: %s", out)
	}
	if route != "/fp-filter/" {
		t.Errorf("module route = %q, want /fp-filter/", route)
	}

	// The allowlist equals the embedded module tree: no tag without a file, no
	// file without a tag.
	var onDisk []string
	err = fs.WalkDir(embeddedFS, "embedded/docker/codeflow/fp-filter", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		onDisk = append(onDisk, strings.TrimSuffix(
			strings.TrimPrefix(path, "embedded/docker/codeflow/fp-filter/"), ".js"))
		return nil
	})
	if err != nil {
		t.Fatalf("walk embedded fp-filter tree: %v", err)
	}
	sort.Strings(onDisk)
	sorted := append([]string{}, modules...)
	sort.Strings(sorted)
	if strings.Join(onDisk, ",") != strings.Join(sorted, ",") {
		t.Errorf("allowlist %v != embedded module tree %v", modules, onDisk)
	}

	uiDir := t.TempDir()
	writeShimFile(t, uiDir, "index.html",
		"<script>function generateReport(format){return format;}</script>\n</body>")
	base := startShim(t, t.TempDir(), uiDir)

	for _, name := range modules {
		resp, body := getStatus(t, newNoRedirectClient(), base+route+name+".js")
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s%s.js status = %d, want 200", route, name, resp.StatusCode)
			continue
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
			t.Errorf("%s.js Content-Type = %q, want text/javascript", name, ct)
		}
		want, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/fp-filter/"+name+".js")
		if err != nil {
			t.Fatalf("read embedded fp-filter/%s.js: %v", name, err)
		}
		if !bytes.Equal(body, want) {
			t.Errorf("served %s%s.js is not byte-verbatim (%d want %d bytes)",
				route, name, len(body), len(want))
		}
	}

	// Order: every module tag precedes the index tag, and each appears once.
	_, page := getStatus(t, newNoRedirectClient(), base+"/")
	indexAt := bytes.Index(page, []byte("<script src=\"fp-filter.js\" defer></script>"))
	if indexAt < 0 {
		t.Fatalf("served index.html is missing the fp-filter.js tag\nbody: %s", page)
	}
	last := -1
	for _, name := range modules {
		tag := []byte("<script src=\"fp-filter/" + name + ".js\" defer></script>")
		if n := bytes.Count(page, tag); n != 1 {
			t.Errorf("served index.html must carry %q exactly once, got %d", tag, n)
			continue
		}
		at := bytes.Index(page, tag)
		if at > indexAt {
			t.Errorf("module tag %q must precede the fp-filter.js tag", tag)
		}
		if at < last {
			t.Errorf("module tag %q is out of load order", tag)
		}
		last = at
	}
	if !strings.Contains(bridge, "codeflow-bridge.js") {
		t.Errorf("the bridge tag must follow the index: %q", bridge)
	}

	brain := "def do_GET"
	for _, raw := range []string{
		"/fp-filter/nope.js",
		"/fp-filter/",
		"/fp-filter/../server.py",
		"/fp-filter/..%2Fserver.py",
		"/fp-filter/%2e%2e%2e/server.py",
		"/fp-filter/security/../../server.py",
	} {
		resp, body := getStatus(t, newNoRedirectClient(), base+raw)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404", raw, resp.StatusCode)
		}
		if bytes.Contains(body, []byte(brain)) {
			t.Errorf("GET %s leaked the server source", raw)
		}
	}
}

// TestCodeFlowServer_FpFilterSuggestions covers the derived `suggestions[]` cards
// (issue #2030): the wrapper passes the page's own `Parser.generateSuggestions` as
// the deriver and copies the reconciled array back, so the served UI cannot export
// cards naming findings the filter just dropped. With no deriver available the
// cards are dropped and the degradation is logged — never silently exported.
func TestCodeFlowServer_FpFilterSuggestions(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	serverPath := stageCodeflowShim(t, dir)
	filterPath := filepath.Join(dir, "fp-filter.js")

	script := `import runpy, sys

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]
rewritten = pat.sub(lambda _: repl, b"function generateReport(format){ return data; }").decode()

# The page exposes its own deriver; it must also see the *filtered* arrays.
deriver = """const data = {
  suggestions: [ { title: 'Fix Architecture Violations', desc: '375 layer violations found.' } ],
  layerViolations: [ { from: 'a.ts', to: 'b.ts', fromLayer: 'ui', toLayer: 'db' } ],
  duplicates: [ { type: 'code', name: 'withEnv, exec, cacheGet', files: [ { file: 'a.ts' } ] } ],
  issues: [], stats: { dead: 3 }, securityIssues: [], files: []
};
const Parser = { generateSuggestions: function (d) {
  globalThis.__deriverSaw = { layers: d.layerViolations.length, duplicates: d.duplicates.length };
  return [ { title: 'Remove Dead Code', desc: d.stats.dead + ' unused functions detected.' } ];
} };
const piFpFilter = require(process.argv[2]);
""" + rewritten + """
generateReport('md');
process.stdout.write('RESULT' + JSON.stringify({ suggestions: data.suggestions, seen: globalThis.__deriverSaw }));
"""
open(sys.argv[3], "w").write(deriver)

# A page with Parser but no deriver: the export still happens, empty, and says so.
missing = """const data = { suggestions: [ { title: 'Fix Security Issues', desc: '9 high-severity issues found.' } ], issues: [], stats: { dead: 0 }, files: [], securityIssues: [], layerViolations: [] };
const Parser = { functionKey: function (fn) { return fn.name; } };
const piFpFilter = require(process.argv[2]);
""" + rewritten + """
generateReport('md');
process.stdout.write('RESULT' + JSON.stringify({ suggestions: data.suggestions }));
"""
open(sys.argv[4], "w").write(missing)
`
	scriptPath := filepath.Join(dir, "emit_suggestions.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write emit script: %v", err)
	}
	withDeriver := filepath.Join(dir, "with-deriver.cjs")
	withoutDeriver := filepath.Join(dir, "without-deriver.cjs")
	if out, err := exec.Command(python, scriptPath, serverPath, filterPath, withDeriver, withoutDeriver).CombinedOutput(); err != nil {
		t.Fatalf("emit harnesses: %v\n%s", err, out)
	}

	out, err := exec.Command(node, withDeriver, filterPath).CombinedOutput()
	if err != nil {
		t.Fatalf("deriver harness failed: %v\n%s", err, out)
	}
	want := `RESULT{"suggestions":[{"title":"Remove Dead Code","desc":"3 unused functions detected."}],"seen":{"layers":0,"duplicates":0}}`
	if !strings.Contains(string(out), want) {
		t.Errorf("the served wrapper must re-derive from the filtered data, got: %s\nwant: %s", out, want)
	}
	if strings.Contains(string(out), "derivation unavailable") {
		t.Errorf("the healthy path must stay quiet, got: %s", out)
	}

	out, err = exec.Command(node, withoutDeriver, filterPath).CombinedOutput()
	if err != nil {
		t.Fatalf("missing-deriver harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), `RESULT{"suggestions":[]}`) {
		t.Errorf("a page without a deriver must export no cards, got: %s", out)
	}
	if !strings.Contains(
		string(out),
		"fp-filter: dropped 1 derived suggestion(s): derivation unavailable",
	) {
		t.Errorf("the degradation must be visible on the page's log surface, got: %s", out)
	}
}
