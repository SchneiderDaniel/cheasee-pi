#!/usr/bin/env python3
"""Offline test suite for scripts/dependency-existence-check.py.

No network: every test injects a FakeFetcher (via main(argv, fetcher=...)) that
raises AssertionError on unregistered URLs, so an accidental real registry call
fails the test instead of silently skipping. The cache/ETag tests exercise the
real DiskCache/RealFetcher against a fake transport.

Run:  python3 test/dependency-existence-check.test.py

Split (issue #2005 Long File refactor, narrowed by #2034): this module is the
family's barrel and holds no logic. The importlib shim that binds `dec` lives
in `_loader.py`, the fake registry response shapes in `_routes.py` (which also
owns `OLD_ISO`) and the transport fake in `_fakes.py`, so no member of the
family lands over the raw-text function-count ceiling. One scenario module per
`TestCase` class holds the tests.

Acyclic by construction (issue #2104): the leaves import nothing from this
module, so `_common -> {_loader, _routes, _fakes}` — and never back.

The package is named `dependency_existence_check_tests`, not
`dependency_existence_check`: `_loader.py` registers the production module
under the latter name in `sys.modules`, so a package of the same name could
not be imported.
"""

# Re-exported: every scenario module does `from ._common import *`, so these
# bindings are their imports (several use `tempfile`, `json`, `Path`, `time`
# without importing anything themselves). Do not prune as unused.
import contextlib
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

# Pure barrel: no logic, no shared fact, explicit names only (a wildcard would
# make the star propagation order filesystem-dependent). Leaf first: `_loader`
# binds `dec` and the paths, `_routes` owns `OLD_ISO`, `_fakes` owns the
# transport fake.
from ._loader import _HERE, _SCRIPTS, dec
from ._routes import (  # noqa: F401
    OLD_ISO,
    _netloc,
    iso_days_ago,
    make_response,
    not_found_route,
    ok_route,
    pypi_body,
    url_for,
)
from ._fakes import FakeFetcher, run_main, write_repo  # noqa: F401
