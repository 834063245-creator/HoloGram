"""
因果审计时间线 (Causal Audit Timeline) — SPEC V2 §5

自动记录，不自动推断。

监测：
  - 代码文件变更（已有：watchdog）
  - 共享数据文件变更（新增：*.json / *.db / *.sqlite 的 mtime 变更）
  - git commit 事件

每条事件记录格式：
  {
    timestamp: "2026-06-08 14:02:33",
    event_type: "file_changed" | "data_file_changed" | "commit",
    file: "task_scheduler.py",
    changed_by: "git commit a1b2c3d" | "runtime_write",
    related_nodes: ["task_scheduler.SchedulerEngine.schedule_next_run"],
    data_file_diff: null | {key: "last_scheduled_run", old: ..., new: ...}
  }

关键设计约束：
  ✗ 不自动推断因果关系
  ✗ 不声称"找到了 bug 的根源"
  ✓ 记录所有共享数据文件的读写时间戳
  ✓ 在时间轴上对齐代码变更、数据变更、用户操作
  ✓ 高亮共享热点（被多个线程读写的文件）
  ✓ 展示时序，让人类自己判断因果关系
"""

from __future__ import annotations

import datetime
import json
import os
import sqlite3
import hashlib
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


# ============================================================
# 事件类型
# ============================================================

class EventType(str, Enum):
    FILE_CHANGED = "file_changed"            # 代码文件变更
    DATA_FILE_CHANGED = "data_file_changed"  # 共享数据文件变更
    COMMIT = "commit"                         # git commit
    BLINDSPOT_DETECTED = "blindspot_detected" # 盲区/边界检测
    USER_ACTION = "user_action"              # 用户操作


# ============================================================
# 事件数据模型
# ============================================================

@dataclass
class TimelineEvent:
    """时间轴上的单个事件。"""
    id: Optional[int] = None
    timestamp: str = ""                      # ISO 格式
    event_type: str = "file_changed"
    file: str = ""
    changed_by: str = ""                     # "git commit abc" | "runtime_write"
    related_nodes: List[str] = field(default_factory=list)
    summary: str = ""
    data_file_diff: Optional[Dict[str, Any]] = None
    properties: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "event_type": self.event_type,
            "file": self.file,
            "changed_by": self.changed_by,
            "related_nodes": self.related_nodes,
            "summary": self.summary,
            "data_file_diff": self.data_file_diff,
            "properties": self.properties,
        }


# ============================================================
# SQLite 存储后端
# ============================================================

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    file TEXT DEFAULT '',
    changed_by TEXT DEFAULT '',
    related_nodes TEXT DEFAULT '[]',
    summary TEXT DEFAULT '',
    data_file_diff TEXT DEFAULT NULL,
    properties TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_file ON events(file);

CREATE TABLE IF NOT EXISTS file_snapshots (
    file_path TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    mtime REAL DEFAULT 0,
    size INTEGER DEFAULT 0,
    hash TEXT DEFAULT '',
    PRIMARY KEY (file_path, timestamp)
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


class TimelineStore:
    """持久化时间轴事件存储（SQLite）。"""

    DEFAULT_DIR = ".hologram"
    DEFAULT_DB = "timeline.db"

    def __init__(self, project_root: str):
        self.project_root = os.path.abspath(project_root)
        self.store_dir = os.path.join(self.project_root, self.DEFAULT_DIR)
        self.db_path = os.path.join(self.store_dir, self.DEFAULT_DB)
        os.makedirs(self.store_dir, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        try:
            self._init_db()
        except Exception:
            self._conn.close()
            raise

    def _init_db(self) -> None:
        with self._lock:
            self._conn.executescript(SCHEMA_SQL)
            self._conn.commit()

    # ── 写入 ──

    def record(
        self,
        event_type: str,
        file: str = "",
        changed_by: str = "",
        related_nodes: Optional[List[str]] = None,
        summary: str = "",
        data_file_diff: Optional[Dict[str, Any]] = None,
        properties: Optional[Dict[str, Any]] = None,
    ) -> int:
        """记录一条事件到时间轴。返回事件 ID。"""
        now = datetime.datetime.now().isoformat()
        with self._lock:
            self._conn.execute(
            """INSERT INTO events (timestamp, event_type, file, changed_by,
               related_nodes, summary, data_file_diff, properties)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                now,
                event_type,
                file,
                changed_by,
                json.dumps(related_nodes or [], ensure_ascii=False),
                summary,
                json.dumps(data_file_diff, ensure_ascii=False) if data_file_diff else None,
                json.dumps(properties or {}, ensure_ascii=False),
            ),
        )
        self._conn.commit()
        cursor = self._conn.execute("SELECT last_insert_rowid()")
        return cursor.fetchone()[0]

    def record_file_change(self, file_path: str, changed_by: str = "watchdog") -> int:
        """记录文件变更事件。"""
        return self.record(
            event_type=EventType.FILE_CHANGED.value,
            file=file_path,
            changed_by=changed_by,
            summary=f"文件变更: {os.path.basename(file_path)}",
        )

    def record_data_file_change(
        self,
        file_path: str,
        old_mtime: Optional[float] = None,
        new_mtime: Optional[float] = None,
        old_size: Optional[int] = None,
        new_size: Optional[int] = None,
    ) -> int:
        """记录数据文件变更事件。"""
        diff = {
            "file": file_path,
            "old_mtime": old_mtime,
            "new_mtime": new_mtime,
            "old_size": old_size,
            "new_size": new_size,
        }
        return self.record(
            event_type=EventType.DATA_FILE_CHANGED.value,
            file=file_path,
            changed_by="runtime_write",
            data_file_diff=diff,
            summary=f"数据文件变更: {os.path.basename(file_path)}",
        )

    def record_commit(self, commit_hash: str, message: str = "", files: Optional[List[str]] = None) -> int:
        """记录 git commit 事件。"""
        return self.record(
            event_type=EventType.COMMIT.value,
            changed_by=f"git commit {commit_hash[:8]}",
            related_nodes=files or [],
            summary=f"Commit: {message[:80]}" if message else f"Commit {commit_hash[:8]}",
            properties={"commit_hash": commit_hash, "message": message},
        )

    def record_boundary(self, boundary_id: str, boundary_type: str, files: Optional[List[str]] = None) -> int:
        """记录边界检测事件。"""
        return self.record(
            event_type=EventType.BLINDSPOT_DETECTED.value,
            related_nodes=files or [],
            summary=f"边界检测: {boundary_type} ({boundary_id})",
            properties={"boundary_id": boundary_id, "boundary_type": boundary_type},
        )

    def record_user_action(self, action: str, details: str = "") -> int:
        """记录用户操作事件。"""
        return self.record(
            event_type=EventType.USER_ACTION.value,
            summary=f"用户: {action}",
            properties={"action": action, "details": details},
        )

    # ── 查询 ──

    def query(
        self,
        limit: int = 100,
        since: Optional[str] = None,
        event_type: Optional[str] = None,
        file: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """查询时间轴事件。"""
        sql = "SELECT * FROM events WHERE 1=1"
        params: List[Any] = []

        if since:
            sql += " AND timestamp >= ?"
            params.append(since)
        if event_type:
            sql += " AND event_type = ?"
            params.append(event_type)
        if file:
            sql += " AND file = ?"
            params.append(file)

        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        events = []
        for row in rows:
            events.append(TimelineEvent(
                id=row["id"],
                timestamp=row["timestamp"],
                event_type=row["event_type"],
                file=row["file"],
                changed_by=row["changed_by"],
                related_nodes=json.loads(row["related_nodes"] or "[]"),
                summary=row["summary"],
                data_file_diff=json.loads(row["data_file_diff"]) if row["data_file_diff"] else None,
                properties=json.loads(row["properties"] or "{}"),
            ).to_dict())
        return events

    def stats(self) -> Dict[str, Any]:
        """返回时间轴统计。"""
        with self._lock:
            total = self._conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            by_type = {}
            for row in self._conn.execute(
                "SELECT event_type, COUNT(*) as cnt FROM events GROUP BY event_type"
            ).fetchall():
                by_type[row["event_type"]] = row["cnt"]

            latest = self._conn.execute(
            "SELECT timestamp, event_type, summary FROM events ORDER BY timestamp DESC LIMIT 1"
        ).fetchone()

        return {
            "total_events": total,
            "by_type": by_type,
            "latest_event": {
                "timestamp": latest["timestamp"],
                "event_type": latest["event_type"],
                "summary": latest["summary"],
            } if latest else None,
            "db_path": self.db_path,
        }

    # ── 文件快照 ──

    def snapshot_file(self, file_path: str) -> Optional[str]:
        """记录文件快照（用于数据文件变更检测）。返回文件哈希。"""
        try:
            stat = os.stat(file_path)
            with open(file_path, "rb") as f:
                content_hash = hashlib.sha256(f.read()).hexdigest()[:16]
        except OSError:
            return None

        now = datetime.datetime.now().isoformat()
        with self._lock:
            self._conn.execute(
                """INSERT OR REPLACE INTO file_snapshots (file_path, timestamp, mtime, size, hash)
                   VALUES (?, ?, ?, ?, ?)""",
                (file_path, now, stat.st_mtime, stat.st_size, content_hash),
            )
            self._conn.commit()
        return content_hash

    def get_snapshot(self, file_path: str) -> Optional[Dict[str, Any]]:
        """获取文件最近一次快照。"""
        with self._lock:
            row = self._conn.execute(
            "SELECT * FROM file_snapshots WHERE file_path = ? ORDER BY timestamp DESC LIMIT 1",
            (file_path,),
        ).fetchone()
        if row:
            return {
                "file_path": row["file_path"],
                "timestamp": row["timestamp"],
                "mtime": row["mtime"],
                "size": row["size"],
                "hash": row["hash"],
            }
        return None

    def check_data_file_changes(self, data_patterns: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """扫描项目目录，检测数据文件变更。

        Args:
            data_patterns: glob 模式列表（默认: *.json, *.db, *.sqlite）

        Returns:
            变更列表
        """
        if data_patterns is None:
            data_patterns = ["*.json", "*.db", "*.sqlite"]

        import glob as _glob
        changes = []
        for pattern in data_patterns:
            full_pattern = os.path.join(self.project_root, "**", pattern)
            for file_path in _glob.glob(full_pattern, recursive=True):
                try:
                    stat = os.stat(file_path)
                except OSError:
                    continue
                prev = self.get_snapshot(file_path)
                if prev and (abs(stat.st_mtime - prev["mtime"]) > 0.01 or stat.st_size != prev["size"]):
                    changes.append({
                        "file": file_path,
                        "old_mtime": prev["mtime"],
                        "new_mtime": stat.st_mtime,
                        "old_size": prev["size"],
                        "new_size": stat.st_size,
                    })
        return changes

    def close(self) -> None:
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False


# ============================================================
# 便捷函数
# ============================================================

def init_timeline(project_root: str) -> TimelineStore:
    """初始化项目的时间轴存储。"""
    return TimelineStore(project_root)
