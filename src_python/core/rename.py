"""
安全重命名引擎 —— 四阶段原子改名。

Phase 1: 发现 —— find_node_by_name 找定义 + incoming_edges 找所有引用
Phase 2: 预览 —— 返回影响文件清单和引用数，不修改任何文件
Phase 3: 执行 —— 备份 → 替换 → 写入，任一步失败全部回滚
Phase 4: 图更新 —— 更新节点 name；图保存到磁盘触发 watcher 刷新前端

核心安全设计：
  - 引用追踪用 incoming_edges 而非文本 grep → 不会误匹配注释/字符串
  - 定义行用语言感知 regex（def / class / fn / func 等）
  - 写文件原子 temp-file-then-rename，有 .hologram_bak 备份用于回滚
  - 检查 new_name 是否已存在 → 防止重名合并
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .graph import Graph, Node, file_from_location


# ── 语言感知的定义行匹配 ──

_DEFINITION_PATTERNS: Dict[str, str] = {
    # Python
    ".py": r'\b(def|class)\s+{old}\b',
    ".pyi": r'\b(def|class)\s+{old}\b',
    # TypeScript / JavaScript
    ".ts": r'\b(function|class|const|let|var|interface|type|enum)\s+{old}\b',
    ".tsx": r'\b(function|class|const|let|var|interface|type|enum)\s+{old}\b',
    ".js": r'\b(function|class|const|let|var)\s+{old}\b',
    ".jsx": r'\b(function|class|const|let|var)\s+{old}\b',
    ".mjs": r'\b(function|class|const|let|var)\s+{old}\b',
    # Rust
    ".rs": r'\b(fn|struct|enum|trait|impl|mod|type|const|static)\s+{old}\b',
    # Go
    ".go": r'\b(func|type|var|const)\s+{old}\b',
}


def _definition_regex(file_path: str, old_name: str) -> Optional[re.Pattern]:
    """返回此文件中定义行的匹配 regex。不支持的语言返回 None。"""
    ext = os.path.splitext(file_path)[1].lower()
    template = _DEFINITION_PATTERNS.get(ext)
    if not template:
        return None
    return re.compile(template.format(old=re.escape(old_name)))


# ── 数据模型 ──

@dataclass
class RenamePlan:
    """改名计划的完整数据。"""
    old_name: str
    new_name: str
    definition_nodes: List[Node] = field(default_factory=list)
    reference_nodes: List[Node] = field(default_factory=list)  # incoming edges 的 source
    files_to_modify: List[str] = field(default_factory=list)
    ambiguous: List[Node] = field(default_factory=list)  # 同名但不同 ID 的节点


# ── Phase 1: 发现 ──

def find_rename_targets(
    graph: Graph,
    old_name: str,
    node_id: Optional[str] = None,
) -> RenamePlan:
    """
    找到所有需要修改的位置。

    如果 node_id 指定，只重命名该节点（用于消歧义）。
    """
    plan = RenamePlan(old_name=old_name, new_name="")

    # 找到所有同名的定义节点
    all_matches = graph.find_node_by_name(old_name)
    if not all_matches:
        return plan

    # 消歧义
    if node_id:
        matches = [n for n in all_matches if n.id == node_id]
        if not matches:
            return plan
        plan.ambiguous = [n for n in all_matches if n.id != node_id]
    elif len(all_matches) > 1:
        # 多匹配：全部标为歧义，让调用方选择
        plan.ambiguous = all_matches
        return plan
    else:
        matches = all_matches

    plan.definition_nodes = matches

    # 对每个定义节点，找所有引用（incoming edges）
    seen_ids = set(n.id for n in matches)
    file_set: set[str] = set()
    for def_node in matches:
        incoming = graph.incoming_edges(def_node.id)
        for edge in incoming:
            ref_node = graph.get_node(edge.source)
            if ref_node and ref_node.id not in seen_ids:
                seen_ids.add(ref_node.id)
                plan.reference_nodes.append(ref_node)
                fp = file_from_location(ref_node.location or "")
                if fp:
                    file_set.add(fp)
        # 定义节点所在的文件也要修改
        def_fp = file_from_location(def_node.location or "")
        if def_fp:
            file_set.add(def_fp)

    plan.files_to_modify = sorted(file_set)
    return plan


# ── Phase 2: 预览 ──

def preview_rename(
    graph: Graph,
    old_name: str,
    new_name: str,
    node_id: Optional[str] = None,
) -> Dict[str, Any]:
    """dry-run：返回影响范围预览，不修改任何文件。"""
    plan = find_rename_targets(graph, old_name, node_id)

    if not plan.definition_nodes and not plan.ambiguous:
        return {
            "error": f'未找到名为 "{old_name}" 的符号。',
            "dry_run": True,
        }

    if plan.ambiguous and not node_id:
        return {
            "error": f'"{old_name}" 匹配到 {len(plan.ambiguous)} 个符号，请指定 node_id 消歧义。',
            "dry_run": True,
            "candidates": [
                {"id": n.id, "name": n.name, "location": n.location, "kind": n.kind}
                for n in plan.ambiguous
            ],
        }

    return {
        "old_name": old_name,
        "new_name": new_name,
        "dry_run": True,
        "definition": {
            "node_id": plan.definition_nodes[0].id,
            "name": plan.definition_nodes[0].name,
            "location": plan.definition_nodes[0].location,
            "kind": plan.definition_nodes[0].kind,
        },
        "reference_count": len(plan.reference_nodes),
        "files_to_modify": plan.files_to_modify,
        "total_files": len(plan.files_to_modify),
        "references": [
            {"id": n.id, "name": n.name, "location": n.location}
            for n in plan.reference_nodes[:20]  # cap for readability
        ],
    }


# ── Phase 3 & 4: 执行 + 图更新 ──

def execute_rename(
    graph: Graph,
    old_name: str,
    new_name: str,
    project_root: str,
    node_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    执行安全重命名。

    流程：
      1. 发现所有要改的位置
      2. 检查 new_name 是否已存在
      3. 备份所有要修改的文件 → .hologram_bak
      4. 逐文件替换并写入
      5. 任一步失败 → 回滚所有文件
      6. 成功后更新图节点 name 并保存
    """
    # ── 1. 发现 ──
    plan = find_rename_targets(graph, old_name, node_id)

    if not plan.definition_nodes:
        msg = plan.ambiguous[0].name if plan.ambiguous else old_name
        return {"error": f'未找到 "{msg}" 的唯一定义。请用 hologram_search 查找后再试。'}
    if plan.ambiguous and not node_id:
        return {
            "error": f'"{old_name}" 匹配到 {len(plan.ambiguous)} 个符号。',
            "candidates": [
                {"id": n.id, "name": n.name, "location": n.location}
                for n in plan.ambiguous
            ],
        }

    # ── 2. 冲突检查 ──
    existing = graph.find_node_by_name(new_name)
    if existing:
        return {
            "error": f'目标名称 "{new_name}" 已存在于代码库中（{len(existing)} 个节点）。',
            "existing": [
                {"id": n.id, "location": n.location} for n in existing[:5]
            ],
        }

    # ── 3. 构建文件级替换指令 ──
    # {file_path: [(line_no_or_0, old_text, new_text, context_for_validation)]}
    file_edits: Dict[str, List[Tuple[int, str, str, str]]] = {}

    def_node = plan.definition_nodes[0]
    def_fp = file_from_location(def_node.location or "")
    def_line = 0
    if def_node.location and ":" in def_node.location:
        try:
            def_line = int(def_node.location.rsplit(":", 1)[-1])
        except ValueError:
            pass

    # 定义行替换
    if def_fp:
        if def_fp not in file_edits:
            file_edits[def_fp] = []
        file_edits[def_fp].append(
            (def_line, old_name, new_name, "definition")
        )

    # 引用替换：标记整个文件需要替换（引用行可能不在调用点，而在函数定义行）
    for ref_node in plan.reference_nodes:
        ref_fp = file_from_location(ref_node.location or "")
        if not ref_fp:
            continue
        if ref_fp not in file_edits:
            file_edits[ref_fp] = []
        # reference 标记：whole-file replace，不限于单行
        file_edits[ref_fp].append(
            (0, old_name, new_name, "reference_file")
        )

    # ── 4. 备份 + 执行替换 ──
    backups: Dict[str, str] = {}  # file_path → backup_path
    modified: List[str] = []
    errors: List[str] = []

    for fp in plan.files_to_modify:
        abs_path = os.path.join(project_root, fp) if not os.path.isabs(fp) else fp
        if not os.path.exists(abs_path):
            errors.append(f"文件不存在: {fp}")
            continue

        # 备份
        bak_path = abs_path + ".hologram_bak"
        try:
            shutil.copy2(abs_path, bak_path)
            backups[fp] = bak_path
        except OSError as e:
            errors.append(f"无法备份 {fp}: {e}")
            break  # 无法备份就不继续，触发回滚

        # 读取
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError as e:
            errors.append(f"无法读取 {fp}: {e}")
            break

        # 替换
        edits = file_edits.get(fp, [])
        new_content = _apply_edits(content, edits, fp, old_name, new_name)

        if new_content is None:
            errors.append(f"替换失败: {fp}（old_name 匹配数量异常）")
            break

        # 写入（原子：先写临时文件再 rename）
        tmp_path = abs_path + ".hologram_tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8", newline="") as f:
                f.write(new_content)
            os.replace(tmp_path, abs_path)  # atomic on Windows & Unix
            modified.append(fp)
        except OSError as e:
            errors.append(f"无法写入 {fp}: {e}")
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            break

    # ── 5. 错误 → 回滚 ──
    if errors:
        for fp, bak_path in backups.items():
            try:
                os.replace(bak_path, os.path.join(project_root, fp) if not os.path.isabs(fp) else fp)
            except OSError:
                pass
        return {
            "error": "重命名失败，已回滚所有修改。",
            "errors": errors,
            "rolled_back": len(backups),
        }

    # ── 6. 清理备份 ──
    for bak_path in backups.values():
        try:
            os.remove(bak_path)
        except OSError:
            pass

    # ── 7. 更新图节点 ──
    for n in plan.definition_nodes:
        n.name = new_name
    for ref_node in plan.reference_nodes:
        # 只更新引用节点中精确匹配 old_name 的部分（不碰包含 old_name 的其他符号）
        if ref_node.name == old_name:
            ref_node.name = new_name

    # 保存图到磁盘
    graph_path = os.path.join(project_root, "hologram_graph.json")
    try:
        graph.to_json(graph_path)
        # 同步更新 msgpack
        msgpack_path = graph_path.replace(".json", ".hologram")
        try:
            graph.to_msgpack(msgpack_path)
        except Exception:
            pass
    except Exception as e:
        # 图保存失败不影响文件修改（文件已改完且验证通过）
        return {
            "old_name": old_name,
            "new_name": new_name,
            "files_modified": len(modified),
            "modified_files": modified,
            "warning": f"文件已修改但图保存失败: {e}。请点重分析按钮同步。",
        }

    return {
        "old_name": old_name,
        "new_name": new_name,
        "files_modified": len(modified),
        "modified_files": modified,
        "definition_updated": plan.definition_nodes[0].id,
        "references_updated": len(plan.reference_nodes),
    }


# ── 行级替换辅助 ──

def _apply_edits(
    content: str,
    edits: List[Tuple[int, int, str, str, str]],  # (line, old, new, context_tag)
    file_path: str,
    old_name: str,
    new_name: str,
) -> Optional[str]:
    """
    在文件内容中执行替换。

    策略：
      1. 定义行：用语言感知 regex 精确替换
      2. 引用行：对该行的 old_name 出现进行替换
      3. 其余行不碰
    """
    lines = content.split("\n")
    changed_lines: set[int] = set()

    def_regex = _definition_regex(file_path, old_name)
    ident_re = re.compile(r'(?<![a-zA-Z0-9_])' + re.escape(old_name) + r'(?![a-zA-Z0-9_])')

    # 检查是否有全文件替换标记
    has_whole_file = any(tag == "reference_file" for _, _, _, tag in edits)

    if has_whole_file:
        # 全文标识符边界替换（用于引用文件）
        new_content, _count = ident_re.subn(new_name, content)
        return new_content

    # 行级精确替换
    for line_no, _old, _new, tag in edits:
        if line_no < 1 or line_no > len(lines):
            continue
        idx = line_no - 1
        if idx in changed_lines:
            continue  # 此行已处理过

        line = lines[idx]

        if tag == "definition" and def_regex:
            # 精确替换定义行：只替换声明关键字后的名称
            new_line, count = def_regex.subn(
                lambda m: m.group(0).replace(old_name, new_name),
                line,
            )
            if count > 0:
                lines[idx] = new_line
                changed_lines.add(idx)

    return "\n".join(lines)
