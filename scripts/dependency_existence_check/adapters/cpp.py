"""C/C++ ecosystem adapter: vcpkg.json + Conan (txt/py/lock)."""

from __future__ import annotations

import json
import re
from pathlib import Path

from ..models import Dependency
from .base import Adapter


class CppAdapter(Adapter):
    language = "cpp"
    patterns = ("vcpkg.json", "conanfile.txt", "conanfile.py", "conan.lock")
    priority = 10
    registry_name = "vcpkg"  # existence via vcpkg or ConanCenter
    age_supported = False  # neither vcpkg nor ConanCenter stores release dates
    inline_marker = "# slopsquat-ignore"

    def detect(self, rel: Path, text: str) -> bool:
        name = rel.name
        if name in ("vcpkg.json", "conanfile.txt", "conan.lock"):
            return True
        if name == "conanfile.py":
            return "conan" in text or "requires" in text
        return False

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "vcpkg.json":
            return self._vcpkg(text, path)
        if name == "conanfile.txt":
            return self._conan_txt(text, path)
        if name == "conanfile.py":
            return self._conan_py(text, path)
        if name == "conan.lock":
            return self._conan_lock(text, path)
        return []

    def _vcpkg(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        deps = []
        for section in ("dependencies", "host-dependencies"):
            for entry in data.get(section) or []:
                if isinstance(entry, str):
                    deps.append(self._dep(entry, None, 0, False, path, registry_name="vcpkg"))
                elif isinstance(entry, dict) and entry.get("name"):
                    deps.append(self._dep(entry["name"], entry.get("version"), 0, False, path,
                                          registry_name="vcpkg"))
        return deps

    def _conan_txt(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        section = None
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith("["):
                section = s.strip("[]")
                continue
            if section == "requires" and s and not s.startswith("#"):
                deps.append(self._dep(s.split("/")[0].strip(), None, i, False, path,
                                      registry_name="conan"))
        return deps

    def _conan_py(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for m in re.finditer(r"requires\s*=\s*(?:\(|\[)?([^)\]#]*)(?:\)|\])?", text):
            for tok in re.findall(r"['\"]([^'\"]+)['\"]", m.group(1)):
                name = tok.split("/")[0].strip()
                if name:
                    deps.append(self._dep(name, None, 0, False, path, registry_name="conan"))
        return deps

    def _conan_lock(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        deps: list[Dependency] = []

        def walk(obj) -> None:
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if k in ("requires", "build_requires") and isinstance(v, list):
                        for item in v:
                            ref = item.get("ref") if isinstance(item, dict) else item
                            if isinstance(ref, str) and "/" in ref:
                                deps.append(self._dep(ref.split("/")[0], None, 0, False, path,
                                                      registry_name="conan"))
                    else:
                        walk(v)
            elif isinstance(obj, list):
                for v in obj:
                    walk(v)

        walk(data)
        return deps