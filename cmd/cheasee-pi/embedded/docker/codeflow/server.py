#!/usr/bin/env python3
"""CodeFlow local shim — serves the CodeFlow UI and emulates the GitHub REST API
against the mounted repository's committed HEAD tree, so the browser analyzes
one immutable repository snapshot. Working-tree and index changes, along with
untracked workspace artifacts, are not part of that snapshot and are never served.

Emulated endpoints (the only ones CodeFlow's analysis path uses):
  GET /api/repos/{owner}/{repo}                      -> {"default_branch": ...}
  GET /api/repos/{owner}/{repo}/git/trees/{branch}   -> {"tree": [blobs...]}
  GET /api/repos/{owner}/{repo}/contents/{path}      -> dir listing or base64 file
Anything else returns 404 and CodeFlow degrades gracefully.

Browser report bridge (Option A): because CodeFlow's exports are built
client-side, the served index.html is injected with `codeflow-bridge.js`, which
hooks `URL.createObjectURL` and POSTs the captured exports back here:
  GET|POST /api/analysis/report       -> markdown report (single slot, 404 before first POST)
  GET|POST /api/analysis/report.json  -> structured JSON report (single slot)
  GET /codeflow-bridge.js             -> the injected bridge script

The served index.html has its hardcoded 'https://api.github.com/' base rewritten
to the relative './api/' at serve time, plus a set of byte rewrites (_UI_REWRITES)
that raise the analysis size limits, reword the GitHub-specific dialogs, and
register .mts/.cts as TypeScript, so the vendored checkout stays pristine and
the UI speaks about local files instead of the GitHub API it only emulates.
Every patch is a silent no-op if upstream renames the matched strings.

Config (docker/codeflow/config.json, JSON wins over env):
  exclude_dirs         directory names excluded from the served committed tree (default: [".git", "node_modules", "ignore"])
  port                 listen port (default: 8470)
  host                 bind address (default: 0.0.0.0)

Env (deployment overrides, used when config.json is absent):
  CONFIG_FILE   path to JSON config                (default: <script dir>/config.json)
  REPO_ROOT     directory to analyze               (default: /repo)
  UI_DIR        CodeFlow checkout to serve         (default: /opt/codeflow-ui)
  EXCLUDE_DIRS  comma-separated dir names          (fallback for exclude_dirs)
  PORT          listen port                        (fallback for port)
  HOST          bind address                       (fallback for host)
  FP_TTL        workspace fingerprint memo window, seconds (default: 2.0)
"""
import base64
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_FILE = os.environ.get("CONFIG_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))


def _load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as fh:
            cfg = json.load(fh)
        if not isinstance(cfg, dict):
            cfg = {}
    except (OSError, ValueError):
        cfg = {}
    return cfg


_CONFIG = _load_config()
REPO_ROOT = os.environ.get("REPO_ROOT", "/repo")
UI_DIR = os.environ.get("UI_DIR", "/opt/codeflow-ui")
EXCLUDE_DIRS = set(
    _CONFIG.get("exclude_dirs")
    or [d for d in os.environ.get("EXCLUDE_DIRS", ".git,node_modules,ignore").split(",") if d]
)
try:
    PORT = int(_CONFIG.get("port") or os.environ.get("PORT") or 8470)
except (TypeError, ValueError):
    PORT = 8470
HOST = _CONFIG.get("host") or os.environ.get("HOST") or "0.0.0.0"

# The single hardcoded API base inside index.html, rewritten to a same-origin path.
_API_BASE = re.compile(rb"'https://api\.github\.com/'")

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
_BRIDGE_SCRIPT = b'<script src="codeflow-bridge.js" defer></script>'
_BRIDGE_JS = br"""(function () {
  "use strict";
  if (window.__codeflowBridge) return;
  window.__codeflowBridge = true;
  var MD_ENDPOINT = "/api/analysis/report";
  var JSON_ENDPOINT = "/api/analysis/report.json";
  var STATUS_ENDPOINT = "/api/analysis/bridge-status";
  var MD_MARKER = "# CodeFlow Analysis Report";
  var JSON_MARKER = '"architectureIssues"';

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
      el.textContent = "CodeFlow report upload failed: " + message;
    } catch (e) {}
  }

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

  function capture(text) {
    if (typeof text !== "string" || text.length === 0) return;
    if (text.indexOf(MD_MARKER) !== -1) {
      reportStatus(MD_ENDPOINT, "capture", null);
      post(MD_ENDPOINT, text);
    } else if (text.indexOf(JSON_MARKER) !== -1) {
      reportStatus(JSON_ENDPOINT, "capture", null);
      post(JSON_ENDPOINT, text);
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

  // Best-effort auto-trigger. The real export control is an icon button whose
  // label lives in aria-label/title ("Export analysis") - its text node is empty
  // once analysis data exists - and the report formats are menu items labelled
  // "JSON Report" / "Markdown" (CodeFlow index.html b0e82d1). One export per
  // tick: the menu closes after each pick, so reopen it for the next format.
  function labelOf(el) {
    if (!el) return "";
    var attr = "";
    if (el.getAttribute) attr = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "");
    return (attr + " " + (el.textContent || "")).trim();
  }
  function findExportButton() {
    var nodes = document.querySelectorAll("button,[role=button]");
    for (var i = 0; i < nodes.length; i++) {
      if (/export/i.test(labelOf(nodes[i]))) return nodes[i];
    }
    return null;
  }
  function findMenuItem(re) {
    var nodes = document.querySelectorAll(".export-option,[role=menuitem],[role=option],li");
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || "").trim();
      if (re.test(t)) return nodes[i];
    }
    return null;
  }

  var pending = ["JSON Report", "Markdown"];
  var busy = false;
  function trigger() {
    if (busy || pending.length === 0 || !document.body) return;
    var btn = findExportButton();
    if (!btn || btn.disabled) return;
    var label = pending[0];
    busy = true;
    try {
      btn.click();
    } catch (e) {
      busy = false;
      return;
    }
    setTimeout(function () {
      var item = findMenuItem(new RegExp("^" + label.replace(/\s+/g, "\\s+") + "$", "i"));
      if (item) {
        pending.shift();
        try { item.click(); } catch (e) {}
      }
      busy = false;
    }, 60);
  }
  setInterval(trigger, 3000);
})();
"""

# Single-slot, per-route store for the latest browser reports. The handler runs
# under a ThreadingHTTPServer, so the dict is guarded by one lock; readers copy
# the (body, timestamp) pair atomically to avoid a torn read. No history: the
# browser re-runs the analysis after a container restart.
_MAX_REPORT_BYTES = 16 * 1024 * 1024
_REPORT_LOCK = threading.Lock()
_REPORTS = {}  # route -> (body: bytes, at: epoch-ms int)
_REPORT_ROUTES = {
    "/api/analysis/report": "text/markdown; charset=utf-8",
    "/api/analysis/report.json": "application/json; charset=utf-8",
}

# Bridge telemetry: what the browser actually shipped, so a 404 on the JSON
# route can be attributed. `capturedAt` is set when the bridge sees a report
# marker in a Blob, `postedAt`/`httpStatus`/`bytes` are set when this server
# handles a POST (accepted or rejected). A route with `postedAt: null` after a
# run means the export was never POSTed (capture-side gap); a route that was
# posted but still 404s on GET means the route is down. Single slot, like the
# report store: no history across restarts.
_BRIDGE_STATUS_ROUTE = "/api/analysis/bridge-status"
_STATUS_LOCK = threading.Lock()
_STATUS = {}  # route -> {capturedAt, postedAt, httpStatus, bytes}


def _status_slot():
    return {"capturedAt": None, "postedAt": None, "httpStatus": None, "bytes": None}


def _status_store(route):
    with _STATUS_LOCK:
        return dict(_STATUS.get(route) or _status_slot())


def _record_post(route, http_status, nbytes=None):
    """Record that a POST reached the shim, accepted or rejected."""
    with _STATUS_LOCK:
        slot = _STATUS.setdefault(route, _status_slot())
        slot["postedAt"] = int(time.time() * 1000)
        slot["httpStatus"] = http_status
        if nbytes is not None:
            slot["bytes"] = nbytes


def _record_capture(route):
    with _STATUS_LOCK:
        _STATUS.setdefault(route, _status_slot())["capturedAt"] = int(time.time() * 1000)


def _record_client_status(route, http_status):
    with _STATUS_LOCK:
        slot = _STATUS.setdefault(route, _status_slot())
        slot["httpStatus"] = http_status
        if slot["postedAt"] is None:
            slot["postedAt"] = int(time.time() * 1000)


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


_UI_REWRITES = (
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


_GIT_WARNED = False


def _warn_git_unavailable(detail):
    """One-shot stderr warning that the committed tree is unavailable.

    When git cannot list HEAD's tree — missing git, missing worktree/bare
    mount, or no commit yet — the shim serves nothing rather than falling back
    to working-tree files that are absent from the repository snapshot.
    """
    global _GIT_WARNED
    if _GIT_WARNED:
        return
    _GIT_WARNED = True
    print(
        "codeflow-shim: committed tree unavailable (%s); serving no files under %s"
        % (detail, REPO_ROOT),
        file=sys.stderr,
    )


def _committed_blobs():
    """Return blob entries from HEAD's committed tree, or None if unavailable.

    The index and working tree can contain changes absent from HEAD. Listing
    and serving object IDs from HEAD keeps both API routes on one committed
    snapshot. Gitlinks are commits, not blobs, and are omitted.

    `-c safe.directory=*` is load-bearing, not cosmetic. The sidecar runs as
    root while the bind-mounted workspace — and the sibling bare repo its
    worktree `.git` pointer resolves into — are owned by the host user. Git
    then refuses with "fatal: detected dubious ownership" (CVE-2022-24765).
    Trust is scoped to this read-only analyzer container, never the host.
    """
    try:
        proc = subprocess.run(
            ["git", "-c", "safe.directory=*", "-C", REPO_ROOT,
             "ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD"],
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        _warn_git_unavailable("git unavailable: %s" % exc)
        return None
    if proc.returncode != 0:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip()
        _warn_git_unavailable(detail[:300] or "git ls-tree exited %d" % proc.returncode)
        return None

    blobs = []
    for record in proc.stdout.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        _, kind, oid, size = metadata.split(b" ", 3)
        if kind == b"blob":
            blobs.append({
                "path": os.fsdecode(raw_path),
                "type": "blob",
                "size": int(size),
                "oid": oid.decode("ascii"),
            })
    return blobs


# Committed-tree identity for the UI's content-addressed analysis cache: the
# entrypoint redirect appends this fingerprint to the repo segment so the
# browser re-analyzes when HEAD's tree changes, independent of working-tree or
# index changes.
_FP_LEN = 8
try:
    _FP_TTL = float(os.environ.get("FP_TTL") or 2.0)
except (TypeError, ValueError):
    _FP_TTL = 2.0
_scan_cache = None  # (expiry_monotonic, entries)


def _scan():
    """Return HEAD's served blob set, memoized for _FP_TTL seconds.

    One listing shared by the tree API, contents API and fingerprint keeps all
    three on the same committed snapshot. EXCLUDE_DIRS prunes configured paths.
    """
    global _scan_cache
    if _scan_cache is not None and time.monotonic() < _scan_cache[0]:
        return _scan_cache[1]
    entries = [
        e for e in (_committed_blobs() or [])
        if not any(part in EXCLUDE_DIRS for part in e["path"].split("/"))
    ]
    entries.sort(key=lambda e: e["path"])
    # Expiry is measured after scanning so a slow scan still lives a full TTL.
    _scan_cache = (time.monotonic() + _FP_TTL, entries)
    return entries


def _walk():
    """Return {path,type,size} for every scanned blob (GitHub tree shape)."""
    return [{"path": e["path"], "type": e["type"], "size": e["size"]} for e in _scan()]


def _fingerprint(entries):
    """Short hex digest over sorted paths and committed blob object IDs."""
    h = hashlib.sha256()
    for e in sorted(entries, key=lambda e: e["path"]):
        h.update(os.fsencode(e["path"]) + b"\0" + e["oid"].encode("ascii") + b"\0")
    return h.hexdigest()[:_FP_LEN]


_FP_SUFFIX = re.compile(r"^(.*)-([0-9a-f]{%d})$" % _FP_LEN)


def _split_fingerprint(repo):
    """Split a trailing '-<hex>' fingerprint off repo; (base, fp_or_None)."""
    m = _FP_SUFFIX.match(repo)
    return (m.group(1), m.group(2)) if m else (repo, None)


class Handler(BaseHTTPRequestHandler):
    server_version = "CodeFlowShim/1.0"

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-RateLimit-Remaining", "60")
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self):
        self._json({"message": "Not Found", "documentation_url": ""}, 404)

    def _redirect_entrypoint(self, parsed):
        """302 the UI entrypoint to a fingerprinted repo id when one is present.

        Returns True when a redirect was emitted, False to serve normally.
        Preserves all query params (including run=1). Idempotent: an already
        current fingerprint is served, and only one suffix is ever applied.
        """
        params = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        repo = next((v for k, v in params if k == "repo"), None)
        if not repo:
            return False
        base, suffix = _split_fingerprint(repo)
        fp = _fingerprint(_scan())
        if suffix == fp:
            return False
        query = urllib.parse.urlencode([(k, base + "-" + fp if k == "repo" else v) for k, v in params])
        # Strip CR/LF so a crafted request target cannot split the response
        # header (CodeQL's recognized sanitizer for header injection).
        location = (parsed.path + "?" + query).replace("\r", "").replace("\n", "")
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # --- Browser bridge + report store --------------------------------
        if path == "/codeflow-bridge.js":
            self._serve_bytes(_BRIDGE_JS, "text/javascript; charset=utf-8")
            return
        if path == _BRIDGE_STATUS_ROUTE:
            self._json({route: _status_store(route) for route in _REPORT_ROUTES})
            return
        if path in _REPORT_ROUTES:
            self._serve_report(path)
            return

        # --- Static UI -----------------------------------------------------
        if path in ("/", "/index.html"):
            if self._redirect_entrypoint(parsed):
                return
            self._serve_ui_file("index.html", patch_api_base=True)
            return
        if path.startswith("/api/"):
            self._api(path)
            return
        self._serve_ui_file(path.lstrip("/"), patch_api_base=False)

    def do_POST(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == _BRIDGE_STATUS_ROUTE:
            self._bridge_status_post()
            return
        if path not in _REPORT_ROUTES:
            # Any body on an unknown path is left unread — close so keep-alive
            # clients do not reuse a desynchronized connection.
            self.close_connection = True
            self._not_found()
            return

        raw_len = self.headers.get("Content-Length") or ""
        try:
            length = int(raw_len)
        except (TypeError, ValueError):
            self.close_connection = True
            _record_post(path, 411)
            self._error(411, "Length Required")
            return
        if length < 0:
            self.close_connection = True
            _record_post(path, 411)
            self._error(411, "Length Required")
            return
        if length == 0:
            _record_post(path, 400, 0)
            self._error(400, "Empty report body")
            return
        if length > _MAX_REPORT_BYTES:
            # Do not read the body — reject on the declared length alone, but
            # record it so an oversize export is visible in bridge-status.
            self.close_connection = True
            _record_post(path, 413, length)
            self._error(413, "Report too large")
            return

        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            _record_post(path, 400, len(body))
            self._error(400, "Incomplete report body")
            return

        with _REPORT_LOCK:
            _REPORTS[path] = (body, int(time.time() * 1000))
        _record_post(path, 204, length)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _bridge_status_post(self):
        """Record a bridge capture/result event ({route, event, httpStatus})."""
        raw_len = self.headers.get("Content-Length") or ""
        try:
            length = int(raw_len)
        except (TypeError, ValueError):
            self.close_connection = True
            self._error(411, "Length Required")
            return
        if length <= 0 or length > _MAX_REPORT_BYTES:
            self.close_connection = True
            self._error(400, "Invalid status body")
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.close_connection = True
            self._error(400, "Invalid status JSON")
            return
        route = payload.get("route") if isinstance(payload, dict) else None
        if route not in _REPORT_ROUTES:
            self.close_connection = True
            self._error(400, "Unknown report route")
            return
        event = payload.get("event")
        if event == "capture":
            _record_capture(route)
        elif event == "result":
            status = payload.get("httpStatus")
            if isinstance(status, bool) or not isinstance(status, int):
                self.close_connection = True
                self._error(400, "Invalid httpStatus")
                return
            _record_client_status(route, status)
        else:
            self.close_connection = True
            self._error(400, "Unknown event")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_report(self, route):
        with _REPORT_LOCK:
            entry = _REPORTS.get(route)
        if entry is None:
            self._not_found()
            return
        body, at = entry
        self.send_response(200)
        self.send_header("Content-Type", _REPORT_ROUTES[route])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Codeflow-Analysis-At", str(at))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        body = json.dumps({"message": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_ui_file(self, rel, patch_api_base):
        target = os.path.realpath(os.path.join(UI_DIR, rel))
        if not target.startswith(os.path.realpath(UI_DIR) + os.sep) or not os.path.isfile(target):
            self._not_found()
            return
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            self._not_found()
            return
        if patch_api_base:
            data = _API_BASE.sub(b"'api/'", data)
            for pat, repl in _UI_REWRITES:
                data = pat.sub(lambda _: repl, data)
        self.send_response(200)
        self.send_header("Content-Type", _mime(os.path.basename(target)).replace("\r", "").replace("\n", ""))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # --- Emulated GitHub API ----------------------------------------------
    def _api(self, path):
        # /api/repos/{owner}/{repo}/[...]
        parts = [urllib.parse.unquote(p) for p in path[len("/api/"):].split("/") if p]
        if len(parts) < 3 or parts[0] != "repos":
            self._not_found()
            return
        _, owner, repo = parts[:3]
        rest = parts[3:]
        del owner, repo  # shim ignores identity; everything maps to REPO_ROOT

        if not rest:  # repo metadata
            self._json({"default_branch": "main"})
            return

        if rest[0] == "git" and len(rest) == 3 and rest[1] == "trees":
            self._json({"tree": _walk(), "truncated": False})
            return

        if rest[0] == "contents":
            self._list_contents("/".join(rest[1:]))
            return

        self._not_found()

    def _list_contents(self, rel):
        """Serve GET /contents/{rel} from the scanned committed tree."""
        rel = rel.strip("/")
        prefix = rel + "/" if rel else ""
        scanned = _scan()
        entries = []
        seen = set()
        for e in scanned:
            path = e["path"]
            if prefix and not path.startswith(prefix):
                continue
            name, sep, _ = path[len(prefix):].partition("/")
            if not name or name in seen:
                continue
            seen.add(name)
            if sep:
                entries.append({"type": "dir", "path": prefix + name, "name": name})
            else:
                entries.append({"type": "file", "path": path, "name": name, "size": e["size"]})
        if entries or not rel:
            self._json(entries)
            return
        for e in scanned:
            if e["path"] == rel:
                self._file_contents(e["oid"])
                return
        self._not_found()

    def _file_contents(self, oid):
        try:
            proc = subprocess.run(
                ["git", "-c", "safe.directory=*", "-C", REPO_ROOT, "cat-file", "blob", oid],
                capture_output=True,
                timeout=60,
            )
        except (OSError, subprocess.SubprocessError):
            self._not_found()
            return
        if proc.returncode != 0:
            self._not_found()
            return
        self._json({"content": base64.b64encode(proc.stdout).decode(), "encoding": "base64"})

    def log_message(self, format, *args):  # quiet
        pass


if __name__ == "__main__":
    print(f"CodeFlow shim: UI={UI_DIR} REPO_ROOT={REPO_ROOT} port={PORT} host={HOST} excludes={EXCLUDE_DIRS or 'none'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
