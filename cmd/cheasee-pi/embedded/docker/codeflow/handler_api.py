"""Emulated GitHub REST routes for the CodeFlow shim.

Mixed into `server.py`'s `Handler` (the transport: parse, dispatch, encode) so
the route group reads as one unit. The shim ignores repository identity and maps
every `/api/repos/{owner}/{repo}/...` request onto `REPO_ROOT`'s scanned
committed tree, so the browser always analyzes one immutable snapshot:

  GET /api/repos/{owner}/{repo}                      -> {"default_branch": ...}
  GET /api/repos/{owner}/{repo}/git/trees/{branch}   -> {"tree": [blobs...]}
  GET /api/repos/{owner}/{repo}/contents/{path}      -> dir listing or base64 file

Anything else returns 404 and CodeFlow degrades gracefully.
"""
import base64
import subprocess
import urllib.parse

from config import REPO_ROOT
from repo_identity import _scan, _walk


class RepoRoutes:
    """The `/api/repos/*` route group; `_json`/`_not_found` come from Handler."""

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
