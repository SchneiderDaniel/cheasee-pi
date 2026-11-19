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
_FP_FILTER_DIR = os.path.dirname(os.path.abspath(__file__))
_FP_FILTER_PATH = os.path.join(_FP_FILTER_DIR, "fp-filter.js")

# The policy modules `fp-filter.js` is built from, plus the page-side application
# step, in load order: each entry publishes one global the next one (and the
# index) reads, and the index itself loads last. `browser-glue` is the one
# exception to "policy module": it applies the policy to the page's `data` and is
# therefore served here but never loaded by `fp-filter.js`. A path is relative to
# `fp-filter/`, so it doubles as the served name under
# `_FP_FILTER_MODULE_ROUTE`. This tuple is the single allowlist: a request tail is
# looked up in it and never joined to the filesystem, so `..`, an encoded
# separator or an absolute path can only miss and 404.
_FP_FILTER_MODULES = (
    "lexical",
    "hygiene",
    "layer",
    "security/high",
    "security/command-exec-policy",
    "security/command-exec",
    "dead-code",
    "duplicates",
    # Last: it reads the `piFpFilter` global the index publishes, so its tag must
    # follow the policy tags (and still precede the index's own tag only because
    # the index is emitted after every module here — see `_BRIDGE_SCRIPT`).
    "browser-glue",
)
_FP_FILTER_MODULE_ROUTE = "/fp-filter/"
_FP_FILTER_MODULE_DIR = os.path.join(_FP_FILTER_DIR, "fp-filter")
# Served name -> the concrete file, built once from the allowlist above. A
# request therefore selects an entry of this table; the path handed to `open` is
# a value derived from the tuple, never text taken from the request.
_FP_FILTER_MODULE_PATHS = {
    name: os.path.join(_FP_FILTER_MODULE_DIR, name + ".js")
    for name in _FP_FILTER_MODULES
}


def _fp_filter_bytes():
    with open(_FP_FILTER_PATH, "rb") as fh:
        return fh.read()


def _fp_filter_module_name(suffix):
    """The allowlisted module a `/fp-filter/<suffix>` request names, or None.

    `suffix` is the raw request tail, never a path: it must be exactly
    `<allowlisted name>.js`, so `..`, an encoded separator or an absolute path
    can only miss the allowlist.
    """
    if not suffix.endswith(".js"):
        return None
    name = suffix[: -len(".js")]
    return name if name in _FP_FILTER_MODULES else None


def _fp_filter_module_bytes(name):
    """The bytes of one allowlisted policy module.

    `name` selects an entry of `_FP_FILTER_MODULE_PATHS`, so the opened path is a
    value built from the allowlist, never request text: an unlisted name has no
    entry at all. The selected path is then confined to `fp-filter/` exactly like
    `server._serve_ui_file` confines UI paths, so even an entry that pointed
    outside the directory could only fail, never read.
    """
    selected = _FP_FILTER_MODULE_PATHS.get(name)
    if selected is None:
        raise KeyError("not an fp-filter module: %r" % (name,))
    root = os.path.realpath(_FP_FILTER_MODULE_DIR)
    target = os.path.realpath(selected)
    if not target.startswith(root + os.sep):
        raise OSError("fp-filter module escapes its directory: %r" % (name + ".js",))
    if not os.path.isfile(target):
        raise OSError("fp-filter module is not a file under fp-filter/: %r" % (name + ".js",))
    with open(target, "rb") as fh:
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


# The served page's health score, its tabs and its exports must read the same
# analysis snapshot the headless runner reports on (issue #2147). The analyzer's
# raw result is therefore filtered *once*, at analysis completion, by
# `fp-filter/browser-glue.js`, and the filtered fields are written back into the
# very `data` object the page renders. The dashboard score (`calcHealth(data)`,
# recomputed from `data` on every render) and `generateReport()` (a pure reader)
# then cannot disagree.
#
# The seam is the page's own `runAnalysisData(options)` — the single choke point
# every analysis path awaits before `setData` — so this rewrite wraps that
# function and the original (renamed) body follows unchanged. The glue owns the
# whole application: the policy call, the in-place field writes, the
# retained-source release (`files[].piFpSource`, which upstream frees on purpose)
# and the suppression log line the headless runner writes to stderr
# (byte-identical wording, so the two paths cannot drift). A failure — a
# sanitizer throw or a write a frozen `data` rejects — reaches the bridge's
# visible error banner (`window.__codeflowBridgeReportError`) and aborts the
# analysis instead of rendering data the filter never saw. `"use strict"` makes
# a silently-ignored write throw.
#
# `generateReport` is deliberately untouched: filtering there scored the raw
# analyzer output on the dashboard and re-filtered an already-filtered snapshot
# on export.
_FP_SEAM_HEAD = b"function runAnalysisData"
# The wrapper keeps upstream's signature and forwards it, so the spliced call site
# reads exactly like the original. The marker doubles as the idempotence guard
# below: once spliced, the `(` is followed by this text, so a second pass misses.
# The marker starts right after the `(` the anchor consumes, so it can be used as
# a lookahead on the same position.
_FP_SEAM_MARK = b'options) { "use strict"; return Promise.resolve(__piFpRunAnalysisData'
_FP_SEAM_BODY = (
    b"(" + _FP_SEAM_MARK
    + b"(options)).then(function (__piFpData) {"
    b" piFpFilterBrowserGlue.applyFalsePositiveFilter(__piFpData);"
    b" return __piFpData; }); }\n"
    b"function __piFpRunAnalysisData("
)


def _fp_seam_rewrite():
    """(regex, replacement) routing analysis completion through the glue.

    The negative lookahead keeps the rule idempotent: the spliced wrapper is
    recognised by its own marker, while the real function's parameter list is
    spliced in after the renamed header."""
    return (
        re.compile(re.escape(_FP_SEAM_HEAD + b"(") + b"(?!" + re.escape(_FP_SEAM_MARK) + b")"),
        _FP_SEAM_HEAD + _FP_SEAM_BODY,
    )


# Injected before </body> by the entry below; every file is served from this same
# directory tree (the modules and `fp-filter.js` from disk, the bridge from
# `_BRIDGE_JS`). Tags follow `_FP_FILTER_MODULES` order and the index comes last,
# because the index reads the globals the module tags publish.
_BRIDGE_SCRIPT = (
    b"".join(
        b'<script src="fp-filter/%s.js" defer></script>' % name.encode()
        for name in _FP_FILTER_MODULES
    )
    + b'<script src="fp-filter.js" defer></script><script src="codeflow-bridge.js" defer></script>'
)

_UI_REWRITES = (
    # Browser parity for the headless false-positive filter, applied once at
    # analysis completion (so the dashboard score and the exports read the same
    # snapshot). A silent no-op when upstream renames `runAnalysisData` — the
    # recorded-seam fixture test fails instead of letting that pass unnoticed.
    _fp_seam_rewrite(),
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
