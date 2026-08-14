"""HTTP transport: ETag/disk cache, rate limiting, and the urllib-backed fetcher."""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = "cheasee-pi-dependency-existence-check/1.0 (+https://github.com/SchneiderDaniel/cheasee-pi)"


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


class RateLimiter:
    """Token-bucket-ish spacing: at most one request per `interval` seconds."""

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self._next = 0.0

    def wait(self) -> None:
        delay = self._next - time.monotonic()
        if delay > 0:
            time.sleep(delay)

    def mark(self) -> None:
        self._next = time.monotonic() + self.interval


class RealFetcher:
    """urllib-backed fetcher with ETag + disk caching.

    Fetcher contract (also implemented by the offline fake in the test suite):
        cache_entry(url) -> (status, body, etag) | None
        get(url, etag=None) -> (status, body, new_etag)
            - a cache entry with no etag argument is served without network
            - a conditional request answered 304 reuses the cached body
        stats -> object with hits/misses/requests counters
    """

    def __init__(self, cache_dir: str, opener=None) -> None:
        self.cache: DiskCache | NoCache = (
            DiskCache(Path(cache_dir)) if cache_dir else NoCache()
        )
        self.stats = CacheStats()
        self.opener = opener or self._urllib_open

    def cache_entry(self, url: str):
        return self.cache.get(url)

    def get(self, url: str, etag: str | None = None):
        entry = self.cache.get(url)
        if entry is not None and etag is None:
            self.stats.hits += 1
            return entry
        status, headers, body = self.opener(url, {"User-Agent": USER_AGENT}, etag)
        if status == 304 and entry is not None:
            self.stats.hits += 1
            return entry
        self.stats.misses += 1
        self.stats.requests += 1
        entry = (status, body, headers.get("ETag"))
        if status < 500:
            # never cache transient 5xx errors: retries must re-hit the network
            self.cache.store(url, entry)
        return entry

    def _urllib_open(self, url: str, headers: dict, etag: str | None):
        req = urllib.request.Request(url, headers=headers)
        if etag:
            req.add_header("If-None-Match", etag)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read().decode("utf-8", "replace")
