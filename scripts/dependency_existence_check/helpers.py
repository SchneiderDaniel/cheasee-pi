"""Small shared helpers (no framework imports)."""

from __future__ import annotations

import math
from datetime import datetime as _dt, timezone


def days_since(iso: str | None) -> int | None:
    """Whole days between now and iso (floor semantics, UTC).

    None for missing/unparseable input — fail-closed callers treat that as a
    violation. Mirrors daysSince() in package-safety.ts.
    """
    if not iso:
        return None
    try:
        dt = _dt.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return math.floor((_dt.now(timezone.utc) - dt).total_seconds() / 86400)


def _local(tag: str) -> str:
    """Strip an XML namespace prefix from a tag name."""
    return tag.rsplit("}", 1)[-1]
