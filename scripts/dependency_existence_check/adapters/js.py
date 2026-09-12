"""JavaScript ecosystem adapter: package.json + package-lock.json (v1/v2)."""

from __future__ import annotations

import json
from pathlib import Path

from ..models import Dependency
from .base import Adapter


class JavaScriptAdapter(Adapter):
    language = "javascript"
    patterns = ("package.json", "package-lock.json")
    priority = 10
    registry_name = "npm"
    inline_marker = None  # JSON carries no comments; rely on .slopsquat-ignore

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        if name == "package-lock.json" and isinstance(data.get("packages"), dict):
            return self._lock_v2(data, path)
        if name == "package-lock.json":
            return self._lock_v1(data, path)
        deps = []
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            for n, v in (data.get(section) or {}).items():
                if isinstance(v, str) and v.startswith(
                    ("file:", "link:", "workspace:", "git+", "http://", "https://")
                ):
                    continue  # local/workspace/VCS/URL specs are not registry packages
                deps.append(self._dep(n, v if isinstance(v, str) else None, 0, False, path))
        return deps

    def _lock_v2(self, data: dict, path: Path | None) -> list[Dependency]:
        packages = data.get("packages") or {}
        root = packages.get("") or {}
        direct = set()
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            direct.update((root.get(section) or {}).keys())
        deps = []
        for pkg_path, entry in packages.items():
            if not pkg_path or not pkg_path.startswith("node_modules/"):
                continue
            if isinstance(entry, dict) and entry.get("link"):
                continue  # workspace link, not a registry package
            dep_name = pkg_path.split("node_modules/")[-1]
            top_level = pkg_path.count("node_modules/") == 1
            version = (entry or {}).get("version") if isinstance(entry, dict) else None
            deps.append(self._dep(dep_name, version, 0,
                                  (not top_level) or dep_name not in direct, path, 20))
        return deps

    def _lock_v1(self, data: dict, path: Path | None) -> list[Dependency]:
        deps = []

        def walk(entry: dict, transitive: bool) -> None:
            for n, spec in (entry.get("dependencies") or {}).items():
                version = (spec or {}).get("version") if isinstance(spec, dict) else None
                deps.append(self._dep(n, version, 0, transitive, path, 20))
                if isinstance(spec, dict):
                    walk(spec, True)

        walk(data, False)
        return deps