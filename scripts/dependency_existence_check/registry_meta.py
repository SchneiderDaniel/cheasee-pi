"""One registry client per package registry, plus the REGISTRIES table."""

from __future__ import annotations

import datetime
import json
import xml.etree.ElementTree as ET
from datetime import timezone

from .helpers import _local
from .models import PackageRecord, RegistryError


from .registry_base import Registry


class MavenRegistry(Registry):
    name = "maven"
    interval = 3.0

    def check(self, name: str) -> PackageRecord:
        if ":" not in name:
            raise RegistryError(f"maven: dependency name {name!r} is not group:artifact")
        group, artifact = name.split(":", 1)
        base = f"https://repo1.maven.org/maven2/{group.replace('.', '/')}/{artifact}"
        status, body, _ = self._request(base + "/maven-metadata.xml")
        if status == 404:
            return PackageRecord(False)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as e:
            raise RegistryError(f"maven: unparseable metadata for {name}: {e}") from None
        versions = []
        for el in root.iter():
            if _local(el.tag) == "versions":
                versions = [v.text for v in el if v.text]
                break
        if not versions:
            return PackageRecord(False)
        earliest = min(versions)
        status2, body2, _ = self._request(f"{base}/{earliest}/maven-metadata.xml")
        if status2 == 404:
            return PackageRecord(True, None)  # no date -> core fails closed
        try:
            root2 = ET.fromstring(body2)
        except ET.ParseError as e:
            raise RegistryError(f"maven: unparseable version metadata for {name}: {e}") from None
        ts = None
        for el in root2.iter():
            if _local(el.tag) == "lastUpdated":
                ts = (el.text or "").strip()
                break
        if not ts:
            return PackageRecord(True, None)  # no date -> core fails closed
        try:
            dt = datetime.datetime.strptime(ts, "%Y%m%d%H%M%S")
        except ValueError:
            return PackageRecord(True, None)  # unparseable date -> fails closed
        return PackageRecord(True, dt.replace(tzinfo=timezone.utc).isoformat())


class NugetRegistry(Registry):
    name = "nuget"
    interval = 2.0

    def _url(self, name: str) -> str:
        # Registration ids are case-insensitive; lowercase is canonical.
        return f"https://api.nuget.org/v3/registration5-semver1/{name.lower()}/index.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        published = []
        for item in data.get("items") or []:
            inner = item.get("items")
            if isinstance(inner, list):  # paged leaf
                for sub in inner:
                    t = (sub.get("catalogEntry") or {}).get("published")
                    if t:
                        published.append(t)
            else:
                t = (item.get("catalogEntry") or {}).get("published")
                if t:
                    published.append(t)
        if not published:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(published))
