"""Command-line entry point and reporting. Only module where argparse appears."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .core import run_check
from .transport import RealFetcher

# Mirrors .pi/extensions/supervisor/checks/package-safety.ts SAFETY_THRESHOLD_DAYS.
SAFETY_THRESHOLD_DAYS = 14

def main(argv: list[str] | None = None, fetcher=None) -> int:
    parser = argparse.ArgumentParser(
        prog="dependency-existence-check",
        description="Check that declared dependencies exist in their registries "
                    "and are older than the safety threshold.",
    )
    parser.add_argument("--root", default=".", help="repository root (default: .)")
    parser.add_argument("--json", action="store_true", help="emit JSON report")
    parser.add_argument("--cache-dir", default=None,
                        help="directory for ETag/response cache (default: ~/.cache/slopsquat)")
    parser.add_argument("--threshold-days", type=int, default=SAFETY_THRESHOLD_DAYS,
                        help="minimum package age in days (0 disables the age guard)")
    parser.add_argument("--exempt-young", action="append", default=[], metavar="NAME@VERSION",
                        help="allow a specific package version below the age threshold "
                             "(repeatable; e.g. a just-released security patch)")
    parser.add_argument("--check-transitive", action="store_true",
                        help="also check transitive dependencies from lockfiles")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)  # unknown flags -> exit 2

    root = Path(args.root)
    if not root.is_dir():
        print(f"error: --root {args.root!r} is not a readable directory", file=sys.stderr)
        return 2
    if args.threshold_days < 0:
        print("error: --threshold-days must be >= 0", file=sys.stderr)
        return 2

    if fetcher is None:
        cache_dir = args.cache_dir or os.path.join(
            os.path.expanduser("~"), ".cache", "slopsquat")
        fetcher = RealFetcher(cache_dir)

    exempt_young = set()
    for spec in args.exempt_young:
        if "@" not in spec:
            print(f"error: --exempt-young expects NAME@VERSION, got {spec!r}", file=sys.stderr)
            return 2
        name, _, version = spec.partition("@")
        if not name or not version:
            print(f"error: --exempt-young expects NAME@VERSION, got {spec!r}", file=sys.stderr)
            return 2
        exempt_young.add((name, version))

    report = run_check(root, fetcher, args.threshold_days,
                       args.check_transitive, args.verbose, exempt_young)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"Dependency existence check ({report['threshold_days']}-day threshold): "
              f"{len(report['checked'])} checked, {len(report['failures'])} finding(s)")
        for f in report["failures"]:
            loc = f"{f['source_file']}:{f['line']}" if f["source_file"] else "(unknown)"
            print(f"  FAIL {f['language']}:{f['name']} — {f['message']} [{loc}]")

    return 0 if report["ok"] else 1


