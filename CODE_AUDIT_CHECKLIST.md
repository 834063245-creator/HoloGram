# 你的任务：逐文件审计 src_python/

按下面的清单顺序，一次处理一个文件。每处理完一个，把它的 `- [ ]` 改成 `- [x]`。

## 每个文件做三件事

**1. 找认栽的测试**

去 `tests/` 目录找这个文件对应的测试，用 `pytest -v` 跑一遍。搜这几个词：
`limitation`, `at least doesn't crash`, `FIXME`, `TODO`, `known bug`, `workaround`
找到就是已知漏洞——记下来，修掉它。

**2. ruff 自动修**

```bash
ruff check --fix <文件路径>
```

**3. 读代码找逻辑漏写**

重点查这五种：
- 循环只遍历了一侧，忘了另一侧（比如只遍历 new 的 key，不遍历 old 的 key）
- 某个东西被删了/没了，代码检测不到
- 字典 key 碰撞，后来的静默覆盖前面的
- 异常被 catch 了但没打日志也没重新 raise
- 边界条件：空输入、None、空列表、空字符串

找到之后修掉。然后去对应的测试文件，把原来认栽的测试改成真正抓到它的断言，或者补一条新测试。

**每改完一个文件，必须跑：**

```bash
pytest -x --timeout=30
```

绿了才能勾掉，继续下一个。

---

## 清单

### core/ — 第一个做，心脏地带

- [x] `src_python/core/__init__.py`
- [x] `src_python/core/graph.py`
- [x] `src_python/core/diff.py`
- [x] `src_python/core/merger.py`
- [x] `src_python/core/rename.py`
- [x] `src_python/core/community.py`

### pipeline/ — 第二个做，连接一切

- [x] `src_python/pipeline/__init__.py`
- [x] `src_python/pipeline/runner.py`
- [x] `src_python/pipeline/discovery.py`
- [x] `src_python/pipeline/cache.py`
- [x] `src_python/pipeline/worker.py`

### analysis/ — 第三个做，逻辑最复杂

- [x] `src_python/analysis/__init__.py`
- [x] `src_python/analysis/blindspots.py`
- [x] `src_python/analysis/coupling.py`
- [x] `src_python/analysis/dataflow.py`
- [x] `src_python/analysis/threading.py`

### routing/ — 第四个做

- [x] `src_python/routing/__init__.py`
- [x] `src_python/routing/constraints.py`
- [x] `src_python/routing/patterns.py`
- [x] `src_python/routing/preflight.py`
- [x] `src_python/routing/signals.py`
- [x] `src_python/routing/summary.py`

### adapters/ — 第五个做

- [x] `src_python/adapters/__init__.py`
- [x] `src_python/adapters/base.py`
- [x] `src_python/adapters/registry.py`
- [x] `src_python/adapters/python_adapter.py`
- [x] `src_python/adapters/typescript_adapter.py`
- [x] `src_python/adapters/tree_sitter_adapter.py`
- [x] `src_python/adapters/tree_sitter_grammars.py`

### 顶层 — 最后做

- [x] `src_python/__init__.py`
- [x] `src_python/__main__.py`
- [x] `src_python/cli.py`
- [x] `src_python/mcp_server.py`
- [x] `src_python/watcher.py`
- [x] `src_python/timeline.py`

---

## 完成后

全部勾完以后，跑一遍全量测试确认：

```bash
pytest -x --timeout=60
```
