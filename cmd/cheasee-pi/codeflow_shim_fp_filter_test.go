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
// the false-positive filter directly (no HTTP): the analysis seam calls the
// glue once, the old export-time wrapper is gone, a second pass is a
// byte-identical no-op, and bytes without the anchor are untouched. The
// assertion payload is `testdata/fp_filter_rewrite_pure.py`, kept out of this
// file so its JS snippets are not counted as this file's own functions (#2031).
func TestCodeFlowServer_FpFilterRewritePure(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	dir := t.TempDir()
	serverPath := stageCodeflowShim(t, dir)
	out, err := exec.Command(python, "testdata/fp_filter_rewrite_pure.py", serverPath).CombinedOutput()
	if err != nil {
		t.Fatalf("false-positive seam checks failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}

// TestCodeFlowServer_FpFilterSeamBehavior executes the served-page seam: the
// filter runs at analysis completion and writes its result into the same `data`
// object the page scores, so the dashboard and the export cannot disagree. A
// write a frozen `data` rejects must surface on the visible error banner instead
// of aborting silently, and a sanitizer throw must fail closed. The rewritten
// seam comes from the real server.py rewrite; the application step is the real
// fp-filter/browser-glue.js.
func TestCodeFlowServer_FpFilterSeamBehavior(t *testing.T) {
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

	// Three CommonJS harnesses: a healthy analysis, a frozen `data` (the write a
	// page can reject) and a policy that throws at the application step. The
	// emitter lives in `testdata/` so its JS payload is not counted against this
	// file's function ceiling (#2031).
	okHarness := filepath.Join(dir, "ok.cjs")
	frozenHarness := filepath.Join(dir, "frozen.cjs")
	throwingHarness := filepath.Join(dir, "throwing.cjs")
	if out, err := exec.Command(python, "testdata/fp_filter_seam_harness.py",
		serverPath, okHarness, frozenHarness, throwingHarness).CombinedOutput(); err != nil {
		t.Fatalf("emit harnesses: %v\n%s", err, out)
	}

	out, err := exec.Command(node, okHarness).CombinedOutput()
	if err != nil {
		t.Fatalf("analysis harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "RESULT{\"same\":true,\"security\":0,\"layers\":0,\"stats\":{\"security\":0,\"violations\":0}}") {
		t.Errorf("the analysis result must be filtered in place (same object, arrays and stats): %s", out)
	}
	if !strings.Contains(
		string(out),
		"fp-filter: suppressed 1 security issue(s), 0 layer violation(s), 1 hygiene finding(s)",
	) {
		t.Errorf("the served seam must log the same suppression line as the headless runner, got: %s", out)
	}

	out, err = exec.Command(node, frozenHarness).CombinedOutput()
	if err != nil {
		t.Fatalf("frozen-data harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "FROZEN:TypeError:") {
		t.Errorf("a frozen data binding must fail closed, got: %s", out)
	}
	if !strings.Contains(string(out), "false-positive filter failed; report not exported:") {
		t.Errorf("a frozen-data write failure must surface on the visible error handler, got: %s", out)
	}

	out, err = exec.Command(node, throwingHarness).CombinedOutput()
	if err != nil {
		t.Fatalf("throwing-policy harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "RESULTTHREW:fp-filter exploded:fp-filter exploded:false-positive filter failed; report not exported: fp-filter exploded") {
		t.Errorf("sanitizer error must fail closed and surface the failure, got: %s", out)
	}
}

// TestCodeFlowServer_FpFilterServed is the serve-path contract: /fp-filter.js is
// served byte-verbatim as JavaScript, the served index.html references it exactly
// once after the policy-module tags, and the analysis seam calls the glue (issue
// #2147: the export is a pure reader, so there is no wrapper in generateReport).
func TestCodeFlowServer_FpFilterServed(t *testing.T) {
	uiDir := t.TempDir()
	writeShimFile(t, uiDir, "index.html",
		"<script>function runAnalysisData(options){return buildAnalysisData(options);}</script>\n</body>")
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
		"<script src=\"fp-filter/browser-glue.js\" defer></script>",
		"piFpFilterBrowserGlue.applyFalsePositiveFilter(__piFpData)",
		"function __piFpRunAnalysisData(options){return buildAnalysisData(options);}",
	} {
		if n := bytes.Count(body, []byte(want)); n != 1 {
			t.Errorf("served index.html must contain %q exactly once, got %d\nbody: %s", want, n, body)
		}
	}
	// The seam is analysis completion: the glue call precedes the analyzed body,
	// plus nothing of the old export-time wrapper survives.
	if bytes.Index(body, []byte("piFpFilterBrowserGlue.applyFalsePositiveFilter(__piFpData)")) >
		bytes.Index(body, []byte("function __piFpRunAnalysisData(options){return buildAnalysisData(options);}")) {
		t.Errorf("the glue call must precede the body it filters")
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
// (issue #2030): the application step passes the page's own
// `Parser.generateSuggestions` as the deriver and the seam writes the reconciled
// array back, so the served UI cannot show cards naming findings the filter just
// dropped. With no deriver available the cards are dropped and the degradation is
// logged — never silently exported.
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

	// The emitter lives in `testdata/` so its JS payload is not counted against
	// this file's function ceiling (#2031).
	withDeriver := filepath.Join(dir, "with-deriver.cjs")
	withoutDeriver := filepath.Join(dir, "without-deriver.cjs")
	if out, err := exec.Command(python, "testdata/fp_filter_suggestions_harness.py",
		serverPath, withDeriver, withoutDeriver).CombinedOutput(); err != nil {
		t.Fatalf("emit harnesses: %v\n%s", err, out)
	}

	out, err := exec.Command(node, withDeriver).CombinedOutput()
	if err != nil {
		t.Fatalf("deriver harness failed: %v\n%s", err, out)
	}
	want := `RESULT{"suggestions":[{"title":"Remove Dead Code","desc":"3 unused functions detected."}],"seen":{"layers":0,"duplicates":0}}`
	if !strings.Contains(string(out), want) {
		t.Errorf("the seam must re-derive from the filtered data, got: %s\nwant: %s", out, want)
	}
	if strings.Contains(string(out), "derivation unavailable") {
		t.Errorf("the healthy path must stay quiet, got: %s", out)
	}

	out, err = exec.Command(node, withoutDeriver).CombinedOutput()
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
