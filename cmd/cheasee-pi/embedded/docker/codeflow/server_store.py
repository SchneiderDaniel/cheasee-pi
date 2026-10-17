"""Single-slot report and bridge-telemetry stores for the CodeFlow shim.

Both stores are guarded by one lock each and keep no history: the browser (or a
headless run) re-runs the analysis after a restart. The report store also
rejects structurally empty structured exports that would silently drop findings
already held in the other slot.
"""
import json
import re
import threading
import time

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

# Finding-bearing keys of a structured export. A well-formed body can still be
# structurally empty (a stub like {"architectureIssues":[]}); storing one over a
# report that carries findings silently drops duplicates / layer violations /
# suggestions, which have no markdown counterpart. Reference bullets and `###`
# entry headings are how the markdown export marks a finding.
_JSON_FINDING_KEYS = (
    "architectureIssues",
    "unusedFunctions",
    "patterns",
    "securityIssues",
    "duplicates",
    "layerViolations",
    "suggestions",
)
_MD_FINDING_RE = re.compile(rb"(?m)^###[ \t]+\S|^\s*[-*][ \t]+\*\*Affected:")


def _json_has_findings(data):
    return isinstance(data, dict) and any(
        isinstance(data.get(key), list) and data[key] for key in _JSON_FINDING_KEYS
    )


def _markdown_has_findings(body):
    return _MD_FINDING_RE.search(body) is not None


def _parse_stored_json(body):
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _store_json_report(body):
    """Validate and store a JSON-route body; return (http_status, reason).

    400 for a body that is not a JSON object; 409 for a well-formed but
    structurally empty export while either slot still carries findings. The
    consistency check and the slot write share one lock hold, so a concurrent
    rich POST cannot slip between them and leave a stub behind.
    """
    data = _parse_stored_json(body)
    if data is None or not isinstance(data, dict):
        return (400, "invalid-json")
    with _REPORT_LOCK:
        if not _json_has_findings(data):
            md_entry = _REPORTS.get("/api/analysis/report")
            json_entry = _REPORTS.get("/api/analysis/report.json")
            if md_entry is not None and _markdown_has_findings(md_entry[0]):
                return (409, "empty-structured")
            if json_entry is not None and _json_has_findings(_parse_stored_json(json_entry[0])):
                return (409, "empty-structured")
        _REPORTS["/api/analysis/report.json"] = (body, int(time.time() * 1000))
    return (204, None)

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
    return {
        "capturedAt": None, "postedAt": None, "httpStatus": None, "bytes": None,
        "rejectedAt": None, "rejectReason": None,
    }


def _status_store(route):
    with _STATUS_LOCK:
        return dict(_STATUS.get(route) or _status_slot())


# Default refusal reason per status, so every failed POST path (bad length,
# empty, oversize, incomplete) is attributed even without a guard-specific
# reason. Any non-204 is a refusal.
_POST_REJECT_REASONS = {400: "invalid-body", 411: "length-required", 413: "too-large"}


def _record_post(route, http_status, nbytes=None, reason=None):
    """Record that a POST reached the shim, accepted or refused.

    Only an accepted POST (204) clears the rejection fields; every refused POST
    sets `rejectedAt` and a non-empty `rejectReason` (the guard's specific
    reason, or a per-status default). This keeps a 409 followed by a 400/413
    attributed instead of silently cleared.
    """
    with _STATUS_LOCK:
        slot = _STATUS.setdefault(route, _status_slot())
        slot["postedAt"] = int(time.time() * 1000)
        slot["httpStatus"] = http_status
        if nbytes is not None:
            slot["bytes"] = nbytes
        if http_status == 204:
            slot["rejectedAt"] = None
            slot["rejectReason"] = None
        else:
            slot["rejectedAt"] = int(time.time() * 1000)
            slot["rejectReason"] = reason or _POST_REJECT_REASONS.get(http_status, "refused")


def _record_capture(route):
    with _STATUS_LOCK:
        _STATUS.setdefault(route, _status_slot())["capturedAt"] = int(time.time() * 1000)


def _record_client_status(route, http_status):
    with _STATUS_LOCK:
        slot = _STATUS.setdefault(route, _status_slot())
        slot["httpStatus"] = http_status
        if slot["postedAt"] is None:
            slot["postedAt"] = int(time.time() * 1000)
