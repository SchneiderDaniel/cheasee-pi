"""Public API of the split dependency-existence-check package.

Re-exports the public symbols the CLI shim and test suite reach by name, with
submodule-import identity. Symbols no caller uses are no longer re-exported
here; import them from their owning submodule.
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
from .core import run_check
from .helpers import days_since
from .matcher import GitignoreMatcher, IgnoreFilter
from .registries import REGISTRIES, GoRegistry, PypiRegistry
from .transport import RealFetcher
