#!/usr/bin/env python3
"""Refactor invariants for the adapters package split (issue #1675).

Pure relocation: these tests pin the import graph, the public re-export
surface, the ADAPTERS snapshot, the per-module LOC budget, and end-to-end
pipeline parity against a pre-split baseline fixture.

Thin entry: the shared harness (importlib shim, FakeFetcher re-use) lives in
`test/dependency_existence_check_refactor/_common.py` and the scenario classes
live in one module each. This file keeps the historical `python3` invocation
path and re-exports `dec` / `_ROOT` / `helper` / `_BASELINE` so the baseline
regeneration snippet below still works when this file is loaded by path:

Run: python3 test/dependency-existence-check-refactor.test.py

Regenerating the baseline fixture (test/fixtures/dependency-existence-worktree-baseline.json)
after intentional dependency-manifest changes:

    python3 -c "
import importlib.util, json, sys
from pathlib import Path
root = Path('.').resolve()
spec = importlib.util.spec_from_file_location('refactor_suite', root/'test/dependency-existence-check-refactor.test.py')
m = importlib.util.module_from_spec(spec); sys.modules['refactor_suite'] = m
spec.loader.exec_module(m)
for c in m.dec.REGISTRIES.values(): c.interval = 0
report = m.dec.run_check(m._ROOT, m.helper.FakeFetcher(default=m.helper.make_response), m.dec.SAFETY_THRESHOLD_DAYS, False, False)
got = [[c['language'], c['name'], c['version'], c['source_file'], c['line']] for c in report['checked']]
Path(m._BASELINE).write_text(json.dumps({'checked': got}, indent=2) + chr(10), encoding='utf-8')
"
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dependency_existence_check_refactor._common import *  # noqa: E402,F401,F403
from dependency_existence_check_refactor.test_baseline import BaselineParityTests  # noqa: E402,F401
from dependency_existence_check_refactor.test_cli_smoke import CliSmokeTests  # noqa: E402,F401
from dependency_existence_check_refactor.test_package_split import PackageSplitTests  # noqa: E402,F401
from dependency_existence_check_refactor.test_public_surface import PublicSurfaceTests  # noqa: E402,F401

if __name__ == "__main__":
    unittest.main(verbosity=2)
