"""Headless analysis producer for the CodeFlow shim.

The on-demand run route drives ``run-analysis.mjs``, which reuses the pinned UI
checkout's own analyzer so the artifacts match the browser export. This module
owns the single-flight state machine, the ``git archive HEAD`` snapshot and the
subprocess lifecycle; the runner only produces report.md/report.json and an
envelope on its last stdout line.
"""
import io
import json
import os
import shlex
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time
import uuid

from server_config import REPO_ROOT, RUN_TIMEOUT_S, UI_DIR
from server_store import _MAX_REPORT_BYTES, _REPORTS, _REPORT_LOCK

# --- Headless producer -----------------------------------------------------
# The on-demand run route drives `run-analysis.mjs`, which reuses the pinned
# UI checkout's own analyzer so the artifacts match the browser export. The
# shim owns the single-flight state machine, the `git archive HEAD` snapshot
# and the subprocess lifecycle; the runner only produces report.md/report.json
# and an envelope on its last stdout line. State lives in one dict guarded by
# `_RUN_LOCK`, independent of `_REPORT_LOCK` (slots) and `_STATUS_LOCK`
# (bridge telemetry) so a headless run is never attributed to the browser.
_RUN_ROUTE = "/api/analysis/run"
_RUN_STATUS_ROUTE = "/api/analysis/run-status"
_RUN_ERROR_LIMIT = 4096
_DEFAULT_ANALYZER = (
    "node",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "run-analysis.mjs"),
)

_RUN_LOCK = threading.Lock()
_RUN = {
    "runId": None,
    "state": "idle",
    "startedAt": None,
    "finishedAt": None,
    "reason": None,
    "error": None,
    "reportAt": None,
    "produced": {"markdown": False, "json": False},
}


def _analyzer_command():
    override = os.environ.get("ANALYZER_CMD")
    if override:
        return shlex.split(override)
    return list(_DEFAULT_ANALYZER)


def _analyzer_available():
    """True when the analyzer command can plausibly run.

    The command's first token must resolve (a bare name via PATH, or an
    absolute/relative executable path), and any script argument must exist.
    A missing runner therefore fails the run route loudly (503) instead of
    spawning a doomed process.
    """
    cmd = _analyzer_command()
    if not cmd:
        return False
    exe = cmd[0]
    if os.sep in exe or exe.startswith("."):
        if not (os.path.isfile(exe) and os.access(exe, os.X_OK)):
            return False
    elif shutil.which(exe) is None:
        return False
    for arg in cmd[1:]:
        if arg.endswith((".mjs", ".js", ".cjs", ".py", ".sh")) and not os.path.isfile(arg):
            return False
    return True


def _run_snapshot():
    with _RUN_LOCK:
        snap = dict(_RUN)
        snap["produced"] = dict(_RUN["produced"])
        return snap


def _bounded_text(data):
    return (data or b"")[:_RUN_ERROR_LIMIT].decode("utf-8", "replace").strip()


def _run_failure(reason, error):
    return {
        "reason": reason,
        "error": (error or "")[:_RUN_ERROR_LIMIT],
        "markdown": None,
        "json": None,
        "produced": {"markdown": False, "json": False},
    }


def _member_escapes(member, dest):
    """True when extracting `member` would write outside `dest`.

    `git archive` faithfully reproduces committed symlinks and hardlinks. The
    analyzer reads the extracted tree, so a link whose target resolves outside
    the snapshot would let it read container files outside committed HEAD and
    leak their contents into the report. Absolute paths, `..` traversal and any
    symlink/hardlink that resolves outside `dest` are therefore refused.
    """
    root = os.path.realpath(dest)
    name = member.name
    if not name or os.path.isabs(name) or ".." in name.split("/"):
        return True
    target = os.path.realpath(os.path.join(dest, name))
    if target != root and not target.startswith(root + os.sep):
        return True
    if member.issym() or member.islnk():
        link = member.linkname
        # Symlink targets are relative to the link's directory; hardlink
        # targets are relative to the archive root.
        base = root if member.islnk() else os.path.dirname(target)
        resolved = os.path.realpath(link if os.path.isabs(link) else os.path.join(base, link))
        if resolved != root and not resolved.startswith(root + os.sep):
            return True
    return False


def _extract_snapshot(tf, dest):
    """Extract archive members, skipping any that escape `dest`."""
    tf.extractall(dest, members=[m for m in tf if not _member_escapes(m, dest)])


def _snapshot_head(source):
    """Extract the committed HEAD tree into `source` (git archive, no working tree)."""
    try:
        proc = subprocess.run(
            ["git", "-c", "safe.directory=*", "-C", REPO_ROOT,
             "archive", "--format=tar", "HEAD"],
            capture_output=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if proc.returncode != 0:
        return False
    try:
        with tarfile.open(fileobj=io.BytesIO(proc.stdout)) as tf:
            _extract_snapshot(tf, source)
    except (tarfile.TarError, OSError):
        return False
    return True


def _read_artifact(out_dir, name):
    """Read one runner artifact, refusing to escape `out_dir` through the name."""
    root = os.path.realpath(out_dir)
    target = os.path.realpath(os.path.join(out_dir, name))
    if not target.startswith(root + os.sep) or not os.path.isfile(target):
        return None
    try:
        with open(target, "rb") as fh:
            return fh.read(_MAX_REPORT_BYTES + 1)
    except OSError:
        return None


def _parse_envelope(stdout):
    """Parse the runner's final stdout line as `{markdown,json,analyzedAt}`."""
    text = (stdout or b"").decode("utf-8", "replace").strip()
    if not text:
        return None
    try:
        obj = json.loads(text.splitlines()[-1])
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _kill_process_group(proc):
    """Kill the analyzer and any children it spawned (start_new_session)."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except OSError:
        try:
            proc.kill()
        except OSError:
            pass


def _execute_analysis(source, out_dir):
    """Run the analyzer once and return the result envelope for `_finish_run`."""
    if not _snapshot_head(source):
        return _run_failure("analyzer-error", "could not snapshot committed HEAD")
    cmd = _analyzer_command() + [source, UI_DIR, out_dir]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as exc:
        return _run_failure("analyzer-error", "analyzer spawn failed: %s" % exc)
    try:
        stdout, stderr = proc.communicate(timeout=RUN_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        try:
            proc.communicate(timeout=10)
        except (subprocess.TimeoutExpired, OSError):
            pass
        return _run_failure("timeout", "analysis exceeded %.0fs" % RUN_TIMEOUT_S)
    if proc.returncode != 0:
        return _run_failure(
            "analyzer-error",
            _bounded_text(stderr) or "analyzer exited %d" % proc.returncode,
        )
    envelope = _parse_envelope(stdout)
    if envelope is None:
        return _run_failure("analyzer-error", "analyzer produced no result envelope")
    markdown = _read_artifact(out_dir, envelope.get("markdown") or "report.md")
    if not markdown:
        return _run_failure("no-markdown", "analyzer produced no markdown report")
    if len(markdown) > _MAX_REPORT_BYTES:
        return _run_failure("analyzer-error", "markdown report exceeds the 16 MiB limit")
    json_bytes = None
    json_name = envelope.get("json")
    if isinstance(json_name, str) and json_name:
        json_bytes = _read_artifact(out_dir, json_name)
        if json_bytes is not None and len(json_bytes) > _MAX_REPORT_BYTES:
            return _run_failure("analyzer-error", "json report exceeds the 16 MiB limit")
    return {
        "reason": None,
        "error": None,
        "markdown": markdown,
        "json": json_bytes,
        "produced": {"markdown": True, "json": json_bytes is not None},
    }


def _finish_run(run_id, result):
    """Publish a run result; success writes both slots under one lock hold."""
    at = int(time.time() * 1000)
    with _RUN_LOCK:
        if _RUN.get("runId") != run_id:
            return
        _RUN["finishedAt"] = at
        if result["reason"] is None:
            _RUN.update(
                state="succeeded", reason=None, error=None,
                reportAt=at, produced=dict(result["produced"]),
            )
            # Both slots land together so a fetch never pairs new markdown with
            # stale JSON. The status reader holds the same lock, so seeing
            # `succeeded` guarantees the slots are already written.
            with _REPORT_LOCK:
                _REPORTS["/api/analysis/report"] = (result["markdown"], at)
                if result["json"] is not None:
                    _REPORTS["/api/analysis/report.json"] = (result["json"], at)
                else:
                    _REPORTS.pop("/api/analysis/report.json", None)
        else:
            _RUN.update(
                state="failed", reason=result["reason"], error=result["error"],
                reportAt=None, produced={"markdown": False, "json": False},
            )


def _perform_analysis_run(run_id):
    """Background worker: snapshot, spawn the analyzer, publish the result."""
    tmp = None
    try:
        tmp = tempfile.mkdtemp(prefix="codeflow-run-")
        source = os.path.join(tmp, "src")
        out_dir = os.path.join(tmp, "out")
        os.makedirs(source)
        os.makedirs(out_dir)
        result = _execute_analysis(source, out_dir)
    except Exception as exc:  # noqa: BLE001 - the worker must always reach a terminal state
        result = _run_failure("analyzer-error", "runner crashed: %s" % exc)
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
    _finish_run(run_id, result)


# Rewrites applied to the served index.html. The vendored UI only knows the
# GitHub API; these raise its analysis size limits (upstream guards exist
# because the API is slow and rate-limited — the shim serves files from disk)
# and reword the dialogs that mention GitHub rate limits, zipball archives and
# API samples. Each entry is (compiled regex, replacement bytes) and is a
# silent no-op if upstream changes the string. The reworded dialogs remain
# reachable only for workspaces larger than the raised limits (>10000 files).
