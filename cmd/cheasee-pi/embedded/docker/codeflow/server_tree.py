"""Committed-tree listing and fingerprint for the CodeFlow shim.

The shim serves HEAD's committed tree (never the working tree or index) so the
browser analyzes one immutable snapshot. ``_scan`` memoizes that listing for a
short TTL; ``_fingerprint`` is the content-addressed id the entrypoint redirect
appends so the browser re-analyzes when HEAD changes.
"""
import hashlib
import os
import re
import subprocess
import sys
import time

from server_config import EXCLUDE_DIRS, REPO_ROOT

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
