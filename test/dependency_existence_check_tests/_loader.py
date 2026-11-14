"""The family's leaf: loads `scripts/dependency-existence-check.py` as `dec`.

Split out of `_common.py` (issue #2104, circular dependencies): the barrel used
to define `dec` and `OLD_ISO` itself and only then import its siblings, so
`_routes.py` and `_fakes.py` had to import those facts back from a partially
initialized `_common` — two real module-level cycles
(`_common -> _routes -> _common`, `_common -> _fakes -> _common`). Loading the
production module lives here instead, in a module that imports nothing from the
package, so every other family member may import it without a back-reference.

`dec` is bound at import time (the production module is executed here), which is
the ordering guarantee the siblings relied on before: importing this module is
enough to get a ready `dec`.
"""

import importlib.util
import sys
from pathlib import Path

# `_HERE` is the `test/` directory (this module lives one level deeper), so
# `_HERE.parent` stays the repo root and `_SCRIPTS` stays `scripts/`.
_HERE = Path(__file__).resolve().parent.parent
_SCRIPTS = _HERE.parent / "scripts"
_spec = importlib.util.spec_from_file_location(
    "dependency_existence_check", _SCRIPTS / "dependency-existence-check.py")
assert _spec is not None, "scripts/dependency-existence-check.py must exist"
dec = importlib.util.module_from_spec(_spec)
_spec_loader = _spec.loader
assert _spec_loader is not None, "loaded spec must have a loader"
sys.modules["dependency_existence_check"] = dec  # dataclass machinery requires it
_spec_loader.exec_module(dec)
