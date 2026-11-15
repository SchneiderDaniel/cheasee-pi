"""Scenario modules for the dependency-existence safety-net suite (issue #2005).

The shared family is a barrel plus three leaves: `_loader.py` (importlib shim
that binds `dec`), `_routes.py` (fake registry response shapes, owns
`OLD_ISO`), `_fakes.py` (transport fake), and `_common.py`, the barrel every
scenario module star-imports. No leaf imports the barrel, so the family's
import graph is acyclic (issue #2104).
"""
