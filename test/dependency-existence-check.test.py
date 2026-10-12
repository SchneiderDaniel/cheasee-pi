#!/usr/bin/env python3
"""Offline test suite for scripts/dependency-existence-check.py.

No network: every test injects a FakeFetcher (via main(argv, fetcher=...)) that
raises AssertionError on unregistered URLs, so an accidental real registry call
fails the test instead of silently skipping. The cache/ETag tests exercise the
real DiskCache/RealFetcher against a fake transport.

Split (issue #2005 Long File refactor): the shared harness lives in
`test/dependency_existence_check_tests/_common.py` and one scenario module per
`TestCase` class. This file keeps the historical `python3` invocation path.

Run:  python3 test/dependency-existence-check.test.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dependency_existence_check_tests._common import *  # noqa: E402,F401,F403
from dependency_existence_check_tests.test_pipeline_age_guard import (  # noqa: E402,F401
    PipelineAndAgeGuardTests,
)
from dependency_existence_check_tests.test_discovery_gitignore import (  # noqa: E402,F401
    DiscoveryAndGitignoreTests,
)
from dependency_existence_check_tests.test_adapter_extraction import (  # noqa: E402,F401
    AdapterExtractionTests,
)
from dependency_existence_check_tests.test_adapter_extraction_jvm_dotnet import (  # noqa: E402,F401
    AdapterExtractionJvmDotnetTests,
)
from dependency_existence_check_tests.test_adapter_extraction_systems_dynamic import (  # noqa: E402,F401
    AdapterExtractionSystemsDynamicTests,
)
from dependency_existence_check_tests.test_registry_transport import (  # noqa: E402,F401
    RegistryAndTransportTests,
)
from dependency_existence_check_tests.test_registry_transport_cache import (  # noqa: E402,F401
    RegistryTransportCacheTests,
)
from dependency_existence_check_tests.test_registry_transport_registries import (  # noqa: E402,F401
    RegistryTransportRegistriesTests,
)
from dependency_existence_check_tests.test_ignore_mechanism import (  # noqa: E402,F401
    IgnoreMechanismTests,
)
from dependency_existence_check_tests.test_end_to_end import (  # noqa: E402,F401
    EndToEndTests,
)

if __name__ == "__main__":
    unittest.main(verbosity=2)
