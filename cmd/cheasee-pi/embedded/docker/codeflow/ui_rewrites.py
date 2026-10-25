"""Served-page rewriting: the vendored CodeFlow UI only knows the GitHub API,
so these raise its analysis limits and reword the rate-limit dialogs."""

import mimetypes
import os
import re


# The single hardcoded API base inside index.html, rewritten to a same-origin path.
_API_BASE = re.compile(rb"'https://api\.github\.com/'")

# checkout stays pristine.
# The headless runner requires the same module before it builds its exports, so
# the two paths share one policy. Served from disk next to this file.
_FP_FILTER_ROUTE = "/fp-filter.js"
_FP_FILTER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fp-filter.js")


def _fp_filter_bytes():
    with open(_FP_FILTER_PATH, "rb") as fh:
        return fh.read()
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


# Injected before </body> by the entry below; the two files are served from this
# same directory (fp-filter.js from disk, the bridge from `_BRIDGE_JS`).
_BRIDGE_SCRIPT = b'<script src="fp-filter.js" defer></script><script src="codeflow-bridge.js" defer></script>'

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
