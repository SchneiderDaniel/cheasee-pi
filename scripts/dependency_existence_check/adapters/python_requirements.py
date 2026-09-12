"""requirements*.txt extraction, including -r include-file recursion."""

from __future__ import annotations

import re
from pathlib import Path

from ..models import Dependency


class RequirementsMixin:
    def _requirements(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        base = (path.parent if path else Path("."))
        seen: set[Path] = set()

        def parse(content: str, bdir: Path, src: str) -> None:
            for i, raw in enumerate(content.splitlines(), 1):
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"-(?:r|requirement)\s+(\S+)", line)
                if m:
                    inc = (bdir / m.group(1)).resolve()
                    if inc in seen:
                        continue
                    seen.add(inc)
                    try:
                        parse(inc.read_text(encoding="utf-8", errors="replace"),
                              inc.parent, str(inc))
                    except OSError:
                        continue
                    continue
                if line.startswith("-"):
                    continue  # other options (-e, -c, -i, ...)
                spec = re.match(
                    r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~;].*)?$", line
                )
                if not spec:
                    continue
                dep_name = spec.group(1)
                if "/" in dep_name or "\\" in dep_name or dep_name.startswith("."):
                    continue  # local paths / VCS, not registry packages
                deps.append(self._dep(dep_name, None, i, False, Path(src)))

        parse(text, base, str(path) if path else "requirements.txt")
        return deps