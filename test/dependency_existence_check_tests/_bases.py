"""Shared harnesses for the offline safety-net suite.

Split out of the two 21-function scenario modules (issue #2006 VBA God Module
refactor): the interval reset both registry-facing suites need lives here once,
so no scenario sibling lands over the raw-text function-count ceiling.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403


class AdapterExtractionBase(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def names(self, adapter, text, path=None):
        return [(d.name, d.version) for d in adapter.extract(text, path)]

    @staticmethod
    def P(name):
        return Path(name)


class RegistryIntervalBase(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv
