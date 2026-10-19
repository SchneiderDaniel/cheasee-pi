#!/usr/bin/env python3
"""Offline test suite for scripts/dependency-existence-check.py.

No network: every test injects a FakeFetcher (via main(argv, fetcher=...)) that
raises AssertionError on unregistered URLs, so an accidental real registry call
fails the test instead of silently skipping. The cache/ETag tests exercise the
real DiskCache/RealFetcher against a fake transport.

Run:  python3 test/dependency-existence-check.test.py

Split (issue #2005 Long File refactor, narrowed by #2034): the importlib shim
lives here and this module is the family's barrel; the fake registry response
shapes moved to `_routes.py` and the transport fake to `_fakes.py`, so no
member of the family lands over the raw-text function-count ceiling. One
scenario module per `TestCase` class holds the tests.

The package is named `dependency_existence_check_tests`, not
`dependency_existence_check`: the shim below registers the production module
under the latter name in `sys.modules`, so a package of the same name could
not be imported.
"""

# Re-exported: every scenario module does `from ._common import *`, so these
# bindings are their imports (several use `tempfile`, `json`, `Path`, `time`
# without importing anything themselves). Do not prune as unused.
import contextlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import time
import unittest
import urllib.parse
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path
from typing import cast

# `_HERE` is the `test/` directory (this module lives one level deeper), so
# `_HERE.parent` stays the repo root and `_SCRIPTS` stays `scripts/`.
_HERE = Path(__file__).resolve().parent.parent
_SCRIPTS = _HERE.parent / "scripts"
_spec = importlib.util.spec_from_file_location(
    "dependency_existence_check", _SCRIPTS / "dependency-existence-check.py")
assert _spec is not None, "scripts/dependency-existence-check.py must exist"
dec = importlib.util.module_from_spec(_spec)
_loader = _spec.loader
assert _loader is not None, "loaded spec must have a loader"
sys.modules["dependency_existence_check"] = dec  # dataclass machinery requires it
_loader.exec_module(dec)

OLD_ISO = "2020-01-01T00:00:00Z"  # ancient: always passes the 14-day guard

# The siblings are imported *after* `dec` and `OLD_ISO` exist, so their
# `from ._common import ...` back-reference resolves against this partially
# initialized module - `_common` is the family's entry point. Explicit names
# only: a wildcard would make the star propagation order filesystem-dependent.
from ._routes import (  # noqa: E402
    _netloc,
    iso_days_ago,
    make_response,
    not_found_route,
    ok_route,
    pypi_body,
    url_for,
)
from ._fakes import FakeFetcher, run_main, write_repo  # noqa: E402
