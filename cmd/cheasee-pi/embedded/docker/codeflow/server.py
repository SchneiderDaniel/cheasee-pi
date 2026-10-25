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
  GET /fp-filter.js                   -> the injected false-positive filter

The served page also runs the same false-positive filter the headless runner
applies (`fp-filter.js`), wrapped around `generateReport` at serve time, so the
UI's health score and exports agree with the report pi reads.

Headless producer (Option B): the shim can also fill both report slots without a
browser, so a fresh session or rebuilt container no longer blocks the audit on a
human clicking Analyze. `run-analysis.mjs` reuses the pinned UI checkout's own
analyzer against a `git archive HEAD` snapshot:
  POST /api/analysis/run              -> 202 {runId,state,startedAt}; 409 while a run is in flight; 503 when the analyzer is unavailable
  GET  /api/analysis/run-status       -> 200 {runId,state,startedAt,finishedAt,reason,error,reportAt,produced}
A background thread owns the subprocess; completion writes both slots in one
`_REPORT_LOCK` hold. Run status is kept separate from the bridge telemetry so a
headless run never looks like a browser capture.

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
  run_timeout_s        upper bound on one headless run, seconds (default: 600)

Env (deployment overrides, used when config.json is absent):
  CONFIG_FILE   path to JSON config                (default: <script dir>/config.json)
  REPO_ROOT     directory to analyze               (default: /repo)
  UI_DIR        CodeFlow checkout to serve         (default: /opt/codeflow-ui)
  EXCLUDE_DIRS  comma-separated dir names          (fallback for exclude_dirs)
  PORT          listen port                        (fallback for port)
  HOST          bind address                       (fallback for host)
  FP_TTL        workspace fingerprint memo window, seconds (default: 2.0)
  ANALYZER_CMD  headless analyzer command          (default: node <script dir>/run-analysis.mjs)
  RUN_TIMEOUT_S headless run bound, seconds        (fallback for run_timeout_s)
"""
import base64
import json
import os
import subprocess
import sys
import threading
import time
import urllib
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The shim is a set of sibling modules. Running it as a script already puts this
# directory first on sys.path; a `runpy`/embedded launcher does not, so pin it
# before the sibling imports below.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analysis_run import (
    _RUN,
    _RUN_LOCK,
    _RUN_ROUTE,
    _RUN_STATUS_ROUTE,
    _analyzer_available,
    _perform_analysis_run,
    _run_snapshot,
)
from config import EXCLUDE_DIRS, HOST, PORT, REPO_ROOT, UI_DIR
from repo_identity import _FP_LEN, _fingerprint, _scan, _split_fingerprint, _walk
from report_store import (
    _BRIDGE_STATUS_ROUTE,
    _MAX_REPORT_BYTES,
    _REPORTS,
    _REPORT_LOCK,
    _REPORT_ROUTES,
    _record_capture,
    _record_client_status,
    _record_post,
    _status_store,
    _store_json_report,
)
from ui_rewrites import (
    _API_BASE,
    _BRIDGE_SCRIPT,
    _FP_FILTER_PATH,
    _FP_FILTER_ROUTE,
    _UI_REWRITES,
    _fp_filter_bytes,
    _mime,
)


# --- Browser report bridge -------------------------------------------------
# The JavaScript lives in bridge_js.py; that module documents the capture
# contract. Re-exported under the historical name the tests read.
from bridge_js import BRIDGE_JS as _BRIDGE_JS


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
        if path == _FP_FILTER_ROUTE:
            try:
                self._serve_bytes(_fp_filter_bytes(), "text/javascript; charset=utf-8")
            except OSError as exc:
                self._error(500, "fp-filter.js unavailable: %s" % exc)
            return
        if path == "/codeflow-bridge.js":
            self._serve_bytes(_BRIDGE_JS, "text/javascript; charset=utf-8")
            return
        if path == _BRIDGE_STATUS_ROUTE:
            self._json({route: _status_store(route) for route in _REPORT_ROUTES})
            return
        if path == _RUN_STATUS_ROUTE:
            self._json(_run_snapshot())
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
        if path == _RUN_ROUTE:
            self._run_post()
            return
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

        if path == "/api/analysis/report.json":
            status, reason = _store_json_report(body)
        else:
            with _REPORT_LOCK:
                _REPORTS[path] = (body, int(time.time() * 1000))
            status, reason = 204, None
        if status != 204:
            _record_post(path, status, length, reason=reason)
            self._error(
                status,
                "Structurally empty report refused" if status == 409 else "Invalid report body",
            )
            return
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

    def _run_post(self):
        """Start one headless run; single-flight (409 while one is in flight)."""
        if not _analyzer_available():
            self._json({"reason": "analyzer-unavailable"}, 503)
            return
        with _RUN_LOCK:
            if _RUN["state"] == "running":
                self._json(
                    {"runId": _RUN["runId"], "state": "running", "startedAt": _RUN["startedAt"]},
                    409,
                )
                return
            run_id = uuid.uuid4().hex
            started = int(time.time() * 1000)
            _RUN.update(
                runId=run_id, state="running", startedAt=started,
                finishedAt=None, reason=None, error=None, reportAt=None,
                produced={"markdown": False, "json": False},
            )
        threading.Thread(target=_perform_analysis_run, args=(run_id,), daemon=True).start()
        self._json({"runId": run_id, "state": "running", "startedAt": started}, 202)

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
    # Test affordance: a tight GIL switch interval makes concurrent report POSTs
    # interleave aggressively, so the store-atomicity regression tests can
    # observe a lost update. Unset (and unused) in production.
    _interval = float(os.environ.get("CF_SWITCH_INTERVAL") or 0)
    if _interval > 0:
        sys.setswitchinterval(_interval)
    print(f"CodeFlow shim: UI={UI_DIR} REPO_ROOT={REPO_ROOT} port={PORT} host={HOST} excludes={EXCLUDE_DIRS or 'none'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
