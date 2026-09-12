"""Dotnet ecosystem adapter: csproj/fsproj/vbproj, packages.config, central props."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from ..helpers import _local
from ..models import Dependency
from .base import Adapter


class DotnetAdapter(Adapter):
    language = "dotnet"
    patterns = ("*.csproj", "*.fsproj", "*.vbproj", "packages.config", "Directory.Packages.props")
    priority = 10
    registry_name = "nuget"
    inline_marker = "<!-- slopsquat-ignore -->"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "packages.config":
            return self._packages_config(text, path)
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        central = name == "Directory.Packages.props"
        for el in root.iter():
            tag = _local(el.tag)
            if central and tag == "PackageVersion":
                include = el.get("Include") or el.get("Update")
                if include:
                    deps.append(self._dep(include, el.get("Version"), 0, False, path, 15))
            elif not central and tag == "PackageReference":
                include = el.get("Include")
                if include:
                    deps.append(self._dep(include, el.get("Version"), 0, False, path))
        return deps

    def _packages_config(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        for el in root.iter():
            if _local(el.tag) == "package":
                pid = el.get("id")
                if pid:
                    deps.append(self._dep(pid, el.get("version"), 0, False, path))
        return deps