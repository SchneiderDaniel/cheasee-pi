"""One registry client per package registry, plus the REGISTRIES table."""

from __future__ import annotations

import json
import re
import urllib.parse

from .models import PackageRecord, RegistryError


from .registry_base import Registry


class PypiRegistry(Registry):
    name = "pypi"
    interval = 3.0

    def _url(self, name: str) -> str:
        # PyPI canonical normalization: lowercase, `-_.` runs -> `-`.
        n = re.sub(r"[-_.]+", "-", name).lower()
        return f"https://pypi.org/pypi/{n}/json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        times = []
        for files in (data.get("releases") or {}).values():
            for f in files or []:
                t = f.get("upload_time")
                if t:
                    times.append(t)
        if not times:
            # Missing dates are fail-closed by the core age guard (too-young),
            # not a transport failure.
            return PackageRecord(True, None)
        return PackageRecord(True, min(times))


class NpmRegistry(Registry):
    name = "npm"
    interval = 1.0

    def _url(self, name: str) -> str:
        n = urllib.parse.quote(name, safe="@")  # scoped names: @scope%2fname
        return f"https://registry.npmjs.org/{n}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        t = (data.get("time") or {}).get("created")
        if not t:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, t)


class GoRegistry(Registry):
    name = "go"
    interval = 2.0

    def _url(self, name: str) -> str:
        # Go module proxy encoding: uppercase -> `!` + lowercase.
        n = re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), name)
        return f"https://proxy.golang.org/{n}/@latest"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        t = data.get("Time")
        if not t:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, t)


class CargoRegistry(Registry):
    name = "crates"
    interval = 1.0

    def _url(self, name: str) -> str:
        return f"https://crates.io/api/v1/crates/{urllib.parse.quote(name, safe='')}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        t = (data.get("crate") or {}).get("created_at")
        if not t:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, t)
