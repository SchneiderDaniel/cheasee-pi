"""One registry client per package registry, plus the REGISTRIES table."""

from __future__ import annotations

import json
import urllib.parse

from .models import PackageRecord, RegistryError


from .registry_base import Registry


class VcpkgRegistry(Registry):
    name = "vcpkg"
    interval = 2.0
    age_supported = False

    def _url(self, name: str) -> str:
        return f"https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/{urllib.parse.quote(name, safe='')}/vcpkg.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 200:
            return PackageRecord(True)
        if status == 404:
            return PackageRecord(False)
        raise RegistryError(f"vcpkg: unexpected status {status} for {name}")


class ConanRegistry(Registry):
    name = "conan"
    interval = 2.0
    age_supported = False

    def _url(self, name: str) -> str:
        return f"https://conan.io/center/recipes/{urllib.parse.quote(name, safe='')}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 200:
            return PackageRecord(True)
        if status == 404:
            return PackageRecord(False)
        raise RegistryError(f"conan: unexpected status {status} for {name}")


class SwiftRegistry(Registry):
    name = "swift"
    interval = 2.0
    age_supported = False

    def _url(self, name: str) -> str:
        return f"https://swiftpackageindex.com/{name}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 200:
            return PackageRecord(True)
        if status == 404:
            return PackageRecord(False)
        raise RegistryError(f"swift: unexpected status {status} for {name}")
