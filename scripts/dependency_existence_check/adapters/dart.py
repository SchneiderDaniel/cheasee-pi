"""Dart ecosystem adapter: pubspec.yaml + pubspec.lock."""

from __future__ import annotations

import re
from pathlib import Path

from ..models import Dependency
from .base import Adapter


class DartAdapter(Adapter):
    language = "dart"
    patterns = ("pubspec.yaml", "pubspec.lock")
    priority = 10
    registry_name = "pub"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "pubspec.lock":
            return self._lock(text, path)
        return self._yaml(text, path)

    def _yaml(self, text: str, path: Path | None) -> list[Dependency]:
        """Minimal indentation-aware parser for dependencies/dev_dependencies."""
        deps = []
        section = None
        cur: list | None = None
        lines = text.splitlines()

        def flush() -> None:
            nonlocal cur
            if cur and not cur[2]:
                deps.append(self._dep(cur[0], None, cur[1], False, path))
            cur = None

        for i, line in enumerate(lines, 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            s = line.strip()
            if indent == 0:
                flush()
                key = s.split(":", 1)[0].strip()
                section = key if key in ("dependencies", "dev_dependencies") else None
                continue
            if section is None:
                continue
            if indent == 2:
                flush()
                m = re.match(r"^([A-Za-z0-9_\-\.]+)\s*:\s*(.*)$", s)
                if not m:
                    continue
                value = m.group(2).strip()
                if value and not value.startswith("#"):
                    deps.append(self._dep(m.group(1), value, i, False, path))
                else:
                    cur = [m.group(1), i, False]
            elif indent >= 4 and cur is not None:
                key = s.split(":", 1)[0].strip()
                if key in ("git", "path", "sdk"):
                    cur[2] = True
        flush()
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        in_packages = False
        cur: list | None = None

        def flush() -> None:
            nonlocal cur
            if cur:
                dep_type = cur[2]
                direct = dep_type is None or dep_type.startswith("direct")
                deps.append(self._dep(cur[0], cur[3], cur[1], not direct, path, 20))
            cur = None

        for i, line in enumerate(text.splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            s = line.strip()
            if indent == 0:
                flush()
                in_packages = s.split(":", 1)[0].strip() == "packages"
                continue
            if not in_packages:
                continue
            if indent == 2:
                flush()
                m = re.match(r"^([A-Za-z0-9_\-\.]+)\s*:", s)
                if m:
                    cur = [m.group(1), i, None, None]
            elif indent == 4 and cur is not None:
                k, _, v = s.partition(":")
                k = k.strip()
                v = v.strip().strip('"')
                if k == "dependency":
                    cur[2] = v
                elif k == "version":
                    cur[3] = v
        flush()
        return deps