"""Public API of the split dependency-existence-check package.

Re-exports every public symbol so the CLI shim and test suite keep working
with the same names and object identities as the original single module.
"""

from __future__ import annotations

from dependency_existence_check.adapters import (
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
from dependency_existence_check.cli import SAFETY_THRESHOLD_DAYS, main
from dependency_existence_check.core import ALWAYS_SKIP_DIRS, run_check
from dependency_existence_check.helpers import days_since
from dependency_existence_check.matcher import GitignoreMatcher, IgnoreFilter
from dependency_existence_check.models import Dependency, PackageRecord, RegistryError
from dependency_existence_check.registries import (
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
from dependency_existence_check.transport import (
    CacheStats,
    DiskCache,
    NoCache,
    RateLimiter,
    RealFetcher,
    USER_AGENT,
)
