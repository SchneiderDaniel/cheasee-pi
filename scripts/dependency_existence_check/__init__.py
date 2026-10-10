"""Public API of the split dependency-existence-check package.

Re-exports every public symbol so the CLI shim and test suite keep working
with the same names and object identities as the original single module.
"""

from __future__ import annotations

from .adapters import (
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
from .cli import SAFETY_THRESHOLD_DAYS, main
from .core import ALWAYS_SKIP_DIRS, run_check
from .helpers import days_since
from .matcher import GitignoreMatcher, IgnoreFilter
from .models import Dependency, PackageRecord, RegistryError
from .registries import (
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
from .transport import (
    CacheStats,
    DiskCache,
    NoCache,
    RateLimiter,
    RealFetcher,
    USER_AGENT,
)
