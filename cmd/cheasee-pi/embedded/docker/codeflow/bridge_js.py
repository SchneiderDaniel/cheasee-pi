"""CodeFlow browser report bridge — the JavaScript served at `/codeflow-bridge.js`.

Split out of server.py so the served asset and the handler that serves it stay
separately readable; server.py re-exports it as `_BRIDGE_JS`.
"""

# --- Browser report bridge -------------------------------------------------
# CodeFlow builds its report exports in the browser (generateReport('md'|
# 'json')) and triggers Blob downloads; there is no server route. The bridge
# below hooks URL.createObjectURL, captures the report Blobs and POSTs them back
# to /api/analysis/report (markdown) and /api/analysis/report.json (structured),
# so pi can read the analysis over HTTP. Markdown alone omits duplicates, layer
# violations and suggestions — hence the JSON route. The bridge is injected into
# the served index.html by a _UI_REWRITES entry (silent no-op if upstream drops


BRIDGE_JS = br"""(function () {
  "use strict";
  if (window.__codeflowBridge) return;
  window.__codeflowBridge = true;
  var MD_ENDPOINT = "/api/analysis/report";
  var JSON_ENDPOINT = "/api/analysis/report.json";
  var STATUS_ENDPOINT = "/api/analysis/bridge-status";
  var MD_MARKER = "# CodeFlow Analysis Report";

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
      el.textContent = "CodeFlow report error: " + message;
    } catch (e) {}
  }

  // The served false-positive filter wrapper (see _FP_WRAPPER_BODY) calls this
  // so a sanitizer failure is shown in the banner, not only logged to console.
  try { window.__codeflowBridgeReportError = reportError; } catch (e) {}

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

  // Classify a captured export by structure, not substring: the JSON export
  // embeds the markdown marker inside the source snippets it carries, so a
  // marker-first indexOf misroutes JSON to the markdown route (the JSON route
  // then stays empty and the fetch reports no structured report at all).
  function classify(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    try {
      var o = JSON.parse(text);
      if (o && typeof o === "object" && !Array.isArray(o) && Array.isArray(o.architectureIssues))
        return "json";
    } catch (e) {}
    return text.indexOf(MD_MARKER) !== -1 ? "md" : null;
  }

  function capture(text) {
    var format = classify(text);
    if (format === "json") {
      reportStatus(JSON_ENDPOINT, "capture", null);
      post(JSON_ENDPOINT, text);
    } else if (format === "md") {
      reportStatus(MD_ENDPOINT, "capture", null);
      post(MD_ENDPOINT, text);
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
})();
"""
