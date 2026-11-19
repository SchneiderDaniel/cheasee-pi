"""Pure check of the analysis-seam rewrite (issue #2147).

Run by TestCodeFlowServer_FpFilterRewritePure:

    python3 testdata/fp_filter_rewrite_pure.py <staged server.py>

The assertion payload lives here, not in the Go file, because CodeFlow's function
counter reads raw text: a JS snippet inside a Go string literal would be counted
as a function of that Go file and push it over the god-object ceiling (#2031).
"""

import runpy
import sys

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]

# The filter runs at analysis completion, not at export time, so the dashboard
# score and the exported report read the same filtered data.
src = b"<script>function runAnalysisData(options){return buildAnalysisData(options);}</script>"
out = pat.sub(lambda _: repl, src)
assert out.count(b"function __piFpRunAnalysisData(options){return buildAnalysisData(options);}</script>") == 1, out
assert out.count(b"piFpFilterBrowserGlue.applyFalsePositiveFilter(__piFpData)") == 1, out
assert b'function runAnalysisData(options) { "use strict";' in out, out
assert b"__piFpGenerateReport" not in out, "the export wrapper must be gone: %r" % out
assert b"sanitizeAnalysisData" not in out, "the seam only calls the glue: %r" % out
assert b"data.securityIssues =" not in out, "the seam writes no fields itself: %r" % out
assert pat.sub(lambda _: repl, out) == out, "not idempotent"

raw = b"<script>no analysis seam here</script>"
assert pat.sub(lambda _: repl, raw) == raw, "anchor-free bytes altered: %r" % pat.sub(lambda _: repl, raw)

# The analyzer frees each file's source before the filter can read it; the served
# page must keep it on piFpSource.
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
assert bridge.count(b'<script src="fp-filter/browser-glue.js" defer></script>') == 1, bridge
glue_at = bridge.index(b'<script src="fp-filter/browser-glue.js" defer></script>')
assert glue_at < bridge.index(b'<script src="fp-filter.js" defer></script>'), "the glue loads before the index"
print("OK")
