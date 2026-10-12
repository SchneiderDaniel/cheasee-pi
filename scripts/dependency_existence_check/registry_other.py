"""One registry client per package registry, plus the REGISTRIES table."""

from __future__ import annotations

import json
import urllib.parse

from .models import PackageRecord, RegistryError


from .registry_base import Registry


class RubygemsRegistry(Registry):
    name = "rubygems"
    interval = 2.0

    def _url(self, name: str) -> str:
        # /api/v1/gems/{name}.json no longer exposes a release date; the
        # versions endpoint carries per-version built_at timestamps.
        return f"https://rubygems.org/api/v1/versions/{urllib.parse.quote(name, safe='')}.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            raise RegistryError(f"malformed JSON response for {name}: {e}") from None
        if not isinstance(data, list):
            raise RegistryError(f"unexpected response shape for {name}")
        times = [v.get("built_at") for v in data
                 if isinstance(v, dict) and v.get("built_at")]
        if not times:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(t for t in times if t is not None))


class PackagistRegistry(Registry):
    name = "packagist"
    interval = 2.0

    def _url(self, name: str) -> str:
        if "/" not in name:
            raise RegistryError(f"packagist: dependency name {name!r} has no vendor/name form")
        vendor, package = name.split("/", 1)
        return f"https://repo.packagist.org/p2/{vendor}/{package}.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        times = []
        for versions in (data.get("packages") or {}).values():
            for ver in versions or []:
                t = ver.get("time")
                if t:
                    times.append(t)
        if not times:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(times))


class PubRegistry(Registry):
    name = "pub"
    interval = 2.0

    def _url(self, name: str) -> str:
        return f"https://pub.dev/api/packages/{urllib.parse.quote(name, safe='')}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        times = [
            v["published"]
            for v in (data.get("versions") or [])
            if isinstance(v, dict) and isinstance(v.get("published"), str)
        ]
        if not times:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(times))
