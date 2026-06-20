# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 V2 因果审计时间线 (Causal Audit Timeline)。"""

import os
import json
import pytest
import tempfile
import datetime

from src_python.timeline import (
    TimelineStore, TimelineEvent, EventType, init_timeline,
)


class TestTimelineEvent:
    """测试时间轴事件数据模型。"""

    def test_create_event(self):
        e = TimelineEvent(
            timestamp="2026-06-08T14:02:33",
            event_type="file_changed",
            file="task_scheduler.py",
            changed_by="git commit a1b2c3d",
            summary="Changed schedule_next_run priority",
        )
        d = e.to_dict()
        assert d["event_type"] == "file_changed"
        assert d["file"] == "task_scheduler.py"

    def test_event_with_nodes(self):
        e = TimelineEvent(
            timestamp="2026-06-08T14:02:33",
            event_type="data_file_changed",
            file="scheduler_state.json",
            related_nodes=["task_scheduler.SchedulerEngine"],
            data_file_diff={"key": "last_scheduled_run", "old": 100, "new": 200},
        )
        d = e.to_dict()
        assert "task_scheduler.SchedulerEngine" in d["related_nodes"]
        assert d["data_file_diff"]["key"] == "last_scheduled_run"


class TestTimelineStore:
    """测试 SQLite 时间轴存储。"""

    @pytest.fixture
    def store(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ts = TimelineStore(tmpdir)
            yield ts
            ts.close()

    def test_record_file_change(self, store):
        event_id = store.record_file_change("test.py")
        assert event_id > 0

    def test_record_data_file_change(self, store):
        event_id = store.record_data_file_change(
            "config.json",
            old_mtime=1000.0,
            new_mtime=2000.0,
        )
        assert event_id > 0

    def test_record_commit(self, store):
        event_id = store.record_commit(
            "a1b2c3d4e5f6",
            message="Fix race condition in scheduler",
            files=["task_scheduler.py", "cache_store.py"],
        )
        assert event_id > 0

    def test_record_boundary(self, store):
        event_id = store.record_boundary(
            "bnd_0001", "L4_encapsulation_violation",
            files=["data_sync.py"],
        )
        assert event_id > 0

    def test_record_user_action(self, store):
        event_id = store.record_user_action("确认边界", "L4 穿透已确认为技术债务")
        assert event_id > 0

    def test_query_with_limit(self, store):
        for i in range(5):
            store.record(EventType.FILE_CHANGED.value,
                         file=f"file_{i}.py", summary=f"Change {i}")
        events = store.query(limit=3)
        assert len(events) == 3

    def test_query_filter_by_type(self, store):
        store.record_file_change("a.py")
        store.record_file_change("b.py")
        store.record_commit("abc123", "fix bug")

        events = store.query(event_type="commit")
        assert len(events) == 1
        assert events[0]["event_type"] == "commit"

    def test_query_filter_since(self, store):
        store.record_file_change("old.py")
        import time
        time.sleep(0.01)
        since = datetime.datetime.now().isoformat()
        time.sleep(0.01)
        store.record_file_change("new.py")

        events = store.query(since=since)
        assert len(events) == 1
        assert events[0]["file"] == "new.py"

    def test_stats(self, store):
        store.record_file_change("a.py")
        store.record_commit("abc", "test")
        store.record_user_action("confirm")

        stats = store.stats()
        assert stats["total_events"] == 3
        assert "file_changed" in stats["by_type"]
        assert stats["latest_event"] is not None

    def test_file_snapshot(self, store):
        # Write a file
        test_file = os.path.join(store.project_root, "data.json")
        with open(test_file, "w") as f:
            json.dump({"key": "value"}, f)

        h1 = store.snapshot_file(test_file)
        assert h1 is not None
        assert len(h1) == 16

        # Modify
        with open(test_file, "w") as f:
            json.dump({"key": "changed"}, f)

        h2 = store.snapshot_file(test_file)
        assert h2 is not None
        assert h2 != h1  # hash changed

        # Retrieve snapshot
        snap = store.get_snapshot(test_file)
        assert snap is not None
        assert snap["hash"] == h2

        # Cleanup
        os.unlink(test_file)

    def test_check_data_file_changes(self, store):
        import time
        test_file = os.path.join(store.project_root, "runtime.json")
        with open(test_file, "w") as f:
            json.dump({"x": 1}, f)
        store.snapshot_file(test_file)
        time.sleep(0.02)  # 确保 mtime 有可检测的差异

        # Modify
        with open(test_file, "w") as f:
            json.dump({"x": 2}, f)

        changes = store.check_data_file_changes(["runtime.json"])
        assert len(changes) >= 1
        assert changes[0]["file"] == test_file

        os.unlink(test_file)

    def test_persistence_across_instances(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store1 = TimelineStore(tmpdir)
            store1.record_file_change("persist.py")
            store1.close()

            store2 = TimelineStore(tmpdir)
            events = store2.query(limit=10)
            assert len(events) == 1
            assert events[0]["file"] == "persist.py"
            store2.close()

    def test_init_timeline_helper(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ts = init_timeline(tmpdir)
            assert isinstance(ts, TimelineStore)
            assert os.path.exists(os.path.join(tmpdir, ".hologram", "timeline.db"))
            ts.close()
