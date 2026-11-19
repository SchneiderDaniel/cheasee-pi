"""Emit the CommonJS harnesses that pin the derived `suggestions[]` cards.

Run by TestCodeFlowServer_FpFilterSuggestions:

    python3 testdata/fp_filter_suggestions_harness.py <staged server.py> <with-deriver.cjs> <without-deriver.cjs>

The payload lives here, not in the Go file, because CodeFlow's function counter
reads raw text: JS snippets inside Go string literals would be counted as
functions of that Go file and push it over the god-object ceiling (#2031).
"""

import os
import runpy
import sys

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]
rewritten = pat.sub(lambda _: repl, b"function runAnalysisData(options){ return buildAnalysisData(options); }").decode()
# The page's glue tag publishes one global; the harness publishes the same one.
glue = "globalThis.piFpFilterBrowserGlue = require(%r);" % os.path.join(
    os.path.dirname(sys.argv[1]), "fp-filter", "browser-glue.js")

# The page exposes its own deriver; it must also see the *filtered* arrays.
deriver = """const data = {
  suggestions: [ { title: 'Fix Architecture Violations', desc: '375 layer violations found.' } ],
  layerViolations: [ { from: 'a.ts', to: 'b.ts', fromLayer: 'ui', toLayer: 'db' } ],
  duplicates: [ { type: 'code', name: 'withEnv, exec, cacheGet', files: [ { file: 'a.ts' } ] } ],
  issues: [], stats: { dead: 3 }, securityIssues: [], files: []
};
globalThis.Parser = { generateSuggestions: function (d) {
  globalThis.__deriverSaw = { layers: d.layerViolations.length, duplicates: d.duplicates.length };
  return [ { title: 'Remove Dead Code', desc: d.stats.dead + ' unused functions detected.' } ];
} };
function buildAnalysisData() { return Promise.resolve(data); }
""" + glue + rewritten + """
runAnalysisData({}).then(function () {
  process.stdout.write('RESULT' + JSON.stringify({ suggestions: data.suggestions, seen: globalThis.__deriverSaw }));
}).catch(function (e) { process.stdout.write('THREW:' + e.message); });
"""
open(sys.argv[2], "w").write(deriver)

# A page with Parser but no deriver: the analysis still completes, empty, and says so.
missing = """const data = { suggestions: [ { title: 'Fix Security Issues', desc: '9 high-severity issues found.' } ], issues: [], stats: { dead: 0 }, files: [], securityIssues: [], layerViolations: [] };
globalThis.Parser = { functionKey: function (fn) { return fn.name; } };
function buildAnalysisData() { return Promise.resolve(data); }
""" + glue + rewritten + """
runAnalysisData({}).then(function () {
  process.stdout.write('RESULT' + JSON.stringify({ suggestions: data.suggestions }));
}).catch(function (e) { process.stdout.write('THREW:' + e.message); });
"""
open(sys.argv[3], "w").write(missing)
