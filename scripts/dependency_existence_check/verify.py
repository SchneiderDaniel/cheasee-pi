"""Verification stage: registry lookup, age policy and the young exemption.

Consumes a deduped selection plus the registry table and returns the two report
lists (`checked`, `failures`). Policy lives here so `core` only sequences:
which registry answers, when an age is required, what counts as too young and
what an explicit `--exempt-young` covers.

Imports models and helpers only — no cli, no transport, no manifest grammar
(the adapter travels inside `Selected`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, NamedTuple

from .helpers import days_since
from .models import Dependency, PackageRecord, RegistryError

if TYPE_CHECKING:  # typing only: the stage never imports adapters at runtime
    from .adapters.base import Adapter


class Selected(NamedTuple):
    """One deduped dependency plus the adapter that governs its policy."""

    dep: Dependency
    adapter: "Adapter"


def check_selected(selected: list[Selected], registries: dict, threshold_days: int,
                   exempt_young: set[tuple[str, str]]) -> tuple[list[dict], list[dict]]:
    """Split the selection into passing records and failures."""
    checked: list[dict] = []
    failures: list[dict] = []
    for item in selected:
        dep, adapter = item.dep, item.adapter
        registry = registries[dep.registry_name or adapter.registry_name]
        try:
            record = registry.check_dependency(dep)
        except RegistryError as e:
            failures.append(_failure(dep, "registry-unreachable", str(e)))
            continue
        if not record.exists:
            failures.append(_failure(
                dep, "not-found",
                f"Package {dep.name!r} does not exist in the {registry.name} registry",
            ))
            continue
        age_days, message = _age(dep, adapter, record, threshold_days, exempt_young)
        if message is not None:
            failures.append(_failure(dep, "too-young", message))
            continue
        checked.append({
            "language": dep.language,
            "name": dep.name,
            "version": dep.version,
            "age_days": age_days,
            "source_file": dep.source_file,
            "line": dep.line,
        })
    return checked, failures


def _age(dep: Dependency, adapter: "Adapter", record: PackageRecord,
         threshold_days: int,
         exempt_young: set[tuple[str, str]]) -> tuple[int | None, str | None]:
    """(age_days, failure message). Unverifiable age fails closed."""
    if not adapter.age_supported:
        return None, None
    age_days = days_since(record.earliest_release_iso)
    if age_days is None:
        return None, (f"Package {dep.name!r}: registry returned no parseable release "
                      f"date — cannot verify age (fail-closed)")
    if threshold_days > 0 and age_days < threshold_days:
        if any(n == dep.name for n, _ in exempt_young):
            return None, None  # explicit exemption: known-good release
        return None, (f"Package {dep.name!r} is {age_days} days old — below "
                      f"{threshold_days}-day safety threshold")
    return age_days, None


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
