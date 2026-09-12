"""Swift ecosystem adapter: Package.swift .package(url:) entries."""

from __future__ import annotations

import re
from pathlib import Path

from ..models import Dependency
from .base import Adapter


class SwiftAdapter(Adapter):
    language = "swift"
    patterns = ("Package.swift",)
    priority = 10
    registry_name = "swift"
    age_supported = False  # no central registry with dates; existence via SPI
    inline_marker = "// slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        deps = []
        for m in re.finditer(r'\.package\s*\(\s*url\s*:\s*"([^"]+)"', text):
            url = m.group(1).rstrip("/")
            if url.endswith(".git"):
                url = url[:-4]
            gm = re.search(r"github\.com/([^/]+)/([^/]+)", url)
            if gm:
                deps.append(self._dep(f"{gm.group(1)}/{gm.group(2)}", None, 0, False, path))
            # non-github URLs: best effort, no SPI lookup possible
        return deps