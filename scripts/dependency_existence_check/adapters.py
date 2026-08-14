"""One Adapter per language/registry pair: manifest grammars + registry binding.

Registered in the ADAPTERS table; the core pipeline never imports manifest
detail directly.
"""

from __future__ import annotations

import ast
import fnmatch
import json
import re
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path

from dependency_existence_check.helpers import _local
from dependency_existence_check.models import Dependency

# ─── language adapters ──────────────────────────────────────────────


def _pep508_name(spec: str) -> str | None:
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", spec.strip())
    return m.group(1) if m else None


class Adapter:
    """Manifest grammar + registry binding. One class per language."""

    language = "base"
    patterns: tuple[str, ...] = ()
    priority = 10  # lockfiles / central manifests rank higher
    age_supported = True
    registry_name = "pypi"
    inline_marker: str | None = None  # trailing comment that ignores a dep line

    def detect(self, rel: Path, text: str) -> bool:
        return any(fnmatch.fnmatchcase(rel.name, p) for p in self.patterns)

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        return []

    def _dep(self, name: str, version: str | None, line: int = 0,
             transitive: bool = False, path: Path | None = None,
             priority: int | None = None, registry_name: str | None = None) -> Dependency:
        return Dependency(
            self.language, name, version, str(path) if path else "", line,
            transitive,
            self.priority if priority is None else priority,
            registry_name,
        )


class PythonAdapter(Adapter):
    language = "python"
    patterns = ("requirements*.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg")
    priority = 10
    registry_name = "pypi"
    inline_marker = "# slopsquat-ignore"

    def detect(self, rel: Path, text: str) -> bool:
        name = rel.name
        if fnmatch.fnmatchcase(name, "requirements*.txt") or name in ("pyproject.toml", "setup.cfg"):
            return True
        if name == "Pipfile":
            try:
                tomllib.loads(text)
                return True
            except tomllib.TOMLDecodeError:
                return False
        if name == "setup.py":
            return "install_requires" in text or "setup(" in text or "setuptools" in text
        return False

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if fnmatch.fnmatchcase(name, "requirements*.txt"):
            return self._requirements(text, path)
        if name in ("pyproject.toml", "Pipfile"):
            try:
                data = tomllib.loads(text)
            except tomllib.TOMLDecodeError:
                return []
            if name == "Pipfile":
                return self._pipfile(data, path)
            return self._toml(data, path)
        if name == "setup.cfg":
            return self._setup_cfg(text, path)
        if name == "setup.py":
            return self._setup_py(text, path)
        return []

    def _requirements(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        base = (path.parent if path else Path("."))
        seen: set[Path] = set()

        def parse(content: str, bdir: Path, src: str) -> None:
            for i, raw in enumerate(content.splitlines(), 1):
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"-(?:r|requirement)\s+(\S+)", line)
                if m:
                    inc = (bdir / m.group(1)).resolve()
                    if inc in seen:
                        continue
                    seen.add(inc)
                    try:
                        parse(inc.read_text(encoding="utf-8", errors="replace"),
                              inc.parent, str(inc))
                    except OSError:
                        continue
                    continue
                if line.startswith("-"):
                    continue  # other options (-e, -c, -i, ...)
                spec = re.match(
                    r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~;].*)?$", line
                )
                if not spec:
                    continue
                dep_name = spec.group(1)
                if "/" in dep_name or "\\" in dep_name or dep_name.startswith("."):
                    continue  # local paths / VCS, not registry packages
                deps.append(self._dep(dep_name, None, i, False, Path(src)))

        parse(text, base, str(path) if path else "requirements.txt")
        return deps

    def _pipfile(self, data: dict, path: Path | None) -> list[Dependency]:
        deps = []
        for table in ("packages", "dev-packages"):
            for n, spec in (data.get(table) or {}).items():
                if isinstance(spec, dict):
                    if any(k in spec for k in ("git", "path", "file", "editable")):
                        continue  # VCS/local entries are not registry packages
                    version = spec.get("version")
                elif isinstance(spec, str):
                    version = spec
                else:
                    version = None
                deps.append(self._dep(n, version, 0, False, path))
        return deps

    def _toml(self, data: dict, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        project = data.get("project") or {}
        for spec in project.get("dependencies") or []:
            if isinstance(spec, str):
                n = _pep508_name(spec)
                if n:
                    deps.append(self._dep(n, None, 0, False, path))
        for group in (project.get("optional-dependencies") or {}).values():
            for spec in group or []:
                if isinstance(spec, str):
                    n = _pep508_name(spec)
                    if n:
                        deps.append(self._dep(n, None, 0, False, path))
        poetry = (data.get("tool") or {}).get("poetry") or {}
        for table in (poetry.get("dependencies") or {}, poetry.get("dev-dependencies") or {}):
            for n, spec in (table or {}).items():
                if n == "python":
                    continue
                if isinstance(spec, dict) and any(k in spec for k in ("git", "path", "url")):
                    continue
                deps.append(self._dep(n, None, 0, False, path))
        return deps

    def _setup_cfg(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        section = ""
        in_ir = False
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith("[") and s.endswith("]"):
                section = s[1:-1].strip()
                in_ir = False
                continue
            if section != "options":
                continue
            if s.startswith("install_requires"):
                in_ir = True
                rest = s.split("=", 1)[1].strip() if "=" in s else ""
                candidates = [rest] if rest else []
            elif in_ir:
                if not s or s.startswith(("#", ";")):
                    continue
                if not line.startswith((" ", "\t")):
                    in_ir = False
                    continue
                candidates = [s]
            else:
                continue
            for spec in candidates:
                n = _pep508_name(spec)
                if n:
                    deps.append(self._dep(n, None, i, False, path))
        return deps

    def _setup_py(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "setup":
                for kw in node.keywords:
                    if kw.arg == "install_requires" and isinstance(kw.value, (ast.List, ast.Tuple)):
                        for elt in kw.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                n = _pep508_name(elt.value)
                                if n:
                                    deps.append(self._dep(n, None, 0, False, path))
            elif isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "install_requires":
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                n = _pep508_name(elt.value)
                                if n:
                                    deps.append(self._dep(n, None, 0, False, path))
        return deps


class JavaScriptAdapter(Adapter):
    language = "javascript"
    patterns = ("package.json", "package-lock.json")
    priority = 10
    registry_name = "npm"
    inline_marker = None  # JSON carries no comments; rely on .slopsquat-ignore

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        if name == "package-lock.json" and isinstance(data.get("packages"), dict):
            return self._lock_v2(data, path)
        if name == "package-lock.json":
            return self._lock_v1(data, path)
        deps = []
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            for n, v in (data.get(section) or {}).items():
                if isinstance(v, str) and v.startswith(
                    ("file:", "link:", "workspace:", "git+", "http://", "https://")
                ):
                    continue  # local/workspace/VCS/URL specs are not registry packages
                deps.append(self._dep(n, v if isinstance(v, str) else None, 0, False, path))
        return deps

    def _lock_v2(self, data: dict, path: Path | None) -> list[Dependency]:
        packages = data.get("packages") or {}
        root = packages.get("") or {}
        direct = set()
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            direct.update((root.get(section) or {}).keys())
        deps = []
        for pkg_path, entry in packages.items():
            if not pkg_path or not pkg_path.startswith("node_modules/"):
                continue
            if isinstance(entry, dict) and entry.get("link"):
                continue  # workspace link, not a registry package
            dep_name = pkg_path.split("node_modules/")[-1]
            top_level = pkg_path.count("node_modules/") == 1
            version = (entry or {}).get("version") if isinstance(entry, dict) else None
            deps.append(self._dep(dep_name, version, 0,
                                  (not top_level) or dep_name not in direct, path, 20))
        return deps

    def _lock_v1(self, data: dict, path: Path | None) -> list[Dependency]:
        deps = []

        def walk(entry: dict, transitive: bool) -> None:
            for n, spec in (entry.get("dependencies") or {}).items():
                version = (spec or {}).get("version") if isinstance(spec, dict) else None
                deps.append(self._dep(n, version, 0, transitive, path, 20))
                if isinstance(spec, dict):
                    walk(spec, True)

        walk(data, False)
        return deps


class GoAdapter(Adapter):
    language = "go"
    patterns = ("go.mod",)
    priority = 10
    registry_name = "go"
    inline_marker = "// slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        deps = []
        in_block = False
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith(("module ", "replace ", "exclude ")):
                continue
            if s.startswith("require"):
                rest = s[len("require"):].strip()
                if rest.startswith("("):
                    in_block = True
                    continue
                parts = rest.split()
                if len(parts) >= 2 and "// indirect" not in s:
                    deps.append(self._dep(parts[0], parts[1], i, False, path))
                continue
            if in_block:
                if s == ")":
                    in_block = False
                    continue
                if not s or s.startswith("//"):
                    continue
                parts = s.split()
                if len(parts) >= 2 and "// indirect" not in s:
                    deps.append(self._dep(parts[0], parts[1], i, False, path))
        return deps


class RustAdapter(Adapter):
    language = "rust"
    patterns = ("Cargo.toml", "Cargo.lock")
    priority = 10
    registry_name = "crates"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "Cargo.lock":
            return self._lock(text, path)
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError:
            return []
        deps = []
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            for n, spec in (data.get(section) or {}).items():
                if isinstance(spec, dict):
                    if spec.get("git") or spec.get("path"):
                        continue
                    version = spec.get("version")
                elif isinstance(spec, str):
                    version = spec
                else:
                    version = None
                deps.append(self._dep(n, version, 0, False, path))
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        blocks = re.split(r"^\[\[package\]\]\s*$", text, flags=re.M)
        packages: list[tuple[str, str | None]] = []
        referenced: set[str] = set()
        for block in blocks[1:]:
            nm = re.search(r'^name = "([^"]+)"', block, flags=re.M)
            vm = re.search(r'^version = "([^"]+)"', block, flags=re.M)
            if not nm:
                continue
            packages.append((nm.group(1), vm.group(1) if vm else None))
            head, sep, tail = block.partition("dependencies = [")
            if sep:
                refs = re.findall(r'"([^"]+)"', tail.split("]", 1)[0])
                for r in refs:
                    referenced.add(r.split()[0])
        deps = []
        for n, v in packages:
            deps.append(self._dep(n, v, 0, n in referenced, path, 20))
        return deps


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


class DotnetAdapter(Adapter):
    language = "dotnet"
    patterns = ("*.csproj", "*.fsproj", "*.vbproj", "packages.config", "Directory.Packages.props")
    priority = 10
    registry_name = "nuget"
    inline_marker = "<!-- slopsquat-ignore -->"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "packages.config":
            return self._packages_config(text, path)
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        central = name == "Directory.Packages.props"
        for el in root.iter():
            tag = _local(el.tag)
            if central and tag == "PackageVersion":
                include = el.get("Include") or el.get("Update")
                if include:
                    deps.append(self._dep(include, el.get("Version"), 0, False, path, 15))
            elif not central and tag == "PackageReference":
                include = el.get("Include")
                if include:
                    deps.append(self._dep(include, el.get("Version"), 0, False, path))
        return deps

    def _packages_config(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        for el in root.iter():
            if _local(el.tag) == "package":
                pid = el.get("id")
                if pid:
                    deps.append(self._dep(pid, el.get("version"), 0, False, path))
        return deps


class CppAdapter(Adapter):
    language = "cpp"
    patterns = ("vcpkg.json", "conanfile.txt", "conanfile.py", "conan.lock")
    priority = 10
    registry_name = "vcpkg"  # existence via vcpkg or ConanCenter
    age_supported = False  # neither vcpkg nor ConanCenter stores release dates
    inline_marker = "# slopsquat-ignore"

    def detect(self, rel: Path, text: str) -> bool:
        name = rel.name
        if name in ("vcpkg.json", "conanfile.txt", "conan.lock"):
            return True
        if name == "conanfile.py":
            return "conan" in text or "requires" in text
        return False

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "vcpkg.json":
            return self._vcpkg(text, path)
        if name == "conanfile.txt":
            return self._conan_txt(text, path)
        if name == "conanfile.py":
            return self._conan_py(text, path)
        if name == "conan.lock":
            return self._conan_lock(text, path)
        return []

    def _vcpkg(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        deps = []
        for section in ("dependencies", "host-dependencies"):
            for entry in data.get(section) or []:
                if isinstance(entry, str):
                    deps.append(self._dep(entry, None, 0, False, path, registry_name="vcpkg"))
                elif isinstance(entry, dict) and entry.get("name"):
                    deps.append(self._dep(entry["name"], entry.get("version"), 0, False, path,
                                          registry_name="vcpkg"))
        return deps

    def _conan_txt(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        section = None
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith("["):
                section = s.strip("[]")
                continue
            if section == "requires" and s and not s.startswith("#"):
                deps.append(self._dep(s.split("/")[0].strip(), None, i, False, path,
                                      registry_name="conan"))
        return deps

    def _conan_py(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for m in re.finditer(r"requires\s*=\s*(?:\(|\[)?([^)\]#]*)(?:\)|\])?", text):
            for tok in re.findall(r"['\"]([^'\"]+)['\"]", m.group(1)):
                name = tok.split("/")[0].strip()
                if name:
                    deps.append(self._dep(name, None, 0, False, path, registry_name="conan"))
        return deps

    def _conan_lock(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        deps: list[Dependency] = []

        def walk(obj) -> None:
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if k in ("requires", "build_requires") and isinstance(v, list):
                        for item in v:
                            ref = item.get("ref") if isinstance(item, dict) else item
                            if isinstance(ref, str) and "/" in ref:
                                deps.append(self._dep(ref.split("/")[0], None, 0, False, path,
                                                      registry_name="conan"))
                    else:
                        walk(v)
            elif isinstance(obj, list):
                for v in obj:
                    walk(v)

        walk(data)
        return deps


class RubyAdapter(Adapter):
    language = "ruby"
    patterns = ("Gemfile", "Gemfile.lock", "*.gemspec")
    priority = 10
    registry_name = "rubygems"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "Gemfile.lock":
            return self._lock(text, path)
        if name == "Gemfile":
            return self._gemfile(text, path)
        return self._gemspec(text, path)

    def _gemfile(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for i, line in enumerate(text.splitlines(), 1):
            m = re.match(r"^gem\s+(['\"])([^'\"]+)\1(.*)$", line.strip())
            if not m:
                continue
            if re.search(r"(^|,)\s*(git|path|github)\s*:", m.group(3)):
                continue  # git/path gems are not registry-checked
            deps.append(self._dep(m.group(2), None, i, False, path))
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        lines = text.splitlines()
        # DEPENDENCIES section (bottom of file) names the direct gems; pre-scan it.
        direct: set[str] = set()
        in_deps = False
        for line in lines:
            if not line.strip():
                continue
            if not line[0].isspace():
                in_deps = line.rstrip(":").strip() == "DEPENDENCIES"
                continue
            if in_deps:
                m = re.match(r"^\s{2}(\S+)", line)
                if m:
                    direct.add(m.group(1))
        deps = []
        section = ""
        in_specs = False
        for i, line in enumerate(lines, 1):
            if not line.strip():
                continue
            if not line[0].isspace():
                section = line.rstrip(":").strip()
                in_specs = False
                continue
            if section != "GEM":
                continue  # GIT/PATH gems are not registry-checked
            if line.strip() == "specs:":
                in_specs = True
                continue
            if in_specs:
                m = re.match(r"^ {4}(\S+) \(([^)]+)\)", line)
                if m:
                    deps.append(self._dep(m.group(1), m.group(2), i,
                                          m.group(1) not in direct, path, 20))
        return deps

    def _gemspec(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for m in re.finditer(
            r"add_(?:runtime_|development_)?dependency\s*\(?\s*['\"]([^'\"]+)['\"]", text
        ):
            deps.append(self._dep(m.group(1), None, 0, False, path))
        return deps


class PhpAdapter(Adapter):
    language = "php"
    patterns = ("composer.json", "composer.lock")
    priority = 10
    registry_name = "packagist"
    inline_marker = None  # JSON carries no comments

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        name = path.name if path else ""
        if name == "composer.lock":
            deps = []
            for section in ("packages", "packages-dev"):
                for pkg in data.get(section) or []:
                    if isinstance(pkg, dict) and pkg.get("name"):
                        deps.append(self._dep(pkg["name"], pkg.get("version"), 0, False, path, 20))
            return deps
        deps = []
        for section in ("require", "require-dev"):
            for n, v in (data.get(section) or {}).items():
                if n == "php" or n.startswith("ext-") or n.startswith("lib-"):
                    continue  # virtual packages, no Packagist lookup
                deps.append(self._dep(n, v if isinstance(v, str) else None, 0, False, path))
        return deps


class SwiftAdapter(Adapter):
    language = "swift"
    patterns = ("Package.swift",)
    priority = 10
    registry_name = "swift"
    age_supported = False  # no central registry with dates; existence via SPI
    inline_marker = "// slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        deps = []
        for m in re.finditer(r'\.package\s*\(\s*url\s*:\s*"([^"]+)"', text):
            url = m.group(1).rstrip("/")
            if url.endswith(".git"):
                url = url[:-4]
            gm = re.search(r"github\.com/([^/]+)/([^/]+)", url)
            if gm:
                deps.append(self._dep(f"{gm.group(1)}/{gm.group(2)}", None, 0, False, path))
            # non-github URLs: best effort, no SPI lookup possible
        return deps


class DartAdapter(Adapter):
    language = "dart"
    patterns = ("pubspec.yaml", "pubspec.lock")
    priority = 10
    registry_name = "pub"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "pubspec.lock":
            return self._lock(text, path)
        return self._yaml(text, path)

    def _yaml(self, text: str, path: Path | None) -> list[Dependency]:
        """Minimal indentation-aware parser for dependencies/dev_dependencies."""
        deps = []
        section = None
        cur: list | None = None
        lines = text.splitlines()

        def flush() -> None:
            nonlocal cur
            if cur and not cur[2]:
                deps.append(self._dep(cur[0], None, cur[1], False, path))
            cur = None

        for i, line in enumerate(lines, 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            s = line.strip()
            if indent == 0:
                flush()
                key = s.split(":", 1)[0].strip()
                section = key if key in ("dependencies", "dev_dependencies") else None
                continue
            if section is None:
                continue
            if indent == 2:
                flush()
                m = re.match(r"^([A-Za-z0-9_\-\.]+)\s*:\s*(.*)$", s)
                if not m:
                    continue
                value = m.group(2).strip()
                if value and not value.startswith("#"):
                    deps.append(self._dep(m.group(1), value, i, False, path))
                else:
                    cur = [m.group(1), i, False]
            elif indent >= 4 and cur is not None:
                key = s.split(":", 1)[0].strip()
                if key in ("git", "path", "sdk"):
                    cur[2] = True
        flush()
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        in_packages = False
        cur: list | None = None

        def flush() -> None:
            nonlocal cur
            if cur:
                dep_type = cur[2]
                direct = dep_type is None or dep_type.startswith("direct")
                deps.append(self._dep(cur[0], cur[3], cur[1], not direct, path, 20))
            cur = None

        for i, line in enumerate(text.splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            s = line.strip()
            if indent == 0:
                flush()
                in_packages = s.split(":", 1)[0].strip() == "packages"
                continue
            if not in_packages:
                continue
            if indent == 2:
                flush()
                m = re.match(r"^([A-Za-z0-9_\-\.]+)\s*:", s)
                if m:
                    cur = [m.group(1), i, None, None]
            elif indent == 4 and cur is not None:
                k, _, v = s.partition(":")
                k = k.strip()
                v = v.strip().strip('"')
                if k == "dependency":
                    cur[2] = v
                elif k == "version":
                    cur[3] = v
        flush()
        return deps


ADAPTERS: list[Adapter] = [
    PythonAdapter(),
    JavaScriptAdapter(),
    GoAdapter(),
    RustAdapter(),
    JavaAdapter(),
    DotnetAdapter(),
    CppAdapter(),
    RubyAdapter(),
    PhpAdapter(),
    SwiftAdapter(),
    DartAdapter(),
]


