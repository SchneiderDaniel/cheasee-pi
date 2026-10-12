from ._common import *  # noqa: F401,F403


class PublicSurfaceTests(unittest.TestCase):
    def test_reexport_set(self):
        for name in _PUBLIC_NAMES:
            self.assertTrue(hasattr(dec, name), f"shim missing {name}")
            self.assertTrue(hasattr(dec.adapters, name), f"package missing {name}")

    def test_all_declared(self):
        self.assertEqual(set(dec.adapters.__all__), _PUBLIC_NAMES)

    def test_core_adapters_identity(self):
        self.assertIs(dec.core.ADAPTERS, dec.ADAPTERS)

    def test_adapters_snapshot(self):
        got = [(a.language, a.priority, a.registry_name, a.age_supported,
                a.inline_marker, a.patterns) for a in dec.ADAPTERS]
        self.assertEqual(got, _ADAPTER_ATTRS)

    def test_adapter_classes(self):
        for a in dec.ADAPTERS:
            self.assertIsInstance(a, dec.Adapter)
            self.assertIn(type(a).__name__, _SUBCLASSES)
        for name in _SUBCLASSES:
            self.assertTrue(issubclass(getattr(dec, name), dec.Adapter), name)
        self.assertNotIn(type(dec.Adapter()), [type(a) for a in dec.ADAPTERS])
