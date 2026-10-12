"""One registry client per package registry, plus the REGISTRIES table."""

from __future__ import annotations

import json

from .models import PackageRecord, RegistryError
from .transport import RateLimiter


class Registry:
    """One per registry. `check(name)` -> PackageRecord; raises RegistryError."""

    name = "base"
    interval = 3.0
    age_supported = True

    def __init__(self, fetcher) -> None:
        self.fetcher = fetcher
        self.limiter = RateLimiter(self.interval)

    def _url(self, name: str) -> str:
        raise NotImplementedError

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        raise NotImplementedError

    def _request(self, url: str, etag: str | None = None):
        """Rate-limited fetch with two retries; fail-closed on repeated 5xx/errors."""
        last: Exception | str = "unknown error"
        for attempt in range(3):
            self.limiter.wait()
            try:
                status, body, new_etag = self.fetcher.get(url, etag)
                self.limiter.mark()
            except Exception as e:  # network error
                self.limiter.mark()
                last = e
                continue
            if status < 500:
                return status, body, new_etag
            last = f"HTTP {status}"
        raise RegistryError(
            f"registry {self.name} unreachable for {url} after 3 attempts ({last})"
        )

    def check(self, name: str) -> PackageRecord:
        url = self._url(name)
        cached = self.fetcher.cache_entry(url)
        etag = cached[2] if cached else None
        status, body, _ = self._request(url, etag)
        return self._parse(name, status, body)

    @staticmethod
    def _json(body: str, what: str) -> dict:
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            raise RegistryError(f"malformed JSON response for {what}: {e}") from None
        if not isinstance(data, dict):
            raise RegistryError(f"unexpected response shape for {what}")
        return data
