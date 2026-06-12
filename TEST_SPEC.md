# HoloGram 集成测试规格书

**版本**: 1.0  
**状态**: 待审批  
**覆盖范围**: 多工作区隔离 / 增量一致性 / Tauri 路由 / 缓存路径等价 / 序列化全链路 / 入口等价

---

## 1. 测试基础设施

### 1.1 测试框架

| 层 | 框架 | 目录 |
|---|------|------|
| Python 集成 | pytest + tempfile | `tests/` |
| Rust 路由 | `#[cfg(test)]` + cargo test | `src-tauri/src/` (unit) + `src-tauri/tests/` (integration) |
| Shell 端到端 | bash + diff + jq | `tests/e2e/` |

### 1.2 测试辅助工具

#### Python 侧新增 `tests/helpers.py`

```python
"""测试辅助: 临时项目工厂、图比较、文件操作。"""
import os, json, tempfile, shutil
from pathlib import Path
from typing import List, Tuple

class TempProject:
    """在临时目录创建微型项目，含 Python/TypeScript/Rust 源文件。

    用法:
        with TempProject() as p:
            p.write("a.py", "def foo(): pass")
            p.write("b.py", "from a import foo")
            graph = analyze(p.root)
    """
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="hg_test_")
        self._files: List[str] = []

    def write(self, relpath: str, content: str) -> str:
        full = os.path.join(self.root, relpath)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
        self._files.append(full)
        return full

    def touch(self, relpath: str) -> None:
        """更新 mtime，模拟文件修改。"""
        full = os.path.join(self.root, relpath)
        os.utime(full, None)

    def delete(self, relpath: str) -> None:
        os.remove(os.path.join(self.root, relpath))

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()


def analyze(root: str, changed_files: list = None) -> dict:
    """通过 _analyze_and_output 分析项目，返回 to_dict()。

    changed_files 为 None 时走全量分析，否则走增量模式。
    """
    from src_python.__main__ import _analyze_and_output
    graph = _analyze_and_output(root, changed_files=changed_files)
    return graph.to_dict()


def analyze_cli(root: str, output: str = None) -> dict:
    """通过 cmd_analyze 分析项目，返回 JSON dict。"""
    import argparse
    from src_python.cli import cmd_analyze
    output = output or os.path.join(root, "hologram_graph.json")
    args = argparse.Namespace(root=root, output=output)
    cmd_analyze(args)
    with open(output, "r", encoding="utf-8") as f:
        return json.load(f)


def graph_sizes(d: dict) -> Tuple[int, int]:
    """返回 (node_count, edge_count)。"""
    return len(d.get("nodes", [])), len(d.get("edges", []))


def node_names(d: dict) -> set:
    return {n["name"] for n in d.get("nodes", [])}


def has_coupling(d: dict) -> bool:
    return "coupling" in d.get("meta", {})


def assert_graphs_equal(a: dict, b: dict, ignore_meta_keys: set = None):
    """比较两个 graph dict 的结构等价性（忽略时间戳等可变字段）。"""
    ignore = ignore_meta_keys or {"generated_at"}
    # 比较 meta（忽略时间戳）
    ma = {k: v for k, v in a["meta"].items() if k not in ignore}
    mb = {k: v for k, v in b["meta"].items() if k not in ignore}
    assert ma == mb, f"Meta mismatch: {ma} != {mb}"
    # 比较 nodes
    assert len(a["nodes"]) == len(b["nodes"]), \
        f"Node count mismatch: {len(a['nodes'])} != {len(b['nodes'])}"
    # 比较 edges
    assert len(a["edges"]) == len(b["edges"]), \
        f"Edge count mismatch: {len(a['edges'])} != {len(b['edges'])}"
    # 比较 communities
    assert len(a.get("communities", [])) == len(b.get("communities", []))
```

#### Rust 侧：`src-tauri/src/main.rs` 底部 `#[cfg(test)]` 模块

```rust
// #[cfg(test)] 辅助函数 + 路由测试（集成测试无法访问 binary crate static）
#[cfg(test)]
pub(crate) fn reset_active_project_for_test() {
    ACTIVE_PROJECT.lock().unwrap().clear();
}

#[cfg(test)]
pub(crate) fn set_active_project_for_test(path: &str) {
    *ACTIVE_PROJECT.lock().unwrap() = path.to_string();
}
```

路由测试直接写在 `main.rs` 的 `#[cfg(test)] mod tests` 中，不放在 `src-tauri/tests/`（Rust 集成测试是独立 crate，无法访问 binary crate 的 static）。

### 1.3 运行命令

```bash
# Python 集成测试
python -m pytest tests/ -m integration -v

# Rust 路由测试
cargo test --manifest-path src-tauri/Cargo.toml

# Shell 端到端
bash tests/e2e/run_all.sh
```

---

## 2. 测试场景

### 2.1 多工作区数据隔离

**文件**: `tests/test_integration_workspace.py`  
**标签**: `@pytest.mark.integration`

#### 2.1.1 两个工作区交替分析不互相覆盖

```
目的:     验证 analyze 工作区 A 再 analyze 工作区 B 后，A 的图文件不被 B 覆盖
前置:     项目 A 含 a.py (def func_a: pass)，项目 B 含 b.py (def func_b: pass)
操作:     1. analyze(A) → 保存 A/hologram_graph.json
          2. analyze(B) → 保存 B/hologram_graph.json
          3. 重新读取两份 JSON
验证:     - A 的图中包含 func_a，不包含 func_b
          - B 的图中包含 func_b，不包含 func_a
          - 两个文件的 node_count 可能不同
          - 两个文件内容二进制不同
```

#### 2.1.2 查询路由指向当前活跃项目

```
目的:     验证切换工作区后，查询命令使用的 graph 路径随之切换
前置:     项目 A 含 a.py (def unique_to_a: pass)
          项目 B 含 b.py (def unique_to_b: pass)
操作:     1. analyze(A)
          2. analyze(B)
          3. hologram neighbors unique_to_a -g B/hologram_graph.json
验证:     找不到 unique_to_a（因为 B 的图里没有）
          hologram neighbors unique_to_b -g B/hologram_graph.json → 能找到
```

#### 2.1.3 增量分析不跨工作区污染

```
目的:     验证 A 的增量分析不会修改 B 的图
前置:     A 和 B 都已全量分析过
操作:     1. 修改 A 中的文件 → 增量分析 A
          2. 检查 B/hologram_graph.json 的 mtime
验证:     B 的图文件 mtime 未变化
          B 的图 node_count 不变
```

#### 2.1.4 SQLite 缓存不跨工作区泄漏

```
目的:     验证 A 的搜索结果不包含 B 的数据
前置:     A 含 symbol_a, B 含 symbol_b，都已完成分析（含 SQLite DB）
操作:     1. hologram search symbol -g A/hologram_graph.json
          2. hologram search symbol -g B/hologram_graph.json
验证:     搜索 A 返回的结果中所有 symbol 都属于 A
          搜索 B 返回的结果中所有 symbol 都属于 B
```

---

### 2.2 增量分析一致性

**文件**: `tests/test_pipeline.py`（扩展现有）  
**标签**: `@pytest.mark.integration`

#### 2.2.1 增量 + 全量结果等价

```
目的:     验证增量分析的结果与全量再分析完全一致
前置:     项目含 5 个 .py 文件，有 import 关系
操作:     1. 全量分析 → graph_full_1
          2. 修改 1 个文件（添加一个函数）
          3. 增量分析 → graph_inc
          4. 对修改后的项目全量分析 → graph_full_2
验证:     graph_inc.node_count == graph_full_2.node_count
          graph_inc.edge_count == graph_full_2.edge_count
          graph_inc 的每个节点属性与 graph_full_2 一致
```

#### 2.2.2 删除 import 边被正确移除

```
目的:     验证删除 import 后增量分析会移除对应边
前置:     a.py import b.py 的 func_b
操作:     1. 全量分析 → 确认 a→b 的边存在
          2. 从 a.py 中删除 import 语句
          3. 增量分析
验证:     a→b 的边不再存在
          但 a 和 b 的节点仍然存在
```

#### 2.2.3 删除文件后节点和边都被移除

```
目的:     验证删除整个文件后增量分析清理所有关联数据
前置:     项目含 a.py 和 b.py, a import b
操作:     1. 全量分析 → 记下 node_count
          2. 删除 b.py
          3. 增量分析
验证:     b.py 中的所有符号节点被移除
          a→b 的所有边被移除
          node_count 正确减少
```

#### 2.2.4 连续增量不累积错误（5 轮）

```
目的:     验证连续多次增量分析不产生漂移
前置:     项目含 10 个 .py 文件
操作:     1. 全量分析 → baseline
          2. 循环 5 次:
             a. 随机修改 1 个文件（添加/删除/重命名符号）
             b. 增量分析
          3. 全量再分析 → final
验证:     final.node_count == 最后一次增量后的 node_count
          final.edge_count == 最后一次增量后的 edge_count
```

#### 2.2.5 增量后 coupling_summary 被更新

```
目的:     验证增量分析后 coupling 数据被重新计算（不是残留旧值）
前置:     项目含跨模块调用
操作:     1. 全量分析 → 记录 coupling L1-L4 分布
          2. 添加跨模块调用（产生新的 L4 violation）
          3. 增量分析
验证:     graph.meta.coupling 存在
          L4 数量 >= 修改前（新 violation 被检测到）
```

---

### 2.3 Tauri 命令路由

**文件**: `src-tauri/src/main.rs`（`#[cfg(test)] mod tests`）

#### 2.3.1 active_graph() 未设置时 fallback 到 default_graph()

```
目的:     验证冷启动（无活跃项目）时的 fallback 行为
前置:     ACTIVE_PROJECT 为空
操作:     调用 active_graph()
验证:     返回 project_root()/hologram_graph.json（即 default_graph() 的值）
```

#### 2.3.2 active_graph() 设置后返回工作区路径

```
目的:     验证活跃项目路径拼接正确
前置:     ACTIVE_PROJECT = "D:/projects/foo"
操作:     调用 active_graph()
验证:     返回 "D:/projects/foo/hologram_graph.json"
```

#### 2.3.3 工作区路径末尾带斜杠不产生双斜杠

```
目的:     验证路径规范化
前置:     ACTIVE_PROJECT = "D:/projects/foo/" 或 "D:\\projects\\foo\\"
操作:     调用 active_graph()
验证:     返回路径中不含 "//" 或 "\\\\"
          路径能被 PathBuf 正常解析
```

#### 2.3.4 analyze_and_load 失败不覆盖 ACTIVE_PROJECT

```
目的:     验证错误路径不会改变活跃工作区
前置:     ACTIVE_PROJECT 当前 = "/valid/path"
操作:     analyze_and_load("/nonexistent/path") → 返回 Err
验证:     ACTIVE_PROJECT 仍为 "/valid/path"（不受 Err 路径影响）
```

#### 2.3.5 analyze_and_load 成功设置 ACTIVE_PROJECT

```
目的:     验证正常流程设置活跃工作区
前置:     ACTIVE_PROJECT 为空
操作:     analyze_and_load("/valid/project") → 返回 Ok
验证:     ACTIVE_PROJECT = "/valid/project"
          active_graph() = "/valid/project/hologram_graph.json"
```

#### 2.3.6 ACTIVE_PROJECT 线程安全

```
目的:     验证并发场景下 Mutex 不 panic
前置:     ACTIVE_PROJECT 为空
操作:     同时从两个线程设置 ACTIVE_PROJECT
验证:     无 panic，无 deadlock，最终值是两个值之一
```

---

### 2.4 缓存快慢路径等价

**文件**: `tests/test_integration_workspace.py`  
**标签**: `@pytest.mark.integration`

#### 2.4.1 快路径（fresh cache）和慢路径（Python 重分析）返回等价结果

```
目的:     验证两种路径的图结构一致
前置:     项目已分析过（hologram_graph.json 存在且 fresh）
操作:     1. 通过 is_graph_fresh 确认 cache fresh
          2. 快路径: 直接读取 hologram_graph.json → struct_1
          3. 慢路径: Python 重分析 → struct_2
验证:     struct_1.node_count == struct_2.node_count
          struct_1.edge_count == struct_2.edge_count
          忽略 generated_at 字段差异
```

#### 2.4.2 源文件修改后 is_graph_fresh 返回 false

```
目的:     验证 staleness 检测正确触发
前置:     项目已分析，cache fresh
操作:     修改一个 .py 文件（更新 mtime）
验证:     is_graph_fresh(graph_path, project_path) 返回 false
          下次 analyze_and_load 走慢路径
```

#### 2.4.3 新增文件后 is_graph_fresh 返回 false

```
目的:     验证新文件也被视为 staleness
前置:     项目已分析，cache fresh
操作:     在项目中创建新的 .py 文件
验证:     is_graph_fresh() 返回 false（新文件 mtime > graph mtime）
```

---

### 2.5 序列化全链路一致性

**文件**: `tests/test_serialization_roundtrip.py`（扩展现有）  
**标签**: `@pytest.mark.integration`

#### 2.5.1 JSON → Graph → JSON 往返不丢 coupling_summary

```
目的:     验证 coupling 数据在序列化闭环中存活
前置:     完整 graph（含 nodes/edges/communities/coupling_summary）
操作:     graph.to_json(tmp_path)
          reloaded = Graph.from_json(tmp_path)
验证:     reloaded.coupling_summary 存在
          reloaded.coupling_summary["total_l1"] == 原始值
          to_dict() 的 meta.coupling 字段完整
```

#### 2.5.2 JSON → Graph → SQLite → Graph → JSON 往返

```
目的:     验证 SQLite 加速层不丢失数据
前置:     完整 graph（>50 nodes）
操作:     graph.to_json(json_path)
          graph.to_sqlite(db_path)
          from_sqlite = Graph.from_sqlite(db_path)
验证:     from_sqlite.node_count == graph.node_count
          from_sqlite.edge_count == graph.edge_count
          from_sqlite.community_count == graph.community_count
```

#### 2.5.3 JSON → Graph → MessagePack → Graph → JSON 往返

```
目的:     验证 MessagePack 二进制格式不丢失数据
前置:     完整 graph
操作:     graph.to_msgpack(mp_path)
          from_mp = Graph.from_msgpack(mp_path)
          json_original = graph.to_dict()
          json_from_mp = from_mp.to_dict()
验证:     json_original["meta"]["node_count"] == json_from_mp["meta"]["node_count"]
          json_original["meta"]["edge_count"] == json_from_mp["meta"]["edge_count"]
          json_original["meta"]["coupling"] == json_from_mp["meta"]["coupling"]
```

#### 2.5.4 to_dict() 总是包含 coupling_summary（如果图有的话）

```
目的:     防止今天修复的回归——to_dict() 丢 coupling
前置:     graph 已经过 CouplingDepthAnalyzer 处理（graph.coupling_summary 已设置）
操作:     d = graph.to_dict()
验证:     "coupling" in d["meta"]
          d["meta"]["coupling"]["total_l1"] 为整数
          d["meta"]["coupling"]["total_l4"] 为整数
```

---

### 2.6 CLI 与 Tauri 入口等价

**文件**: `tests/test_entry_point_equivalence.py`（扩展现有）  
**标签**: `@pytest.mark.integration`

#### 2.6.1 _analyze_and_output 与 cmd_analyze 结果等价

```
目的:     验证两个分析入口产生等价结果
前置:     同一个项目目录（含 .py 和 .ts 文件）
操作:     1. _analyze_and_output(root) → result_a
          2. cmd_analyze(args) → result_b
验证:     result_a.node_count == result_b.node_count
          result_a.edge_count == result_b.edge_count
          两种方式都有 coupling_summary
          community_count 一致
```

#### 2.6.2 两个入口都注册了 TreeSitterAdapter

```
目的:     验证今天修复的 bug 不会回归——两个入口都支持非 Python/TS 语言
前置:     项目含 .rs 文件（Rust）或 .go 文件（Go）
操作:     1. _analyze_and_output(root) → result_a
          2. cmd_analyze(args) → result_b
验证:     result_a 包含来自 .rs 文件的符号节点
          result_b 也包含来自 .rs 文件的符号节点
          result_a.node_count == result_b.node_count
```

#### 2.6.3 _analyze_and_output 增量模式也注册了 TreeSitterAdapter

```
目的:     增量模式不应遗漏非 Python/TS 文件
前置:     项目含 .rs 文件，已完成全量分析
操作:     修改 .rs 文件 → _analyze_and_output(root, changed_files=[...])
验证:     graph 中的 Rust 符号节点被更新（node_count 不变或增加）
```

---

## 2.7 Shell 端到端（可选，高覆盖但执行慢）

**文件**: `tests/e2e/test_multi_workspace.sh`  
**依赖**: bash + jq + python

```bash
#!/bin/bash
# 端到端: 多工作区隔离
set -euo pipefail

A=$(mktemp -d)
B=$(mktemp -d)
trap "rm -rf $A $B" EXIT

# 创建两个不同的项目
echo "def func_a(): pass" > "$A/a.py"
echo "def func_b(): pass" > "$B/b.py"

# 分析
python -m src_python "$A"
python -m src_python "$B"

# 验证 A 的图不含 func_b
if grep -q "func_b" "$A/hologram_graph.json"; then
    echo "FAIL: A 的图包含 B 的符号"
    exit 1
fi

# 验证 B 的图不含 func_a
if grep -q "func_a" "$B/hologram_graph.json"; then
    echo "FAIL: B 的图包含 A 的符号"
    exit 1
fi

echo "PASS: 多工作区隔离"
```

---

## 3. 测试数据规范

### 3.1 临时项目结构

所有集成测试使用 `TempProject` 工厂创建隔离的临时项目，**绝不使用真实项目**。最小可用项目：

```
tmpXXXX/
  a.py          # 3-5 个函数/类
  b.py          # import a，含 2-3 个函数
  sub/
    c.py        # import a, b（跨目录依赖）
```

### 3.2 多语言项目（用于 TreeSitterAdapter 测试）

```
tmpXXXX/
  main.py       # Python 符号
  utils.rs      # Rust 符号（fn, struct）
  helper.go     # Go 符号（func, type）
```

### 3.3 命名约定

- 测试函数统一用 `test_` 前缀
- 集成测试加 `@pytest.mark.integration` 标记
- 慢速测试（>5s）加 `@pytest.mark.slow`
- 临时目录前缀: `hg_test_`

### 3.4 隔离保证

- 每个测试用例独立创建 `TempProject`
- 测试结束后自动清理（`with TempProject() as p:` 或 `teardown`）
- 不依赖 `D:\HoloGramHG` 下的任何真实文件
- 不修改 `hologram_full.json` 或项目根目录的任何文件
- Rust 测试每次 reset `ACTIVE_PROJECT` 到空状态

---

## 4. CI 集成

```yaml
# .github/workflows/test.yml (建议)
jobs:
  python-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install -e ".[test]"
      - run: python -m pytest tests/ -m "integration or slow" -v --timeout=120

  rust-routing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo test --manifest-path src-tauri/Cargo.toml

  shell-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
      - run: bash tests/e2e/run_all.sh
```

---

## 5. 文件清单

```
新增:
  tests/helpers.py                        # TempProject, analyze, 断言工具
  tests/test_integration_workspace.py     # 2.1 多工作区隔离 + 2.4 缓存路径
  tests/e2e/test_multi_workspace.sh       # 2.7 Shell 端到端
  tests/e2e/run_all.sh                    # E2E 入口

扩展:
  tests/test_pipeline.py                  # 2.2 增量一致性
  tests/test_serialization_roundtrip.py   # 2.5 序列化全链路
  tests/test_entry_point_equivalence.py   # 2.6 入口等价
  src-tauri/src/main.rs                   # #[cfg(test)] 路由测试 + 辅助函数

不涉及:
  src-ui/                                 # 前端测试另案处理
  src_python/                             # 业务逻辑（仅修复 TreeSitterAdapter 注册遗漏）
```

---

## 6. 验收标准

- [ ] `python -m pytest tests/ -m integration -v` 全部通过
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 全部通过
- [ ] `bash tests/e2e/run_all.sh` 全部通过
- [ ] 以下回归场景被测试拦截:
  - [ ] 工作区 A 的图不包含工作区 B 的符号
  - [ ] 增量分析结果与全量一致
  - [ ] `active_graph()` 未设置时 fallback
  - [ ] 快路径和慢路径返回等价结果
  - [ ] `to_dict()` 包含 `coupling_summary`
  - [ ] `_analyze_and_output` 注册了 `TreeSitterAdapter`
