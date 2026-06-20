# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试适配器注册表。"""

import pytest

from src_python.adapters import AdapterRegistry, PythonAdapter, LanguageAdapter


class TestAdapterRegistry:
    @pytest.fixture
    def registry(self):
        reg = AdapterRegistry()
        reg.register(PythonAdapter())
        return reg

    def test_register_and_find(self, registry):
        adapter = registry.find("foo.py")
        assert adapter is not None
        assert adapter.language == "python"

    def test_find_by_extension(self, registry):
        assert registry.find("main.py") is not None
        assert registry.find("deep/nested/file.py") is not None
        assert registry.find("script.pyw") is None  # .pyw not registered

    def test_find_unknown_extension(self, registry):
        assert registry.find("main.js") is None
        assert registry.find("main.ts") is None
        assert registry.find("main.rs") is None
        assert registry.find("README.md") is None

    def test_find_by_language(self, registry):
        adapter = registry.find_by_language("python")
        assert adapter is not None
        assert registry.find_by_language("rust") is None

    def test_supported_extensions(self, registry):
        exts = registry.supported_extensions
        assert ".py" in exts

    def test_languages(self, registry):
        langs = registry.languages
        assert "python" in langs

    def test_adapter_count(self, registry):
        assert registry.adapter_count == 1

    def test_multiple_adapters(self):
        reg = AdapterRegistry()
        reg.register(PythonAdapter())

        # 注册第二个 Python 适配器（模拟不同配置）
        class CustomPythonAdapter(PythonAdapter):
            language = "python-custom"
            file_extensions = [".pyx"]

        reg.register(CustomPythonAdapter())
        assert reg.adapter_count == 2
        assert reg.find("test.pyx") is not None
        assert reg.find("test.py") is not None

    def test_empty_registry(self):
        reg = AdapterRegistry()
        assert reg.adapter_count == 0
        assert reg.find("test.py") is None
        assert reg.supported_extensions == []
