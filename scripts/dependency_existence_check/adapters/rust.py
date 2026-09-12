"""Rust ecosystem adapter: Cargo.toml sections + Cargo.lock transitive marking."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

from ..models import Dependency
from .base import Adapter


class RustAdapter(Adapter):
    language = "rust"
    patterns = ("Cargo.toml", "Cargo.lock")
    priority = 10
    registry_name = "crates"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "Cargo.lock":
            return self._lock(text, path)
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError:
            return []
        deps = []
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            for n, spec in (data.get(section) or {}).items():
                if isinstance(spec, dict):
                    if spec.get("git") or spec.get("path"):
                        continue
                    version = spec.get("version")
                elif isinstance(spec, str):
                    version = spec
                else:
                    version = None
                deps.append(self._dep(n, version, 0, False, path))
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        blocks = re.split(r"^\[\[package\]\]\s*$", text, flags=re.M)
        packages: list[tuple[str, str | None]] = []
        referenced: set[str] = set()
        for block in blocks[1:]:
            nm = re.search(r'^name = "([^"]+)"', block, flags=re.M)
            vm = re.search(r'^version = "([^"]+)"', block, flags=re.M)
            if not nm:
                continue
            packages.append((nm.group(1), vm.group(1) if vm else None))
            head, sep, tail = block.partition("dependencies = [")
            if sep:
                refs = re.findall(r'"([^"]+)"', tail.split("]", 1)[0])
                for r in refs:
                    referenced.add(r.split()[0])
        deps = []
        for n, v in packages:
            deps.append(self._dep(n, v, 0, n in referenced, path, 20))
        return deps