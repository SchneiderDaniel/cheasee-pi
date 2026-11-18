"""Core pipeline: discover -> relativize/locate -> dedupe -> verify ->
report. Sequencing only.

Manifest walking and extraction live in `discovery`; registry lookup, age
policy and the young exemption live in `verify`; per-ecosystem grammar and
registry choice live behind `Adapter` and `Registry.check_dependency`. This
module composes them and shapes the report — it branches on no ecosystem and
on no registry name.
"""
from __future__ import annotations
import os
import sys
from dataclasses import replace
from pathlib import Path
from .adapters import ADAPTERS, Adapter
from .discovery import ALWAYS_SKIP_DIRS, collect_dependencies  # noqa: F401  re-export
from .matcher import GitignoreMatcher, IgnoreFilter
from .models import Dependency
from .registries import REGISTRIES, Registry
from .verify import Selected, check_selected


def _prefer(a: Dependency, b: Dependency) -> bool:
    """Dedupe winner: direct over transitive, then higher adapter priority."""
    if a.transitive != b.transitive:
        return not a.transitive
    return a.priority > b.priority


def run_check(root: Path, fetcher, threshold_days: int,
              check_transitive: bool, verbose: bool,
              exempt_young: set[tuple[str, str]] | None = None) -> dict:
    adapter_by_lang: dict[str, Adapter] = {a.language: a for a in ADAPTERS}
    deps = collect_dependencies(root, GitignoreMatcher(root), IgnoreFilter(root))
    deps = _resolve_sources(deps, root, adapter_by_lang)
    selected = _dedupe(deps, check_transitive)
    registries: dict[str, Registry] = {
        name: cls(fetcher) for name, cls in REGISTRIES.items()
    }
    checked, failures = check_selected(
        [Selected(dep, adapter_by_lang[dep.language]) for dep in selected.values()],
        registries, threshold_days, exempt_young or set(),
    )
    if verbose:
        _print_verbose(checked, failures)
    return {
        "ok": len(failures) == 0,
        "threshold_days": threshold_days,
        "checked": checked,
        "failures": failures,
        "cache": {name: getattr(fetcher.stats, name, 0)
                  for name in ("hits", "misses", "requests")},
    }


def _resolve_sources(deps: list[Dependency], root: Path,
                     adapter_by_lang: dict[str, Adapter]) -> list[Dependency]:
    """Relativize paths, resolve unknown line numbers, drop inline-marked deps."""
    file_lines: dict[str, list[str]] = {}
    kept: list[Dependency] = []
    for dep in deps:
        source_file = _relative(dep, root)
        lines = _lines(root, file_lines, source_file)
        line = dep.line or _locate(dep, lines)
        marker = adapter_by_lang[dep.language].inline_marker
        if marker and line > 0:
            if line <= len(lines) and marker in lines[line - 1]:
                continue  # inline slopsquat-ignore marker
        # records are immutable: resolution is one explicit replace, no mutation
        kept.append(replace(dep, source_file=source_file, line=line))
    return kept


def _relative(dep: Dependency, root: Path) -> str:
    if not dep.source_file:
        return ""
    try:
        return os.path.relpath(dep.source_file, root)
    except ValueError:  # windows drive mismatch: keep the absolute path
        return dep.source_file


def _lines(root: Path, cache: dict[str, list[str]], src: str) -> list[str]:
    if src not in cache:
        try:
            cache[src] = (root / src).read_text(
                encoding="utf-8", errors="replace").splitlines()
        except OSError:
            cache[src] = []
    return cache[src]


def _locate(dep: Dependency, lines: list[str]) -> int:
    """First line mentioning the package; 0 when the format carries no line."""
    probes = [dep.name]
    if ":" in dep.name:
        probes.append(dep.name.split(":", 1)[1])
    elif "/" in dep.name:
        probes.append(dep.name.rsplit("/", 1)[-1])
    for idx, line in enumerate(lines, 1):
        if any(probe in line for probe in probes):
            return idx
    return 0


def _dedupe(deps: list[Dependency],
            check_transitive: bool) -> dict[tuple[str, str], Dependency]:
    """Dedupe by (language, name); direct deps and lockfiles win via priority."""
    selected: dict[tuple[str, str], Dependency] = {}
    for dep in deps:
        if not check_transitive and dep.transitive:
            continue
        key = (dep.language, dep.name)
        current = selected.get(key)
        if current is None or _prefer(dep, current):
            selected[key] = dep
    return selected


def _print_verbose(checked: list[dict], failures: list[dict]) -> None:
    for c in checked:
        print(f"  ok  {c['language']}:{c['name']} "
              f"(v={c['version'] or '?'}, age={c['age_days']}d) "
              f"[{c['source_file']}:{c['line']}]", file=sys.stderr)
    for f in failures:
        print(f"  FAIL {f['language']}:{f['name']} ({f['reason']}) "
              f"[{f['source_file']}:{f['line']}]", file=sys.stderr)
