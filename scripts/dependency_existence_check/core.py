"""Core pipeline: walk -> detect -> extract -> ignore -> dedupe -> query ->
age-check -> report. Never imports manifest or registry detail."""
from __future__ import annotations
import fnmatch
import os
import sys
from pathlib import Path
from .adapters import ADAPTERS
from .helpers import days_since
from .matcher import GitignoreMatcher, IgnoreFilter
from .models import Dependency, RegistryError
from .registries import REGISTRIES, Registry
# Always skipped during discovery regardless of .gitignore rules.
ALWAYS_SKIP_DIRS = {".git", "node_modules"}


def _prefer(a: Dependency, b: Dependency) -> bool:
    """Dedupe winner: direct over transitive, then higher adapter priority."""
    if a.transitive != b.transitive:
        return not a.transitive
    return a.priority > b.priority


def run_check(root: Path, fetcher, threshold_days: int,
              check_transitive: bool, verbose: bool,
              exempt_young: set[tuple[str, str]] | None = None) -> dict:
    matcher = GitignoreMatcher(root)
    ignore = IgnoreFilter(root)
    exempt_young = exempt_young or set()
    adapter_by_lang = {a.language: a for a in ADAPTERS}

    # Cheap basename pre-filter: only read files whose name could match a
    # manifest pattern (avoids slurping every file in large trees).
    def candidate_filename(rel: Path) -> bool:
        return any(fnmatch.fnmatchcase(rel.name, p)
                   for a in ADAPTERS for p in a.patterns)

    collected: list[Dependency] = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        matcher.load_dir(Path(dirpath))
        kept = []
        for d in sorted(dirnames):
            if d in ALWAYS_SKIP_DIRS:
                continue
            rel_d = rel_dir / d
            if matcher.matches(rel_d, is_dir=True):
                continue
            kept.append(d)
        dirnames[:] = kept
        for fn in filenames:
            rel_f = rel_dir / fn
            if matcher.matches(rel_f, is_dir=False):
                continue
            if not candidate_filename(rel_f):
                continue
            full = Path(dirpath) / fn
            try:
                text = full.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for adapter in ADAPTERS:
                if adapter.detect(rel_f, text):
                    collected.extend(adapter.extract(text, full))
                    break

    # Relativize paths, resolve unknown line numbers, apply inline markers.
    file_lines: dict[str, list[str]] = {}

    def lines_of(src: str) -> list[str]:
        if src not in file_lines:
            try:
                file_lines[src] = (root / src).read_text(
                    encoding="utf-8", errors="replace"
                ).splitlines()
            except OSError:
                file_lines[src] = []
        return file_lines[src]

    deps: list[Dependency] = []
    for dep in collected:
        try:
            rel = os.path.relpath(dep.source_file, root) if dep.source_file else ""
        except ValueError:
            rel = dep.source_file
        dep.source_file = rel
        if dep.line == 0:
            probes = [dep.name]
            if ":" in dep.name:
                probes.append(dep.name.split(":", 1)[1])
            elif "/" in dep.name:
                probes.append(dep.name.rsplit("/", 1)[-1])
            for idx, ln in enumerate(lines_of(rel), 1):
                if any(p in ln for p in probes):
                    dep.line = idx
                    break
        marker = adapter_by_lang[dep.language].inline_marker
        if marker and dep.line > 0:
            ls = lines_of(rel)
            if dep.line <= len(ls) and marker in ls[dep.line - 1]:
                continue  # inline slopsquat-ignore marker
        if ignore.ignored(dep.language, dep.name):
            continue
        deps.append(dep)

    # Dedupe by (language, name); lockfiles preferred via priority.
    selected: dict[tuple[str, str], Dependency] = {}
    for dep in deps:
        if check_transitive or not dep.transitive:
            key = (dep.language, dep.name)
            cur = selected.get(key)
            if cur is None or _prefer(dep, cur):
                selected[key] = dep

    registries: dict[str, Registry] = {
        rname: rcls(fetcher) for rname, rcls in REGISTRIES.items()
    }

    checked: list[dict] = []
    failures: list[dict] = []
    for (lang, name), dep in selected.items():
        adapter = adapter_by_lang[lang]
        registry = registries[dep.registry_name or adapter.registry_name]
        try:
            record = registry.check(name)
        except RegistryError as e:
            failures.append(_failure(dep, "registry-unreachable", str(e)))
            continue
        if not record.exists:
            failures.append(_failure(
                dep, "not-found",
                f"Package {name!r} does not exist in the {registry.name} registry",
            ))
            continue
        age_days = None
        if adapter.age_supported:
            age_days = days_since(record.earliest_release_iso)
            if age_days is None:
                failures.append(_failure(
                    dep, "too-young",
                    f"Package {name!r}: registry returned no parseable release date — "
                    f"cannot verify age (fail-closed)",
                ))
                continue
            if threshold_days > 0 and age_days < threshold_days:
                if any(n == dep.name for n, _ in exempt_young):
                    age_days = None  # explicit exemption: known-good release
                else:
                    failures.append(_failure(
                        dep, "too-young",
                        f"Package {name!r} is {age_days} days old — below "
                        f"{threshold_days}-day safety threshold",
                    ))
                    continue
        checked.append({
            "language": dep.language,
            "name": dep.name,
            "version": dep.version,
            "age_days": age_days,
            "source_file": dep.source_file,
            "line": dep.line,
        })

    if verbose:
        for c in checked:
            print(f"  ok  {c['language']}:{c['name']} "
                  f"(v={c['version'] or '?'}, age={c['age_days']}d) "
                  f"[{c['source_file']}:{c['line']}]", file=sys.stderr)
        for f in failures:
            print(f"  FAIL {f['language']}:{f['name']} ({f['reason']}) "
                  f"[{f['source_file']}:{f['line']}]", file=sys.stderr)

    return {
        "ok": len(failures) == 0,
        "threshold_days": threshold_days,
        "checked": checked,
        "failures": failures,
        "cache": {
            "hits": getattr(fetcher.stats, "hits", 0),
            "misses": getattr(fetcher.stats, "misses", 0),
            "requests": getattr(fetcher.stats, "requests", 0),
        },
    }


def _failure(dep: Dependency, reason: str, message: str) -> dict:
    return {
        "language": dep.language,
        "name": dep.name,
        "version": dep.version,
        "reason": reason,
        "message": message,
        "source_file": dep.source_file,
        "line": dep.line,
    }


