#!/usr/bin/env python3
"""CodeFlow local shim — serves the CodeFlow UI and emulates the GitHub REST API
against a mounted repository directory, so the browser can analyze the container's
own codebase (including git submodules, which are plain directories on disk).

Emulated endpoints (the only ones CodeFlow's analysis path uses):
  GET /api/repos/{owner}/{repo}                      -> {"default_branch": ...}
  GET /api/repos/{owner}/{repo}/git/trees/{branch}   -> {"tree": [blobs...]}
  GET /api/repos/{owner}/{repo}/contents/{path}      -> dir listing or base64 file
Anything else returns 404 and CodeFlow degrades gracefully.

The served index.html has its hardcoded 'https://api.github.com/' base rewritten
to the relative './api/' at serve time, so the vendored checkout stays pristine.

Config (docker/codeflow/config.json, JSON wins over env):
  include_submodules   bool; submodule dirs (from .gitmodules) excluded unless true (default: false)
  exclude_dirs         list of directory names skipped when walking (default: [".git", "node_modules", "ignore"])
  port                 listen port (default: 8470)
  host                 bind address (default: 0.0.0.0)

Env (deployment overrides, used when config.json is absent):
  CONFIG_FILE   path to JSON config                (default: <script dir>/config.json)
  REPO_ROOT     directory to analyze               (default: /repo)
  UI_DIR        CodeFlow checkout to serve         (default: /opt/codeflow-ui)
  EXCLUDE_DIRS  comma-separated dir names          (fallback for exclude_dirs)
  INCLUDE_SUBMODULES  true/false                   (fallback for include_submodules)
  PORT          listen port                        (fallback for port)
  HOST          bind address                       (fallback for host)
"""
import base64
import configparser
import json
import mimetypes
import os
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_FILE = os.environ.get("CONFIG_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))


def _as_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes")


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
    or [d for d in os.environ.get("EXCLUDE_DIRS", ".git,node_modules").split(",") if d]
)
INCLUDE_SUBMODULES = _as_bool(
    _CONFIG.get("include_submodules", os.environ.get("INCLUDE_SUBMODULES", "false"))
)
try:
    PORT = int(_CONFIG.get("port") or os.environ.get("PORT") or 8470)
except (TypeError, ValueError):
    PORT = 8470
HOST = _CONFIG.get("host") or os.environ.get("HOST") or "0.0.0.0"

# Submodule paths from .gitmodules (e.g. {"private-pi", "flask_blogs"}); these
# directories are excluded from analysis unless INCLUDE_SUBMODULES is true.
SUBMODULE_DIRS = set()
if not INCLUDE_SUBMODULES:
    gitmodules = os.path.join(REPO_ROOT, ".gitmodules")
    if os.path.isfile(gitmodules):
        try:
            cfg = configparser.ConfigParser()
            cfg.read(gitmodules)
            SUBMODULE_DIRS = {v.get("path", "") for v in cfg.values() if v.get("path")}
        except configparser.Error:
            pass

# The single hardcoded API base inside index.html, rewritten to a same-origin path.
_API_BASE = re.compile(rb"'https://api\.github\.com/'")

# .git appears both as a directory and (inside submodule worktrees) as a pointer
# file; both are meaningless for analysis.
_IGNORED_NAMES = {'.git'}
# Force a correct content type; the stdlib guess misses .wasm on some platforms.
_MIME = {"wasm": "application/wasm", "js": "text/javascript", "mjs": "text/javascript"}


def _mime(path):
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return _MIME.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"


def _safe_path(rel):
    """Resolve a repo-relative path, refusing traversal outside REPO_ROOT."""
    root = os.path.realpath(REPO_ROOT)
    target = os.path.realpath(os.path.join(root, rel.lstrip("/")))
    if target != root and not target.startswith(root + os.sep):
        return None
    return target


def _walk():
    """Yield {path,type,size} for every blob under REPO_ROOT.

    Prunes EXCLUDE_DIRS by directory name and submodule dirs (when
    INCLUDE_SUBMODULES is false) by their .gitmodules path.
    """
    entries = []
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        rel_dir = os.path.relpath(dirpath, REPO_ROOT)
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS and d not in _IGNORED_NAMES)
        if rel_dir in SUBMODULE_DIRS:
            dirnames[:] = []
            continue
        for name in sorted(filenames):
            if name in _IGNORED_NAMES:
                continue
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            try:
                size = os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                continue
            entries.append({"path": rel, "type": "blob", "size": size})
    return entries


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

    def do_GET(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path

        # --- Static UI -----------------------------------------------------
        if path in ("/", "/index.html"):
            self._serve_ui_file("index.html", patch_api_base=True)
            return
        if path.startswith("/api/"):
            self._api(path)
            return
        self._serve_ui_file(path.lstrip("/"), patch_api_base=False)

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
        self.send_response(200)
        self.send_header("Content-Type", _mime(rel))
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
            rel = "/".join(rest[1:])
            target = _safe_path(rel)
            if target is None:
                self._not_found()
                return
            if os.path.isdir(target):
                entries = []
                for name in sorted(os.listdir(target)):
                    full = os.path.join(target, name)
                    rel_child = os.path.join(rel, name) if rel else name
                    if os.path.isdir(full):
                        if rel_child in SUBMODULE_DIRS:
                            continue  # submodule excluded unless INCLUDE_SUBMODULES
                        entries.append({"type": "dir", "path": rel_child, "name": name})
                    elif os.path.isfile(full):
                        try:
                            size = os.path.getsize(full)
                        except OSError:
                            size = 0
                        entries.append({"type": "file", "path": rel_child, "name": name, "size": size})
                self._json(entries)
                return
            if os.path.isfile(target):
                try:
                    with open(target, "rb") as fh:
                        raw = fh.read()
                except OSError:
                    self._not_found()
                    return
                self._json({"content": base64.b64encode(raw).decode(), "encoding": "base64"})
                return
            self._not_found()
            return

        self._not_found()

    def log_message(self, fmt, *args):  # quiet
        pass


if __name__ == "__main__":
    print(f"CodeFlow shim: UI={UI_DIR} REPO_ROOT={REPO_ROOT} port={PORT} host={HOST} excludes={EXCLUDE_DIRS or 'none'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
