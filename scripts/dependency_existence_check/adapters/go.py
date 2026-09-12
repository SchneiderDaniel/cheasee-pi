"""Go ecosystem adapter: go.mod require blocks (indirect excluded)."""

from __future__ import annotations

from pathlib import Path

from ..models import Dependency
from .base import Adapter


class GoAdapter(Adapter):
    language = "go"
    patterns = ("go.mod",)
    priority = 10
    registry_name = "go"
    inline_marker = "// slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        deps = []
        in_block = False
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith(("module ", "replace ", "exclude ")):
                continue
            if s.startswith("require"):
                rest = s[len("require"):].strip()
                if rest.startswith("("):
                    in_block = True
                    continue
                parts = rest.split()
                if len(parts) >= 2 and "// indirect" not in s:
                    deps.append(self._dep(parts[0], parts[1], i, False, path))
                continue
            if in_block:
                if s == ")":
                    in_block = False
                    continue
                if not s or s.startswith("//"):
                    continue
                parts = s.split()
                if len(parts) >= 2 and "// indirect" not in s:
                    deps.append(self._dep(parts[0], parts[1], i, False, path))
        return deps