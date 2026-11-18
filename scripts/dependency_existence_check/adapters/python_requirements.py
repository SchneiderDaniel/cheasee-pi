"""requirements*.txt parsing, including -r include-file recursion."""

from __future__ import annotations

import re
from pathlib import Path

from .python_spec import ParsedSpec

_INCLUDE = re.compile(r"-(?:r|requirement)\s+(\S+)")
_REQUIREMENT = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~;].*)?$"
)


def parse_requirements(text: str, path: Path | None = None) -> list[ParsedSpec]:
    """Translate requirements text into specs, following `-r` includes."""
    specs: list[ParsedSpec] = []
    seen: set[Path] = set()

    def scan(content: str, base: Path, source: Path) -> None:
        for line_no, raw in enumerate(content.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            include = _INCLUDE.match(line)
            if include:
                target = (base / include.group(1)).resolve()
                if target in seen:
                    continue
                seen.add(target)
                try:
                    scan(target.read_text(encoding="utf-8", errors="replace"),
                         target.parent, target)
                except OSError:
                    continue
                continue
            if line.startswith("-"):
                continue  # other options (-e, -c, -i, ...)
            match = _REQUIREMENT.match(line)
            if not match:
                continue
            name = match.group(1)
            if "/" in name or "\\" in name or name.startswith("."):
                continue  # local paths / VCS, not registry packages
            specs.append(ParsedSpec(name, None, line_no, source))

    scan(text, path.parent if path else Path("."),
         path if path else Path("requirements.txt"))
    return specs
