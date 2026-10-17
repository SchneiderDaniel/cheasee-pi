"""Served-page byte rewrites for the CodeFlow local shim.

The vendored UI only knows the GitHub API. These rewrites (a) point its hardcoded
API base at the local shim, (b) raise its analysis size limits and reword the
GitHub-specific dialogs, (c) register ``.mts``/``.cts`` as TypeScript, (d) inject
the report bridge, and (e) wrap ``generateReport`` in the same false-positive
filter the headless runner applies. Each entry is a silent no-op when upstream
renames the matched string. The served assets (``_BRIDGE_JS``, ``fp-filter.js``)
and the MIME override live here so the shim and the headless path share one
policy.
"""
import mimetypes
import os
import re

# --- Browser report bridge -------------------------------------------------
# CodeFlow builds its report exports in the browser (generateReport('md'|
# 'json')) and triggers Blob downloads; there is no server route. The bridge
# below hooks URL.createObjectURL, captures the report Blobs and POSTs them back
# to /api/analysis/report (markdown) and /api/analysis/report.json (structured),
# so pi can read the analysis over HTTP. Markdown alone omits duplicates, layer
# violations and suggestions — hence the JSON route. The bridge is injected into
# the served index.html by a _UI_REWRITES entry (silent no-op if upstream drops
# the </body> tag) and served from this in-process constant, so the vendored
# checkout stays pristine.
# The headless runner requires the same module before it builds its exports, so
# the two paths share one policy. Served from disk next to this file.
_FP_FILTER_ROUTE = "/fp-filter.js"
_FP_FILTER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fp-filter.js")


def _fp_filter_bytes():
    with open(_FP_FILTER_PATH, "rb") as fh:
        return fh.read()


_BRIDGE_SCRIPT = b'<script src="fp-filter.js" defer></script><script src="codeflow-bridge.js" defer></script>'
_BRIDGE_JS = br"""(function () {
  "use strict";
  if (window.__codeflowBridge) return;
  window.__codeflowBridge = true;
  var MD_ENDPOINT = "/api/analysis/report";
  var JSON_ENDPOINT = "/api/analysis/report.json";
  var STATUS_ENDPOINT = "/api/analysis/bridge-status";
  var MD_MARKER = "# CodeFlow Analysis Report";

  // Surface upload failures (413 oversize, 5xx, network) instead of swallowing
  // them: a failed POST leaves the endpoint empty, and pi would then only say
  // "no analysis yet" as if the browser had never run one. The banner stays
  // until a later upload succeeds.
  function reportError(message) {
    try { console.error("[codeflow-bridge] " + message); } catch (e) {}
    try { window.__codeflowBridgeError = message; } catch (e) {}
    try {
      if (!document.body) return;
      var el = document.getElementById("codeflow-bridge-error");
      if (!el) {
        el = document.createElement("div");
        el.id = "codeflow-bridge-error";
        el.style.cssText =
          "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#7f1d1d;" +
          "color:#fff;font:12px/1.5 monospace;padding:8px 12px;white-space:pre-wrap";
        document.body.appendChild(el);
      }
      el.textContent = "CodeFlow report error: " + message;
    } catch (e) {}
  }

  // The served false-positive filter wrapper (see _FP_WRAPPER_BODY) calls this
  // so a sanitizer failure is shown in the banner, not only logged to console.
  try { window.__codeflowBridgeReportError = reportError; } catch (e) {}

  function post(url, text) {
    try {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: text,
      }).then(function (res) {
        reportStatus(url, "result", res.status);
        if (!res.ok) {
          reportError(
            url + " -> HTTP " + res.status +
            (res.status === 413 ? " (report exceeds the 16 MiB limit)" : "")
          );
        } else {
          try { window.__codeflowBridgeError = null; } catch (e) {}
        }
      }).catch(function (err) {
        reportError(url + " unreachable: " + ((err && err.message) || err));
      });
    } catch (e) {
      reportError(url + " failed: " + ((e && e.message) || e));
    }
  }

  // Best-effort telemetry: tells the shim which route a Blob matched and how
  // the upload ended, so a later 404 can be attributed to a capture gap (never
  // POSTed) versus a route fault (POSTed but unreadable). Fire-and-forget.
  function reportStatus(route, event, httpStatus) {
    try {
      fetch(STATUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: route, event: event, httpStatus: httpStatus }),
      }).catch(function () {});
    } catch (e) {}
  }

  // Classify a captured export by structure, not substring: the JSON export
  // embeds the markdown marker inside the source snippets it carries, so a
  // marker-first indexOf misroutes JSON to the markdown route (the JSON route
  // then stays empty and the fetch reports no structured report at all).
  function classify(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    try {
      var o = JSON.parse(text);
      if (o && typeof o === "object" && !Array.isArray(o) && Array.isArray(o.architectureIssues))
        return "json";
    } catch (e) {}
    return text.indexOf(MD_MARKER) !== -1 ? "md" : null;
  }

  function capture(text) {
    var format = classify(text);
    if (format === "json") {
      reportStatus(JSON_ENDPOINT, "capture", null);
      post(JSON_ENDPOINT, text);
    } else if (format === "md") {
      reportStatus(MD_ENDPOINT, "capture", null);
      post(MD_ENDPOINT, text);
    }
  }

  // Capture seam: every export becomes a Blob and goes through
  // URL.createObjectURL before download. Hook the browser global (not the
  // bundle-scoped generateReport, which is minified and unreachable by name).
  var originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    var url = originalCreateObjectURL.apply(this, arguments);
    try {
      if (obj && typeof obj.text === "function") {
        obj.text().then(capture).catch(function () {});
      }
    } catch (e) {}
    return url;
  };
})();
"""

# Single-slot, per-route store for the latest browser reports. The handler runs
# under a ThreadingHTTPServer, so the dict is guarded by one lock; readers copy
# the (body, timestamp) pair atomically to avoid a torn read. No history: the
# browser re-runs the analysis after a container restart.

# Rewrites applied to the served index.html. The vendored UI only knows the
# GitHub API; these raise its analysis size limits (upstream guards exist
# because the API is slow and rate-limited — the shim serves files from disk)
# and reword the dialogs that mention GitHub rate limits, zipball archives and
# API samples. Each entry is (compiled regex, replacement bytes) and is a
# silent no-op if upstream changes the string. The reworded dialogs remain
# reachable only for workspaces larger than the raised limits (>10000 files).

def _msg_re(*parts):
    """Regex for a JS message built from quoted string literals and bare
    identifiers (files.length, HARD_LIMIT) concatenated with '+', as the
    upstream minifier emits it — the '+' may sit on its own line with
    indentation, so segments are joined by a whitespace-tolerant separator."""
    pat = []
    for kind, text in parts:
        if kind == "id":
            pat.append(re.escape(text))
        else:
            pat.append("'" + re.escape(text) + "'")
    return re.compile(r"\s*\+\s*".join(pat).encode())


# TypeScript under NodeNext ESM/CJS resolution: the vendored analyzer lists only
# .ts/.tsx in its three file-classification tables, so .mts/.cts files are
# silently dropped before analysis. Declared once and spliced into all three.
_TS_EXTS = (b"'.mts'", b"'.cts'")
_TS_INS = b"," + b",".join(_TS_EXTS)


def _ts_rewrite(anchor, tail=b""):
    """(regex, replacement) inserting _TS_EXTS between `anchor` and `tail`.

    `anchor` ends at a classification list's last known extension; the
    extensions are spliced in directly after it. The negative lookahead keeps
    the rule idempotent: once applied the anchor is followed by _TS_INS, so a
    second pass cannot duplicate the extensions."""
    return (
        re.compile(re.escape(anchor + tail) + b"(?!" + re.escape(_TS_INS) + b")"),
        anchor + _TS_INS + tail,
    )


# Rewrites applied to the served page. The page's `generateReport` gets the same
# false-positive filter the headless runner applies, so the served UI's health
# score and exports agree with the report pi reads. The filter reads cited files
# from `data.files[].content`; a page that omits them still gets the rules that
# need no file. The wrapper filters `data` first, then calls the original
# (renamed) function, and logs the same suppression line the headless runner
# writes to stderr (byte-identical wording, so the two paths cannot drift).
#
# The wrapper also releases the retained source (`files[].piFpSource`) once the
# filter has read it: upstream frees that text on purpose, and a large scan must
# not pin it in the tab after the report is built.
#
# It overwrites the *properties* of `data` (the finding arrays, the dead-function
# list and the stats counts) instead of rebinding `data`:
# a page that declares `data` as a constant cannot be reassigned, and the former
# reassignment threw, was swallowed, and exported the unfiltered report. The
# assignments sit inside the same try as the filter call, so a write that a
# frozen `data` rejects is reported through the bridge's visible error banner
# (`window.__codeflowBridgeReportError`) exactly like a sanitizer throw — never
# an unannounced abort. A failure propagates and fails closed rather than
# emitting data the filter never saw. `"use strict"` makes a silently-ignored
# write (a frozen `data`) throw instead.
_FP_WRAPPER_HEAD = b"function generateReport"
_FP_WRAPPER_BODY = (
    b'() { "use strict";'
    b" var __piFp;"
    b" try {"
    b" __piFp = piFpFilter.sanitizeAnalysisData(data, piFpFilter.readFileFrom(data));"
    b' if ("files" in data && Array.isArray(data.files)) data.files.forEach(function (f) { if (f) f.piFpSource = null; });'
    b' if ("securityIssues" in __piFp.data) data.securityIssues = __piFp.data.securityIssues;'
    b' if ("layerViolations" in __piFp.data) data.layerViolations = __piFp.data.layerViolations;'
    b' if ("deadFunctions" in __piFp.data) data.deadFunctions = __piFp.data.deadFunctions;'
    b' if ("unusedFunctions" in __piFp.data) data.unusedFunctions = __piFp.data.unusedFunctions;'
    b' if ("duplicates" in __piFp.data) data.duplicates = __piFp.data.duplicates;'
    b' if ("issues" in __piFp.data) data.issues = __piFp.data.issues;'
    b' if ("stats" in __piFp.data) data.stats = __piFp.data.stats;'
    b" } catch (e) { var m = String((e && e.message) || e);"
    b" try { if (globalThis.__codeflowBridgeReportError) globalThis.__codeflowBridgeReportError('false-positive filter failed; report not exported: ' + m); } catch (_) {}"
    b" try { globalThis.__codeflowFpFilterError = m; } catch (_) {} throw e; }"
    b" var __piFpDead = (__piFp.suppressed.deadCode || []).length;"
    b" var __piFpDup = (__piFp.suppressed.duplicates || []).length;"
    b" if (__piFp.suppressed.security.length || __piFp.suppressed.layerViolations.length || __piFp.suppressed.hygiene.length || __piFpDead || __piFpDup) { try {"
    b' console.info("fp-filter: suppressed " + __piFp.suppressed.security.length +'
    b' " security issue(s), " + __piFp.suppressed.layerViolations.length + " layer violation(s), " + __piFp.suppressed.hygiene.length + " hygiene finding(s), " + __piFpDead + " unused function(s), " + __piFpDup + " duplicate group(s)");'
    b" } catch (_) {} }"
    b" return __piFpGenerateReport.apply(this, arguments); }\n"
    b"function __piFpGenerateReport("
)


def _fp_rewrite():
    """(regex, replacement) wrapping the page's own `generateReport`.

    The negative lookahead keeps the rule idempotent: the spliced header is
    followed by `)`, the real one by its parameter list."""
    return (
        re.compile(re.escape(_FP_WRAPPER_HEAD + b"(") + b"(?![)])"),
        _FP_WRAPPER_HEAD + _FP_WRAPPER_BODY,
    )


_UI_REWRITES = (
    # Browser parity for the headless false-positive filter. A silent no-op when
    # upstream renames generateReport.
    _fp_rewrite(),
    # The analyzer frees every file's source (`f.content=null`) before
    # `generateReport` runs, leaving the in-page filter nothing to resolve
    # references against (so it kept every dead-code finding). Keep the text under
    # a private key; fp-filter.js::readFileFrom reads it. A silent no-op when
    # upstream changes that line, in which case the filter fails open (keeps
    # findings) rather than suppressing anything it cannot disprove.
    (
        re.compile(re.escape(b"analyzed.forEach(function(f){f.content=null;});")),
        b"analyzed.forEach(function(f){f.piFpSource=f.content;f.content=null;});",
    ),
    (re.compile(re.escape(b"repoSoft:300,repoMax:750")), b"repoSoft:10000,repoMax:10000"),
    # Hard-limit dialog: "Analyze a GitHub API sample?" — reachable only when a
    # workspace exceeds repoMax (>10000 files).
    (re.compile(re.escape(b"title:'Analyze a GitHub API sample?'")), b"title:'Analyze all local files?'"),
    (_msg_re(
        ("s", "This GitHub repository has "),
        ("id", "files.length"),
        ("s", " analyzable files.\\n\\n"),
        ("s", "The browser cannot read GitHub zipball archives directly because GitHub redirects archive downloads to a CORS-restricted host.\\n\\n"),
        ("s", "For full analysis: download the repository ZIP from GitHub, then use Open ZIP in CodeFlow.\\n\\n"),
        ("s", "Continue now with a "),
        ("id", "HARD_LIMIT"),
        ("s", "-file API sample?"),
    ), b"'This workspace has '+files.length+' analyzable files.\\n\\n'+'CodeFlow reads every file through the local server, so full analysis needs no GitHub downloads.\\n\\n'+'Continue with all '+files.length+' files?'"),
    (re.compile(re.escape(b"confirmLabel:'Analyze sample'")), b"confirmLabel:'Analyze all files'"),
    # Privacy panel: claims every call goes straight to api.github.com.
    (re.compile(re.escape(b"'Direct API Calls'")), b"'Local Analysis'"),
    (re.compile(re.escape(b"'All GitHub API calls go directly from your browser to api.github.com. We have no proxy, no middleware, no way to intercept your data.'")),
     b"'All code analysis runs against files served by the local CodeFlow server. Nothing leaves this machine.'"),
    (re.compile(re.escape(b"'Found '+files.length+' files. Using a '+HARD_LIMIT+'-file API sample. Use Open ZIP for full analysis.'")),
     b"'Found '+files.length+' files. Analyzing all of them.'"),
    # Soft-limit confirm: "Analyze a large repository?" — same rate-limit fiction.
    (_msg_re(
        ("s", "This repository has "),
        ("id", "files.length"),
        ("s", " files.\\n\\n"),
        ("s", "Analyzing larger repositories can take longer and may hit GitHub API rate limits.\\n\\n"),
        ("s", "Tip: add a token or GitHub App for higher limits."),
    ), b"'This workspace has '+files.length+' files.\\n\\n'+'Analyzing larger workspaces can take longer and use significant browser memory.\\n\\n'+'Tip: add exclude patterns to shrink the scan.'"),
    # Startup progress text: shown on every analysis; rate limits are fiction locally.
    (re.compile(re.escape(b"setProgress('Checking rate limit...')")), b"setProgress('Checking workspace...')"),
    # Browser report bridge — injected just before the closing body tag. The
    # real index.html has exactly one </body>. Silent no-op if upstream drops it.
    (re.compile(re.escape(b"</body>")), _BRIDGE_SCRIPT + b"</body>"),
    # File classification: .mts/.cts are TypeScript (NodeNext ESM/CJS), but the
    # vendored analyzer knows only .ts/.tsx and drops them before analysis.
    # Spliced in after the last known extension of each hardcoded list; the
    # codeExts and TypeScript-grammar rules run before the acorn/babel one so
    # its full-literal anchor cannot re-match the already-extended codeExts.
    _ts_rewrite(b"codeExts:['.js','.jsx','.ts','.tsx'"),
    _ts_rewrite(b"typescript:{grammar:'typescript',exts:['.ts'"),
    _ts_rewrite(b"['.js','.jsx','.ts','.tsx'", b",'.mjs','.cjs','.vue','.svelte']"),
)

# Force a correct content type; the stdlib guess misses .wasm on some platforms.
_MIME = {"wasm": "application/wasm", "js": "text/javascript", "mjs": "text/javascript"}


def _mime(path):
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return _MIME.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
