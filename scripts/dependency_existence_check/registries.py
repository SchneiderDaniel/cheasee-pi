"""One registry client per package registry, plus the REGISTRIES table.

Re-export shim: the clients live in cohesive sibling modules; this module
keeps the historical import surface (`from .registries import REGISTRIES`).
"""

from __future__ import annotations

from .registry_base import Registry
from .registry_json import CargoRegistry, GoRegistry, NpmRegistry, PypiRegistry
from .registry_meta import MavenRegistry, NugetRegistry
from .registry_other import PackagistRegistry, PubRegistry, RubygemsRegistry
from .registry_simple import ConanRegistry, SwiftRegistry, VcpkgRegistry


REGISTRIES: dict[str, type[Registry]] = {
    "pypi": PypiRegistry,
    "npm": NpmRegistry,
    "go": GoRegistry,
    "crates": CargoRegistry,
    "maven": MavenRegistry,
    "nuget": NugetRegistry,
    "vcpkg": VcpkgRegistry,
    "conan": ConanRegistry,
    "rubygems": RubygemsRegistry,
    "packagist": PackagistRegistry,
    "swift": SwiftRegistry,
    "pub": PubRegistry,
}
