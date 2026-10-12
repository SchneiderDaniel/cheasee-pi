"""HTTP transport: ETag/disk cache, rate limiting, and the urllib-backed fetcher."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


class CacheStats:
    def __init__(self) -> None:
        self.hits = 0
        self.misses = 0
        self.requests = 0


class DiskCache:
    """Per-URL (status, body, etag) entries persisted under a cache dir."""

    def __init__(self, cache_dir: Path) -> None:
        self.dir = cache_dir
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, url: str) -> Path:
        h = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
        return self.dir / f"{h}.json"

    def get(self, url: str) -> tuple[int, str, str | None] | None:
        try:
            data = json.loads(self._path(url).read_text(encoding="utf-8"))
            return int(data["status"]), str(data["body"]), data["etag"]
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            return None

    def store(self, url: str, entry: tuple[int, str, str | None]) -> None:
        try:
            status, body, etag = entry
            self._path(url).write_text(
                json.dumps({"status": status, "body": body, "etag": etag}),
                encoding="utf-8",
            )
        except OSError:
            pass  # cache is best-effort; never fail the check for it


class NoCache:
    def get(self, url: str):
        return None

    def store(self, url: str, entry) -> None:
        pass
