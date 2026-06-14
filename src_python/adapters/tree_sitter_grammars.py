"""
Tree-sitter Grammar 管理器：下载、编译、缓存、加载语言 grammar。

用法：
  manager = GrammarManager()
  manager.ensure("python")       # 自动下载 + 编译
  lang = manager.load("python")  # 返回 tree_sitter.Language

依赖：git + gcc（Windows 上需 MSYS2/MinGW）
"""

from __future__ import annotations

import ctypes
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import tree_sitter
import sys
from pathlib import Path
from typing import Dict, Optional

_tree_sitter = None

def _ts():
    """Lazy import tree_sitter — only when actually loading a grammar."""
    global _tree_sitter
    if _tree_sitter is None:
        import tree_sitter as ts
        _tree_sitter = ts
    return _tree_sitter


# ── 已知语言配置 ──────────────────────────────────────────────

LANGUAGE_REPOS: Dict[str, dict] = {
    "python": {
        "repo": "https://github.com/tree-sitter/tree-sitter-python.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_python",
        "extensions": [".py"],
    },
    "javascript": {
        "repo": "https://github.com/tree-sitter/tree-sitter-javascript.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_javascript",
        "extensions": [".js", ".mjs", ".cjs"],
    },
    "typescript": {
        "repo": "https://github.com/tree-sitter/tree-sitter-typescript.git",
        "src_dir": "typescript",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_typescript",
        "extensions": [".ts", ".mts", ".cts"],
    },
    "tsx": {
        "repo": "https://github.com/tree-sitter/tree-sitter-typescript.git",
        "src_dir": "tsx",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_tsx",
        "extensions": [".tsx"],
    },
    "go": {
        "repo": "https://github.com/tree-sitter/tree-sitter-go.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c"],
        "symbol": "tree_sitter_go",
        "extensions": [".go"],
    },
    "rust": {
        "repo": "https://github.com/tree-sitter/tree-sitter-rust.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_rust",
        "extensions": [".rs"],
    },
    "java": {
        "repo": "https://github.com/tree-sitter/tree-sitter-java.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c"],
        "symbol": "tree_sitter_java",
        "extensions": [".java"],
    },
    "c": {
        "repo": "https://github.com/tree-sitter/tree-sitter-c.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c"],
        "symbol": "tree_sitter_c",
        "extensions": [".c", ".h"],
    },
    "cpp": {
        "repo": "https://github.com/tree-sitter/tree-sitter-cpp.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_cpp",
        "extensions": [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    },
    "ruby": {
        "repo": "https://github.com/tree-sitter/tree-sitter-ruby.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_ruby",
        "extensions": [".rb"],
    },
    "c_sharp": {
        "repo": "https://github.com/tree-sitter/tree-sitter-c-sharp.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_c_sharp",
        "extensions": [".cs"],
    },
    "kotlin": {
        "repo": "https://github.com/fwcd/tree-sitter-kotlin.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_kotlin",
        "extensions": [".kt", ".kts"],
    },
    "swift": {
        "repo": "https://github.com/alex-pinkus/tree-sitter-swift.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_swift",
        "extensions": [".swift"],
    },
    "php": {
        "repo": "https://github.com/tree-sitter/tree-sitter-php.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_php",
        "extensions": [".php"],
    },
    "lua": {
        "repo": "https://github.com/tree-sitter-grammars/tree-sitter-lua.git",
        "src_dir": ".",
        "parser_files": ["src/parser.c", "src/scanner.c"],
        "symbol": "tree_sitter_lua",
        "extensions": [".lua"],
    },
}


class GrammarManager:
    """
    管理 tree-sitter 语言 grammars 的下载、编译、加载和缓存。

    工作流程：
    1. ensure(lang_name) — 确保 grammar 已编译为 DLL
    2. load(lang_name)  — 返回 tree_sitter.Language 对象
    3. 自动按文件扩展名查找对应 language
    """

    def __init__(self, cache_dir: Optional[str] = None):
        if cache_dir:
            self._cache_dir = Path(cache_dir)
        else:
            # 默认存储在 HoloGram 用户数据目录
            self._cache_dir = Path.home() / ".hologram" / "grammars"
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        self._loaded: Dict[str, "tree_sitter.Language"] = {}
        self._loaded_dlls: Dict[str, "ctypes.CDLL"] = {}
        self._ext_to_lang: Dict[str, str] = {}

        # 构建扩展名 → 语言名索引
        for lang_name, cfg in LANGUAGE_REPOS.items():
            for ext in cfg["extensions"]:
                self._ext_to_lang[ext] = lang_name

    # ── public API ────────────────────────────────────────────

    @property
    def cache_dir(self) -> Path:
        return self._cache_dir

    def supported_languages(self) -> list:
        """返回所有可支持的语言名列表。"""
        return sorted(LANGUAGE_REPOS.keys())

    def supported_extensions(self) -> list:
        """返回所有可处理的文件扩展名。"""
        return sorted(self._ext_to_lang.keys())

    def find_language(self, file_path: str) -> Optional[str]:
        """按文件扩展名查找对应语言名。"""
        for ext, lang in self._ext_to_lang.items():
            if file_path.endswith(ext):
                return lang
        return None

    def ensure(self, lang_name: str) -> bool:
        """
        确保指定语言的 grammar DLL 已就绪。
        如果不存在则自动下载 + 编译。
        返回 True 表示就绪。
        """
        if lang_name not in LANGUAGE_REPOS:
            raise ValueError(
                f"Unknown language: {lang_name}. "
                f"Supported: {', '.join(sorted(LANGUAGE_REPOS.keys()))}"
            )

        dll_path = self._dll_path(lang_name)
        if dll_path.exists():
            return True

        return self._build(lang_name)

    def load(self, lang_name: str) -> "tree_sitter.Language":
        """加载语言 grammar，返回 tree_sitter.Language。自动 ensure。"""
        if lang_name in self._loaded:
            return self._loaded[lang_name]

        if lang_name not in LANGUAGE_REPOS:
            raise ValueError(
                f"Unknown language: {lang_name}. "
                f"Supported: {', '.join(sorted(LANGUAGE_REPOS.keys()))}"
            )

        if not self.ensure(lang_name):
            raise RuntimeError(f"Failed to build grammar for {lang_name}")

        lang = self._load_dll(lang_name)
        self._loaded[lang_name] = lang
        return lang

    def preload_all(self) -> Dict[str, bool]:
        """预加载所有已知语言（会下载+编译缺失的）。返回每语言的结果。"""
        results = {}
        for lang_name in LANGUAGE_REPOS:
            try:
                self.load(lang_name)
                results[lang_name] = True
            except Exception as e:
                results[lang_name] = False
                print(f"  [warn] Failed to load {lang_name}: {e}", file=sys.stderr)
        return results

    # ── internal ──────────────────────────────────────────────

    def _dll_path(self, lang_name: str) -> Path:
        return self._cache_dir / f"tree-sitter-{lang_name}.dll"

    def _repo_dir(self, lang_name: str) -> Path:
        return self._cache_dir / "repos" / lang_name

    def _build(self, lang_name: str) -> bool:
        """下载 + 编译 grammar。"""
        cfg = LANGUAGE_REPOS[lang_name]
        repo_dir = self._repo_dir(lang_name)
        dll_path = self._dll_path(lang_name)

        # Step 1: clone repo
        if not (repo_dir / ".git").exists():
            print(f"  [tree-sitter] cloning {cfg['repo']} ...", file=sys.stderr)
            result = subprocess.run(
                ["git", "clone", "--depth", "1", cfg["repo"], str(repo_dir)],
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"Failed to clone {cfg['repo']}: {result.stderr[-300:]}"
                )

        # Step 2: find source dir
        src_dir = repo_dir / cfg["src_dir"]

        # Step 3: build list of source files
        src_files = []
        include_dirs = set()
        for pf in cfg["parser_files"]:
            f = src_dir / pf
            if not f.exists():
                # Some grammars have different file layouts
                # Try without src/ prefix
                alt = src_dir / Path(pf).name
                if alt.exists():
                    f = alt
                else:
                    raise RuntimeError(f"Source file not found: {f}")
            src_files.append(str(f))
            include_dirs.add(str(f.parent))

        # Step 4: compile
        gcc = "gcc"
        include_flags = " ".join(f"-I{d}" for d in include_dirs)
        cmd = (
            f'{gcc} -shared -fPIC -O2 '
            f'{include_flags} '
            f'{" ".join(src_files)} '
            f'-o "{dll_path}"'
        )
        print(f"  [tree-sitter] compiling {lang_name} ...", file=sys.stderr)
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to compile {lang_name} grammar: {result.stderr[-400:]}"
            )

        return dll_path.exists()

    def _load_dll(self, lang_name: str) -> "tree_sitter.Language":
        """从 DLL 加载 tree_sitter.Language。"""
        cfg = LANGUAGE_REPOS[lang_name]
        dll_path = self._dll_path(lang_name)

        # 使用 ctypes 加载 DLL 并提取 TSLanguage 指针
        dll = ctypes.CDLL(str(dll_path))
        self._loaded_dlls[lang_name] = dll
        lang_func = getattr(dll, cfg["symbol"])
        lang_func.restype = ctypes.c_void_p
        lang_ptr = lang_func()

        return _ts().Language(lang_ptr)

    def unload(self, lang_name: Optional[str] = None) -> None:
        """卸载 DLL 句柄。不传参数则卸载全部。"""
        if lang_name:
            self._loaded_dlls.pop(lang_name, None)
            self._loaded.pop(lang_name, None)
        else:
            self._loaded_dlls.clear()
            self._loaded.clear()
