"""
Multiprocessing worker — analyze one file per call.
Module-level function so multiprocessing can pickle it on Windows.
"""

from __future__ import annotations

import os as _os
from typing import Tuple


# Return type: (file_path, nodes, edges, errors, warnings)
WorkerResult = Tuple[str, list, list, list, list]


def analyze_file(file_path: str, source: str, adapter_key: str = '') -> WorkerResult:
    """Analyze one source file. `adapter_key` selects the adapter type.

    No merged graph is passed — each file is analyzed independently.
    Cross-file edges are resolved later by CrossFileResolver.
    """
    if not adapter_key:
        ext = _os.path.splitext(file_path)[1].lower()
        if ext == '.py':
            adapter_key = 'python'
        elif ext in ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'):
            adapter_key = 'typescript'
        else:
            adapter_key = 'treesitter'

    try:
        if adapter_key == 'python':
            from ..adapters.python_adapter import PythonAdapter
            adapter = PythonAdapter()
        elif adapter_key == 'typescript':
            from ..adapters.typescript_adapter import TypeScriptAdapter
            adapter = TypeScriptAdapter()
        else:
            from ..adapters.tree_sitter_adapter import TreeSitterAdapter
            adapter = TreeSitterAdapter()

        result = adapter.analyze(file_path, source)
        return (
            file_path,
            list(result.nodes),
            list(result.edges),
            list(result.errors),
            list(result.warnings),
        )
    except Exception as exc:
        return (file_path, [], [], [str(exc)], [])
