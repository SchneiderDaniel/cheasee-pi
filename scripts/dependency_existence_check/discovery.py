"""Manifest discovery stage: walk, filter, detect, extract.

Owns the walk (and its deterministic order), the gitignore and
`.slopsquat-ignore` filtering, the cheap candidate-name pre-filter and the
adapter dispatch. Imports adapters, matcher and models only — never cli,
transport or registries, so the stage stays offline and testable on its own.

Paths come back absolute: relativization is core's report concern, not this
stage's.
"""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

from .adapters import ADAPTERS
from .matcher import GitignoreMatcher, IgnoreFilter
from .models import Dependency

# Always skipped during discovery regardless of .gitignore rules.
ALWAYS_SKIP_DIRS = {".git", "node_modules"}


def candidate_filename(name: str) -> bool:
    """Cheap basename pre-filter: only read files an adapter could claim.

    Avoids slurping every file of a large tree just to detect() nothing.
    """
    return any(fnmatch.fnmatchcase(name, p)
               for a in ADAPTERS for p in a.patterns)


def collect_dependencies(root: Path, matcher: GitignoreMatcher,
                         ignore: IgnoreFilter) -> list[Dependency]:
    """Every declared dependency under root, in deterministic walk order."""
    collected: list[Dependency] = []
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        rel_dir = here.relative_to(root)
        matcher.load_dir(here)
        dirnames[:] = [d for d in sorted(dirnames)
                       if d not in ALWAYS_SKIP_DIRS
                       and not matcher.matches(rel_dir / d, is_dir=True)]
        for fn in sorted(filenames):
            rel_f = rel_dir / fn
            if matcher.matches(rel_f, is_dir=False) or not candidate_filename(fn):
                continue
            full = here / fn
            text = _read(full)
            if text is None:
                continue
            for adapter in ADAPTERS:
                if adapter.detect(rel_f, text):
                    collected.extend(
                        dep for dep in adapter.extract(text, full)
                        if not ignore.ignored(dep.language, dep.name))
                    break  # first matching grammar wins: no duplicate deps
    return collected


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None  # unreadable manifest (permissions, dir-vs-file): skip
