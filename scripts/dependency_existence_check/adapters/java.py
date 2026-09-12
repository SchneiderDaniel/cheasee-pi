"""Java ecosystem adapter: pom.xml + Gradle build files."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path

from ..helpers import _local
from ..models import Dependency
from .base import Adapter


class JavaAdapter(Adapter):
    language = "java"
    patterns = ("pom.xml", "build.gradle", "build.gradle.kts")
    priority = 10
    registry_name = "maven"
    inline_marker = "<!-- slopsquat-ignore -->"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "pom.xml":
            return self._pom(text, path)
        return self._gradle(text, path)

    def _pom(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        for dep in root.iter():
            if _local(dep.tag) != "dependency":
                continue
            group = artifact = version = None
            for child in dep:
                t = _local(child.tag)
                if t == "groupId":
                    group = (child.text or "").strip() or None
                elif t == "artifactId":
                    artifact = (child.text or "").strip() or None
                elif t == "version":
                    version = (child.text or "").strip() or None
            if group and artifact:
                deps.append(self._dep(f"{group}:{artifact}", version, 0, False, path))
        return deps

    def _gradle(self, text: str, path: Path | None) -> list[Dependency]:
        configs = (
            "implementation", "api", "compileOnly", "runtimeOnly",
            "testImplementation", "annotationProcessor", "compile",
        )
        deps = []
        lines = text.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            m = re.match(r"^(?:" + "|".join(configs) + r")\s*(\()(.*)$", line)
            if m:
                buf = m.group(2)
                depth = 1
                while depth > 0 and i < len(lines) - 1:
                    i += 1
                    depth += lines[i].count("(") - lines[i].count(")")
                    buf += " " + lines[i].strip()
                arg = buf.rstrip(")").strip()
            else:
                m = re.match(r"^(?:" + "|".join(configs) + r")\s+(.+)$", line)
                arg = m.group(1).strip() if m else None
            if arg:
                parsed = self._gradle_arg(arg)
                if parsed:
                    deps.append(self._dep(*parsed, i + 1, False, path))
            i += 1
        return deps

    @staticmethod
    def _gradle_arg(arg: str):
        q = re.match(r"^(['\"])([^'\"]+)\1$", arg.strip())
        if q:
            parts = q.group(2).split(":")
            if len(parts) >= 2:
                return f"{parts[0]}:{parts[1]}", parts[2] if len(parts) > 2 else None
            return None
        gm = re.search(r"group\s*:\s*['\"]([^'\"]+)['\"]", arg)
        nm = re.search(r"name\s*:\s*['\"]([^'\"]+)['\"]", arg)
        vm = re.search(r"version\s*:\s*['\"]([^'\"]+)['\"]", arg)
        if gm and nm:
            return f"{gm.group(1)}:{nm.group(1)}", vm.group(1) if vm else None
        return None