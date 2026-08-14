"""Gitignore-style path matching and the .slopsquat-ignore mechanism."""

from __future__ import annotations

import fnmatch
import re
from pathlib import Path


class GitignoreMatcher:
    """Best-effort gitignore matcher (no pathlib dependency on pathspec).

    Supports: `*`, `?`, `[...]`, `**`, `/`-anchored patterns, `!` negation,
    `#` comments, dir-only trailing `/`. Loaded per-directory during the walk.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.rules: list[tuple[Path, re.Pattern, bool, bool, bool]] = []

    def load_dir(self, dir_abs: Path) -> None:
        gitignore = dir_abs / ".gitignore"
        if not gitignore.is_file():
            return
        base = dir_abs.relative_to(self.root)
        try:
            lines = gitignore.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for line in lines:
            line = line.rstrip()
            if not line or line.startswith("#"):
                continue
            negated = line.startswith("!")
            if negated:
                line = line[1:]
            dir_only = line.endswith("/")
            if dir_only:
                line = line[:-1]
            if not line:
                continue
            leading_slash = line.startswith("/")
            if leading_slash:
                line = line[1:]
            rx = self._translate(line)
            anchored = leading_slash or "/" in line
            self.rules.append((base, rx, negated, dir_only, anchored))

    @staticmethod
    def _translate(pat: str) -> re.Pattern:
        out = []
        i = 0
        n = len(pat)
        while i < n:
            c = pat[i]
            if c == "*":
                if i + 1 < n and pat[i + 1] == "*":
                    if i + 2 < n and pat[i + 2] == "/":
                        out.append("(?:[^/]+/)*")
                        i += 3
                    else:
                        out.append(".*")
                        i += 2
                else:
                    out.append("[^/]*")
                    i += 1
            elif c == "?":
                out.append("[^/]")
                i += 1
            elif c == "[":
                j = i + 1
                if j < n and pat[j] in "!^":
                    j += 1
                if j < n and pat[j] == "]":
                    j += 1
                while j < n and pat[j] != "]":
                    j += 1
                if j < n:
                    cls = pat[i + 1:j]
                    if cls.startswith("!"):
                        cls = "^" + cls[1:]
                    out.append("[" + cls + "]")
                    i = j + 1
                else:
                    out.append(re.escape(c))
                    i += 1
            else:
                out.append(re.escape(c))
                i += 1
        return re.compile("^" + "".join(out) + "$")

    def matches(self, rel: Path, is_dir: bool = False) -> bool:
        """True if the relative path is excluded (after applying negations)."""
        matched = False
        for base, rx, negated, dir_only, anchored in self.rules:
            if dir_only and not is_dir:
                continue
            if anchored:
                try:
                    test = rel.relative_to(base)
                except ValueError:
                    continue
                test_str = str(test)
            else:
                test_str = rel.name
            if rx.match(test_str):
                matched = not negated
        return matched


class IgnoreFilter:
    """Reads `.slopsquat-ignore` at --root (never nested).

    Lines: `# comment`, exact `name`, scoped `lang:name`, globs (`internal-*`).
    """

    def __init__(self, root: Path) -> None:
        self.rules: list[tuple[str | None, str]] = []
        p = root / ".slopsquat-ignore"
        if not p.is_file():
            return
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                lang, pat = line.split(":", 1)
                self.rules.append((lang.strip(), pat.strip()))
            else:
                self.rules.append((None, line))

    def ignored(self, language: str, name: str) -> bool:
        for lang, pat in self.rules:
            if lang is not None and lang != language:
                continue
            if fnmatch.fnmatchcase(name, pat):
                return True
        return False
