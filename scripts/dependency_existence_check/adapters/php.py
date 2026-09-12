"""PHP ecosystem adapter: composer.json + composer.lock."""

from __future__ import annotations

import json
from pathlib import Path

from ..models import Dependency
from .base import Adapter


class PhpAdapter(Adapter):
    language = "php"
    patterns = ("composer.json", "composer.lock")
    priority = 10
    registry_name = "packagist"
    inline_marker = None  # JSON carries no comments

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        name = path.name if path else ""
        if name == "composer.lock":
            deps = []
            for section in ("packages", "packages-dev"):
                for pkg in data.get(section) or []:
                    if isinstance(pkg, dict) and pkg.get("name"):
                        deps.append(self._dep(pkg["name"], pkg.get("version"), 0, False, path, 20))
            return deps
        deps = []
        for section in ("require", "require-dev"):
            for n, v in (data.get(section) or {}).items():
                if n == "php" or n.startswith("ext-") or n.startswith("lib-"):
                    continue  # virtual packages, no Packagist lookup
                deps.append(self._dep(n, v if isinstance(v, str) else None, 0, False, path))
        return deps