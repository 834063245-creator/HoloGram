#!/usr/bin/env python3
"""SCIP 桥接精度对比（P1-1）：同一份 gold 上对比 tree-sitter vs SCIP 桥接边。

用法:
  SCIP_TYPESCRIPT_BIN=/path/to/scip-typescript \\
    python3 scripts/bench_scip_bridge.py --fixture engine/fixtures/gap_probe_ts \\
      --gold engine/fixtures/gap_probe_ts/gold_expected.json

流程:
  1) scip-typescript index 产出 index.scip（临时目录）
  2) 引擎 analyze_project（绝对路径）→ 记录 tree-sitter 边
  3) 引擎 import_scip 导入 → 合并库
  4) 对 gold positive 逐条比对: tree-sitter 边 / scip 边 / 合并边的 recall
     负数边(negative)在合并库中不得出现
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))


def find_engine_binary(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(explicit)
    env = os.environ.get("HOLOGRAM_ENGINE")
    if env:
        return os.path.abspath(env)
    # debug 与 release 并存时取较新的 —— release 可能落后于当前源码
    #（SCIP 桥接等新工具未构建进旧 release）。
    cands = []
    for cand in ("engine/target/release/hologram-engine", "engine/target/debug/hologram-engine"):
        p = os.path.join(REPO_ROOT, cand)
        if os.path.exists(p):
            cands.append((os.path.getmtime(p), p))
    if cands:
        cands.sort(reverse=True)
        return cands[0][1]
    sys.exit("找不到引擎二进制，请用 --engine 指定")


def find_scip_bin(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(explicit)
    env = os.environ.get("SCIP_TYPESCRIPT_BIN")
    if env:
        return os.path.abspath(env)
    p = shutil.which("scip-typescript")
    if p:
        return p
    sys.exit("找不到 scip-typescript：请用 SCIP_TYPESCRIPT_BIN 指定或加入 PATH")


def run(cmd: list[str], cwd: str | None = None, timeout: int = 900):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)


def load_edges(db_path: str) -> list[tuple[str, str, str, str]]:
    con = sqlite3.connect(db_path)
    rows = list(con.execute("select source, target, kind, coalesce(metadata, '') from edges"))
    con.close()
    return [(r[0], r[1], r[2], r[3]) for r in rows]


def matches(gold_path: str, actual_id: str) -> bool:
    if gold_path.startswith("ext:"):
        return gold_path[4:] in actual_id
    return actual_id.endswith("." + gold_path) or actual_id == gold_path


def recall_of(gold_entries: list[dict], edges: list[tuple]) -> tuple[int, int, list]:
    hit = 0
    missed = []
    for p in gold_entries:
        ok = any(
            e[2] == p["kind"] and matches(p["src"], e[0]) and matches(p["tgt"], e[1])
            for e in edges
        )
        if ok:
            hit += 1
        else:
            missed.append(p)
    return hit, len(gold_entries), missed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=None)
    ap.add_argument("--fixture", required=True)
    ap.add_argument("--gold", required=True)
    ap.add_argument("--scip-bin", default=None, help="scip-typescript 可执行文件路径")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    binary = find_engine_binary(args.engine)
    scip_bin = find_scip_bin(args.scip_bin)
    fixture = os.path.abspath(args.fixture)
    gold = json.load(open(args.gold, encoding="utf-8"))

    tmp = tempfile.mkdtemp(prefix="scip_bench_")
    scip_path = os.path.join(tmp, "index.scip")

    # 1) 生成 index.scip
    r = run([scip_bin, "index", "--output", scip_path], cwd=fixture)
    if r.returncode != 0:
        sys.exit(f"scip-typescript index 失败:\n{r.stderr[-2000:]}")

    # 2) 干净 analyze（绝对路径）→ tree-sitter 基线
    hologram = os.path.join(fixture, ".hologram")
    if os.path.exists(hologram):
        shutil.rmtree(hologram)
    run([binary, "run", "analyze_project", fixture], timeout=900)
    ts_edges = load_edges(os.path.join(hologram, "hologram.db"))

    # 3) import_scip → 合并
    r = run([binary, "run", "import_scip", fixture, "--path", scip_path], timeout=900)
    merged = load_edges(os.path.join(hologram, "hologram.db"))
    scip_edges = [e for e in merged if "scip" in e[3]]

    # 4) 对比
    positives = gold.get("positive", [])
    by_kind: dict[str, list] = {}
    for p in positives:
        by_kind.setdefault(p["kind"], []).append(p)
    rows = []
    for kind, entries in sorted(by_kind.items()):
        t = recall_of(entries, ts_edges)
        s = recall_of(entries, scip_edges)
        m = recall_of(entries, merged)
        rows.append({
            "kind": kind,
            "gold": t[1],
            "tree_sitter_recall": t[0],
            "scip_recall": s[0],
            "merged_recall": m[0],
        })
    negatives = gold.get("negative", [])
    neg_hits = [
        n for n in negatives
        if any(
            e[2] == n["kind"] and matches(n["src"], e[0]) and matches(n["tgt"], e[1])
            for e in merged
        )
    ]
    out = {
        "engine_binary": binary,
        "scip_binary": scip_bin,
        "fixture": gold.get("fixture", os.path.basename(fixture)),
        "ts_edges": len(ts_edges),
        "scip_edges": len(scip_edges),
        "merged_edges": len(merged),
        "per_kind": rows,
        "negative_hits_in_merged": len(neg_hits),
        "negative_hit_details": neg_hits,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
