#!/usr/bin/env python3
"""Proactive slopsquatting check: every declared dependency must exist in its
registry and (where the registry exposes dates) be at least 14 days old.

Content-based discovery: walks the repository tree (respecting .gitignore),
detects manifest files by filename and content at any depth, and extracts the
declared dependencies. Lockfiles are preferred over plain manifests where both
exist, because they carry the authoritative resolved dependency set.

Stdlib only (Python 3.11+): json, xml.etree, tomllib, re, urllib, ast.

Exit codes: 0 all pass, 1 findings, 2 usage error.

This entry is a thin re-export shim: the implementation lives in the
scripts/dependency_existence_check/ package, split into models, helpers,
transport, matcher, registries, adapters, core, and cli modules. It
self-bootstraps because it is loaded both directly (sys.path[0] = scripts/)
and by the test suite via importlib spec_from_file_location, where the
package dir is not on sys.path and this file itself stands in for the
package (__path__ is set so dependency_existence_check.<sub> resolves).
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
__path__ = [str(_HERE / "dependency_existence_check")]  # type: ignore[attr-defined]

# Imports from submodules, never `from dependency_existence_check import ...`:
# under the test harness that lookup resolves to this shim mid-execution and
# would raise AttributeError. __init__.py re-exports the same surface.
from dependency_existence_check.adapters import (  # noqa: E402,F401
    ADAPTERS,
    Adapter,
    CppAdapter,
    DartAdapter,
    DotnetAdapter,
    GoAdapter,
    JavaAdapter,
    JavaScriptAdapter,
    PhpAdapter,
    PythonAdapter,
    RubyAdapter,
    RustAdapter,
    SwiftAdapter,
)
from dependency_existence_check.cli import SAFETY_THRESHOLD_DAYS, main  # noqa: E402,F401
from dependency_existence_check.core import ALWAYS_SKIP_DIRS, run_check  # noqa: E402,F401
from dependency_existence_check.helpers import days_since  # noqa: E402,F401
from dependency_existence_check.matcher import GitignoreMatcher, IgnoreFilter  # noqa: E402,F401
from dependency_existence_check.models import (  # noqa: E402,F401
    Dependency,
    PackageRecord,
    RegistryError,
)
from dependency_existence_check.registries import (  # noqa: E402,F401
    REGISTRIES,
    CargoRegistry,
    ConanRegistry,
    GoRegistry,
    MavenRegistry,
    NpmRegistry,
    NugetRegistry,
    PackagistRegistry,
    PubRegistry,
    PypiRegistry,
    Registry,
    RubygemsRegistry,
    SwiftRegistry,
    VcpkgRegistry,
)
from dependency_existence_check.transport import (  # noqa: E402,F401
    CacheStats,
    DiskCache,
    NoCache,
    RateLimiter,
    RealFetcher,
    USER_AGENT,
)

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
