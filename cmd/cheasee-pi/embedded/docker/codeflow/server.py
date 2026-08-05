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
to the relative './api/' at serve time, plus a set of byte rewrites (_UI_REWRITES)
that raise the analysis size limits and reword the GitHub-specific dialogs, so the
vendored checkout stays pristine and the UI speaks about local files instead of
the GitHub API it only emulates. Both patches are silent no-ops if upstream
renames the matched strings.

Config (docker/codeflow/config.json, JSON wins over env):
  include_submodules   bool; submodule dirs (from .gitmodules) analyzed only when true (shipped config: true)
  exclude_dirs         list of directory names skipped when walking (default: [".git", "node_modules", "ignore", ".pi"])
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
import subprocess
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
    or [d for d in os.environ.get("EXCLUDE_DIRS", ".git,node_modules,ignore,.pi").split(",") if d]
)
INCLUDE_SUBMODULES = _as_bool(
    _CONFIG.get("include_submodules", os.environ.get("INCLUDE_SUBMODULES", "false"))
)
try:
    PORT = int(_CONFIG.get("port") or os.environ.get("PORT") or 8470)
except (TypeError, ValueError):
    PORT = 8470
HOST = _CONFIG.get("host") or os.environ.get("HOST") or "0.0.0.0"

# Submodule paths from .gitmodules (e.g. {"private-pi", "flask_blogs"}).
# Always parsed: used to exclude the directories when INCLUDE_SUBMODULES is
# false, and to apply each submodule's own .gitignore when it is true.
SUBMODULE_DIRS = set()
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
)

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


def _gitignored(paths):
    """Return the subset of repo-relative paths matched by .gitignore.

    Delegates to `git check-ignore` so real gitignore semantics apply
    (nested .gitignore, negation, dir patterns). Empty set when git is
    unavailable or REPO_ROOT is not a git work tree — no filtering then.
    When INCLUDE_SUBMODULES is true, each submodule's own .gitignore rules
    are applied to the paths inside it as well. Main-repo and submodule
    paths are checked separately: `git check-ignore` errors out (rc 128,
    dropping every result after) when its input contains a path inside a
    submodule gitlink.
    """
    if not paths:
        return set()
    if INCLUDE_SUBMODULES:
        prefixes = tuple(sub + "/" for sub in SUBMODULE_DIRS)
        main_paths = [p for p in paths if not p.startswith(prefixes)]
    else:
        main_paths = paths
    ignored = _check_ignore(REPO_ROOT, main_paths)
    if INCLUDE_SUBMODULES:
        for sub in sorted(SUBMODULE_DIRS):
            prefix = sub + "/"
            sub_paths = [p[len(prefix):] for p in paths if p.startswith(prefix)]
            if not sub_paths:
                continue
            ignored |= {prefix + p for p in _check_ignore(os.path.join(REPO_ROOT, sub), sub_paths)}
    return ignored


def _check_ignore(root, paths):
    """Run `git check-ignore --stdin` under root; return the ignored paths."""
    try:
        proc = subprocess.run(
            ["git", "-C", root, "check-ignore", "--stdin", "-z"],
            input="\0".join(paths) + "\0",
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    if proc.returncode not in (0, 1):  # 0 = matched, 1 = none matched
        return set()  # not a git work tree (e.g. exit 128)
    return {p for p in proc.stdout.split("\0") if p}


def _walk():
    """Yield {path,type,size} for every blob under REPO_ROOT.

    Prunes EXCLUDE_DIRS by directory name, submodule dirs (when
    INCLUDE_SUBMODULES is false) by their .gitmodules path, and any
    path matched by .gitignore (e.g. installed package artifacts).
    """
    entries = []
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        rel_dir = os.path.relpath(dirpath, REPO_ROOT)
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS and d not in _IGNORED_NAMES)
        if not INCLUDE_SUBMODULES and rel_dir in SUBMODULE_DIRS:
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
    # Analysis is tree-driven; gitignored installs (e.g. .pi/git) would
    # otherwise surface as dead code. One batch call, no per-file cost.
    ignored = _gitignored([e["path"] for e in entries])
    return [e for e in entries if e["path"] not in ignored]


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
            for pat, repl in _UI_REWRITES:
                data = pat.sub(lambda _: repl, data)
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

    def log_message(self, format, *args):  # quiet
        pass


if __name__ == "__main__":
    print(f"CodeFlow shim: UI={UI_DIR} REPO_ROOT={REPO_ROOT} port={PORT} host={HOST} excludes={EXCLUDE_DIRS or 'none'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
