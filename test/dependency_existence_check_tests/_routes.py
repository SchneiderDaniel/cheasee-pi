"""Fake registry response shapes for the offline safety-net suite.

Split out of `_common.py` (issue #2034 God Object refactor): the URL/body table
the offline fetchers answer with lives here, so the barrel and the transport
fake each stay under the raw-text function-count ceiling. Imports only
`OLD_ISO` back from the barrel, so the barrel can import this module.
"""

import json
import re
import urllib.parse
from datetime import datetime as _dt, timedelta, timezone

from ._common import OLD_ISO


def iso_days_ago(days):
    return (_dt.now(timezone.utc) - timedelta(days=days)).isoformat()


def pypi_body(iso=OLD_ISO):
    return json.dumps({"info": {"name": "x"},
                       "releases": {"0.1.0": [{"upload_time": iso}]}})


def url_for(registry, name):
    """Expected registry URL for a package name (mirrors the script's table)."""
    if registry == "pypi":
        return f"https://pypi.org/pypi/{name}/json"
    if registry == "npm":
        return f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@')}"
    if registry == "go":
        n = re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), name)
        return f"https://proxy.golang.org/{n}/@latest"
    if registry == "crates":
        return f"https://crates.io/api/v1/crates/{name}"
    if registry == "maven":
        g, a = name.split(":", 1)
        return f"https://repo1.maven.org/maven2/{g.replace('.', '/')}/{a}/maven-metadata.xml"
    if registry == "maven-version":
        g, a = name.split(":", 1)
        return (f"https://repo1.maven.org/maven2/{g.replace('.', '/')}/{a}/"
                f"1.0.0/maven-metadata.xml")
    if registry == "nuget":
        return f"https://api.nuget.org/v3/registration5-semver1/{name.lower()}/index.json"
    if registry == "vcpkg":
        return f"https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/{name}/vcpkg.json"
    if registry == "conan":
        return f"https://conan.io/center/recipes/{name}"
    if registry == "rubygems":
        return f"https://rubygems.org/api/v1/versions/{name}.json"
    if registry == "packagist":
        return f"https://repo.packagist.org/p2/{name}.json"
    if registry == "swift":
        return f"https://swiftpackageindex.com/{name}"
    if registry == "pub":
        return f"https://pub.dev/api/packages/{name}"
    raise AssertionError(f"unknown registry {registry}")


def _netloc(url):
    """Host of a registry URL: exact host match, not substring (CodeQL-clean)."""
    return urllib.parse.urlparse(url).netloc


def ok_route(registry, name, iso=OLD_ISO):
    url = url_for(registry, name)
    if registry == "pypi":
        return url, (200, pypi_body(iso), None)
    if registry == "npm":
        return url, (200, json.dumps({"time": {"created": iso}}), None)
    if registry == "go":
        return url, (200, json.dumps({"Version": "v1.0.0", "Time": iso}), None)
    if registry == "crates":
        return url, (200, json.dumps({"crate": {"created_at": iso}}), None)
    if registry == "maven":
        return url, (200, (
            "<metadata><groupId>g</groupId><artifactId>a</artifactId><versioning>"
            "<latest>1.0.0</latest><versions><version>1.0.0</version></versions>"
            "</versioning></metadata>"), None)
    if registry == "maven-version":
        return url, (200, (
            "<metadata><groupId>g</groupId><artifactId>a</artifactId><version>1.0.0</version>"
            "<versioning><lastUpdated>20200101000000</lastUpdated></versioning></metadata>"), None)
    if registry == "nuget":
        return url, (200, json.dumps(
            {"items": [{"catalogEntry": {"published": iso}}]}), None)
    if registry == "vcpkg":
        return url, (200, json.dumps({"name": name}), None)
    if registry == "conan":
        return url, (200, "<html>recipe</html>", None)
    if registry == "rubygems":
        return url, (200, json.dumps([{"number": "1.0.0", "built_at": iso}]), None)
    if registry == "packagist":
        return url, (200, json.dumps(
            {"packages": {name: [{"name": name, "time": iso}]}}), None)
    if registry == "swift":
        return url, (200, "<html>ok</html>", None)
    if registry == "pub":
        return url, (200, json.dumps({"versions": [{"published": iso}]}), None)
    raise AssertionError(f"unknown registry {registry}")


def not_found_route(registry, name):
    url = url_for(registry, name)
    return url, (404, "", None)


def make_response(url, etag=None):
    """Permissive default handler: any registry URL answers 200 with an old date."""
    if "pypi.org/pypi/" in url:
        return 200, pypi_body(), None
    if _netloc(url) == "registry.npmjs.org":
        return 200, json.dumps({"time": {"created": OLD_ISO}}), None
    if _netloc(url) == "proxy.golang.org":
        return 200, json.dumps({"Version": "v1.0.0", "Time": OLD_ISO}), None
    if "crates.io/api/v1/crates/" in url:
        return 200, json.dumps({"crate": {"created_at": OLD_ISO}}), None
    if "repo1.maven.org/maven2/" in url:
        if re.search(r"/[^/]+/maven-metadata\.xml$", url):
            return 200, ("<metadata><versioning><lastUpdated>20200101000000"
                         "</lastUpdated></versioning></metadata>"), None
        return 200, ("<metadata><versioning><versions><version>1.0.0</version>"
                     "</versions></versioning></metadata>"), None
    if "api.nuget.org/v3/registration5-semver1/" in url:
        return 200, json.dumps(
            {"items": [{"catalogEntry": {"published": OLD_ISO}}]}), None
    if "raw.githubusercontent.com/microsoft/vcpkg/" in url:
        return 200, json.dumps({"name": "x"}), None
    if "conan.io/center/recipes/" in url:
        return 200, "<html>recipe</html>", None
    if "rubygems.org/api/v1/versions/" in url:
        return 200, json.dumps([{"number": "1.0.0", "built_at": OLD_ISO}]), None
    if "repo.packagist.org/p2/" in url:
        return 200, json.dumps({"packages": {"x/y": [{"time": OLD_ISO}]}}), None
    if _netloc(url) == "swiftpackageindex.com":
        return 200, "<html>ok</html>", None
    if "pub.dev/api/packages/" in url:
        return 200, json.dumps({"versions": [{"published": OLD_ISO}]}), None
    raise AssertionError(f"unhandled registry URL in default handler: {url}")
