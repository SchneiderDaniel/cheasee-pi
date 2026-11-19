"""Emit the CommonJS harnesses that execute the served analysis seam.

Run by TestCodeFlowServer_FpFilterSeamBehavior:

    python3 testdata/fp_filter_seam_harness.py <staged server.py> <ok.cjs> <frozen.cjs> <throwing.cjs>

Three harnesses: a healthy analysis, a frozen `data` (the write a page can
reject) and a policy that throws at the application step. The payload lives here,
not in the Go file, because CodeFlow's function counter reads raw text: JS
snippets inside Go string literals would be counted as functions of that Go file
and push it over the god-object ceiling (#2031).
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

ok = """const data = { stats: { security: 1, violations: 0 }, securityIssues: [ { severity: 'high', title: 'Hardcoded Secret', code: '', path: 'x.ts' }, { severity: 'low', title: 'Code Comments', code: '', path: 'src/widget.test.ts' } ], layerViolations: [] };
function buildAnalysisData() { return Promise.resolve(data); }
""" + glue + rewritten + """
runAnalysisData({}).then(function (filtered) {
  process.stdout.write('RESULT' + JSON.stringify({ same: filtered === data, security: data.securityIssues.length, layers: data.layerViolations.length, stats: data.stats }));
}).catch(function (e) { process.stdout.write('THREW:' + e.message); });
"""
open(sys.argv[2], "w").write(ok)

banner = """globalThis.__bridgeSaw = null;
globalThis.__codeflowBridgeReportError = function (m) { globalThis.__bridgeSaw = m; };
"""
frozen = """const data = Object.freeze({ securityIssues: [ { severity: 'high', title: 'Hardcoded Secret', code: '', path: 'x.ts' } ], layerViolations: [] });
function buildAnalysisData() { return Promise.resolve(data); }
""" + banner + glue + rewritten + """
runAnalysisData({}).then(function () { process.stdout.write('FROZENNO_THROW'); })
  .catch(function (e) { process.stdout.write('FROZEN:' + e.constructor.name + ':' + globalThis.__codeflowFpFilterError + ':' + globalThis.__bridgeSaw); });
"""
open(sys.argv[3], "w").write(frozen)

throwing = """const data = { securityIssues: [] };
""" + banner + glue + """
try {
  globalThis.piFpFilterBrowserGlue.applyFalsePositiveFilter(data, { piFpFilter: { sanitizeAnalysisData: function () { throw new Error('fp-filter exploded'); }, readFileFrom: function () { return function () { return null; }; } } });
  process.stdout.write('RESULTNO_THROW');
} catch (e) {
  process.stdout.write('RESULTTHREW:' + e.message + ':' + globalThis.__codeflowFpFilterError + ':' + globalThis.__bridgeSaw);
}
"""
open(sys.argv[4], "w").write(throwing)
