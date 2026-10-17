"""Deployment configuration for the CodeFlow local shim.

Every value comes from ``config.json`` (JSON wins) or the environment, and is
read once at import so the serving modules share one snapshot.
"""
import json
import os
import re

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
# Upper bound on one headless run. A large workspace takes minutes; a stalled
# analyzer must not hold the single-flight slot forever.
try:
    RUN_TIMEOUT_S = float(_CONFIG.get("run_timeout_s") or os.environ.get("RUN_TIMEOUT_S") or 600)
except (TypeError, ValueError):
    RUN_TIMEOUT_S = 600.0
if RUN_TIMEOUT_S <= 0:
    RUN_TIMEOUT_S = 600.0

# The single hardcoded API base inside index.html, rewritten to a same-origin path.
_API_BASE = re.compile(rb"'https://api\.github\.com/'")
