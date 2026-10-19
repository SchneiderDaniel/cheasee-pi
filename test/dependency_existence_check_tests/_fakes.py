"""Transport fake + temp-repo harness for the offline safety-net suite.

Split out of `_common.py` (issue #2034 God Object refactor): the offline
fetcher and the temp-repo builder live here, so the barrel keeps only the
`importlib` shim and its re-exports. Imported by the barrel *after* `dec` is
bound, which is why `from ._common import dec` resolves.
"""

import contextlib
import io
import tempfile
from pathlib import Path
from typing import cast

from ._common import dec


def run_main(args, fetcher):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = dec.main(args, fetcher=fetcher)
    return code, buf.getvalue()


class FakeFetcher:
    """Fetcher contract stand-in: route table, request log, etag/304, errors."""

    class _Stats:
        def __init__(self):
            self.hits = 0
            self.misses = 0
            self.requests = 0

    def __init__(self, routes=None, default=None, cache=None):
        self.routes = dict(routes or {})
        self.default = default
        self.cache = dict(cache or {})
        self.log = []  # (url, etag) per network request
        self.stats = FakeFetcher._Stats()

    def cache_entry(self, url):
        return self.cache.get(url)

    def get(self, url, etag=None):
        entry = self.cache.get(url)
        if entry is not None and etag is None:
            self.stats.hits += 1
            return entry
        if url in self.routes:
            status, body, new_etag = self.routes[url]
            if callable(status):
                status, body, new_etag = cast(tuple, status())
            self.log.append((url, etag))
            if status == 304 and entry is not None:
                self.stats.hits += 1
                return entry
            self.stats.misses += 1
            self.stats.requests += 1
            result = (status, body, new_etag)
            if status < 500:  # never cache transient 5xx: retries must re-hit
                self.cache[url] = result
            return result
        if self.default is not None:
            result = self.default(url, etag)
            if result is not None:
                self.log.append((url, etag))
                self.stats.misses += 1
                self.stats.requests += 1
                if result[0] < 500:
                    self.cache[url] = result
                return result
        raise AssertionError(f"unregistered URL: {url}")

    def requested_urls(self):
        return [u for u, _ in self.log]


def write_repo(files):
    """Create a temp repo dir from {relpath: content}; returns (TemporaryDirectory, Path)."""
    td = tempfile.TemporaryDirectory()
    repo = Path(td.name) / "repo"
    repo.mkdir()
    for rel, content in files.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return td, repo
