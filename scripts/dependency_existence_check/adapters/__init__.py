"""Aggregation layer: load every adapter subclass, build ADAPTERS, re-export.

Every subclass must be imported before ADAPTERS is built so instances are
fully initialized; dependency direction is strictly base <- ecosystem modules
<- this module.
"""

from __future__ import annotations

from .base import Adapter
from .cpp import CppAdapter
from .dart import DartAdapter
from .dotnet import DotnetAdapter
from .go import GoAdapter
from .java import JavaAdapter
from .js import JavaScriptAdapter
from .php import PhpAdapter
from .python import PythonAdapter
from .ruby import RubyAdapter
from .rust import RustAdapter
from .swift import SwiftAdapter

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

__all__ = [
    "ADAPTERS",
    "Adapter",
    "CppAdapter",
    "DartAdapter",
    "DotnetAdapter",
    "GoAdapter",
    "JavaAdapter",
    "JavaScriptAdapter",
    "PhpAdapter",
    "PythonAdapter",
    "RubyAdapter",
    "RustAdapter",
    "SwiftAdapter",
]