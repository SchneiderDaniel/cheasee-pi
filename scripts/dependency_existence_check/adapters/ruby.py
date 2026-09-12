"""Ruby ecosystem adapter: Gemfile, Gemfile.lock, *.gemspec."""

from __future__ import annotations

import re
from pathlib import Path

from ..models import Dependency
from .base import Adapter


class RubyAdapter(Adapter):
    language = "ruby"
    patterns = ("Gemfile", "Gemfile.lock", "*.gemspec")
    priority = 10
    registry_name = "rubygems"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "Gemfile.lock":
            return self._lock(text, path)
        if name == "Gemfile":
            return self._gemfile(text, path)
        return self._gemspec(text, path)

    def _gemfile(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for i, line in enumerate(text.splitlines(), 1):
            m = re.match(r"^gem\s+(['\"])([^'\"]+)\1(.*)$", line.strip())
            if not m:
                continue
            if re.search(r"(^|,)\s*(git|path|github)\s*:", m.group(3)):
                continue  # git/path gems are not registry-checked
            deps.append(self._dep(m.group(2), None, i, False, path))
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        lines = text.splitlines()
        # DEPENDENCIES section (bottom of file) names the direct gems; pre-scan it.
        direct: set[str] = set()
        in_deps = False
        for line in lines:
            if not line.strip():
                continue
            if not line[0].isspace():
                in_deps = line.rstrip(":").strip() == "DEPENDENCIES"
                continue
            if in_deps:
                m = re.match(r"^\s{2}(\S+)", line)
                if m:
                    direct.add(m.group(1))
        deps = []
        section = ""
        in_specs = False
        for i, line in enumerate(lines, 1):
            if not line.strip():
                continue
            if not line[0].isspace():
                section = line.rstrip(":").strip()
                in_specs = False
                continue
            if section != "GEM":
                continue  # GIT/PATH gems are not registry-checked
            if line.strip() == "specs:":
                in_specs = True
                continue
            if in_specs:
                m = re.match(r"^ {4}(\S+) \(([^)]+)\)", line)
                if m:
                    deps.append(self._dep(m.group(1), m.group(2), i,
                                          m.group(1) not in direct, path, 20))
        return deps

    def _gemspec(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for m in re.finditer(
            r"add_(?:runtime_|development_)?dependency\s*\(?\s*['\"]([^'\"]+)['\"]", text
        ):
            deps.append(self._dep(m.group(1), None, 0, False, path))
        return deps