#!/usr/bin/env python3
"""HoloGram 解析基准（P1-3）：gold fixture vs 引擎实际入库边。

用法:
  python3 scripts/bench_resolution.py --fixture engine/fixtures/gap_probe --gold engine/fixtures/gap_probe/gold_expected.json
  python3 scripts/bench_resolution.py --fixture engine/fixtures/gap_probe_ts --gold engine/fixtures/gap_probe_ts/gold_expected.json
  python3 scripts/bench_resolution.py --fixture engine/fixtures/gap_probe_rs --gold engine/fixtures/gap_probe_rs/gold_expected.json
  python3 scripts/bench_resolution.py --all   # 三个 fixture 全跑

匹配规则:
  gold 里的 src/tgt 是点分后缀；入库边的节点 id 形如
  ".home.user.HoloGram.engine.fixtures.gap_probe.app.controllers.user_ctl.py"，
  以 "." + gold 路径结尾即命中。external 条目用包含匹配（tgt 名出现在目标 id 中）。
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))


def find_engine_binary(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(explicit)
    env = os.environ.get("HOLOGRAM_ENGINE")
    if env:
        return os.path.abspath(env)
    for cand in ("engine/target/release/hologram-engine", "engine/target/debug/hologram-engine"):
        p = os.path.join(REPO_ROOT, cand)
        if os.path.exists(p):
            return p
    sys.exit("找不到引擎二进制，请用 --engine 指定")


def run_analyze(binary: str, fixture: str) -> list[str]:
    r = subprocess.run(
        [binary, "run", "analyze_project", fixture],
        capture_output=True, text=True, timeout=900,
    )
    diag = [
        line for line in r.stderr.splitlines()
        if "cross-file diag" in line or "分析完成" in line or "persist+swap" in line
    ]
    return diag


def load_edges(db_path: str) -> list[tuple[str, str, str]]:
    con = sqlite3.connect(db_path)
    rows = list(con.execute("select source, target, kind from edges"))
    con.close()
    return [(r[0], r[1], r[2]) for r in rows]


def matches(gold_path: str, actual_id: str) -> bool:
    if gold_path.startswith("ext:"):
        name = gold_path[4:]
        return name in actual_id
    return actual_id.endswith("." + gold_path) or actual_id == gold_path


def find_hits(entry: dict, edges: list[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    src, tgt, kind = entry["src"], entry["tgt"], entry["kind"]
    external = entry.get("external", False)
    out = []
    for e in edges:
        if e[2] != kind:
            continue
        if not matches(src, e[0]):
            continue
        if external:
            # 外部依赖：目标名包含匹配（ext:leftpad 或 node_modules/leftpad/…）
            if tgt in e[1]:
                out.append(e)
        elif matches(tgt, e[1]):
            out.append(e)
    return out


def bench_one(binary: str, fixture: str, gold_path: str, skip_analyze: bool) -> dict:
    gold = json.load(open(gold_path, encoding="utf-8"))
    positives = gold.get("positive", [])
    positives_p03 = gold.get("positive_p03", [])
    negatives = gold.get("negative", [])

    fixture_abs = os.path.abspath(fixture)
    diag = [] if skip_analyze else run_analyze(binary, fixture_abs)
    db = os.path.join(fixture_abs, ".hologram", "hologram.db")
    edges = load_edges(db)

    tp = tp3 = 0
    missed, count_warns, false_pos = [], [], []
    for p in positives:
        hits = find_hits(p, edges)
        if hits:
            tp += 1
        else:
            missed.append(p)
        if "count" in p and len(hits) != p["count"]:
            count_warns.append({**p, "actual_count": len(hits)})
    for p in positives_p03:
        hits = find_hits(p, edges)
        if hits:
            tp3 += 1
        else:
            missed.append({**p, "tier": "p03"})
    for n in negatives:
        hits = find_hits(n, edges)
        if hits:
            false_pos.append({**n, "actual": [f"{h[0]} -> {h[1]}" for h in hits[:3]]})

    n_pos = len(positives)
    n_p03 = len(positives_p03)
    recall = tp / n_pos if n_pos else 1.0
    recall_p03 = tp3 / n_p03 if n_p03 else 1.0
    precision = tp / (tp + len(false_pos)) if (tp + len(false_pos)) else 1.0

    return {
        "fixture": gold.get("fixture", os.path.basename(fixture)),
        "gold_positive": n_pos,
        "gold_positive_p03": n_p03,
        "gold_negative": len(negatives),
        "tp": tp,
        "tp_p03": tp3,
        "false_positive": len(false_pos),
        "recall_p0": round(recall, 4),
        "recall_p03": round(recall_p03, 4),
        "precision": round(precision, 4),
        "missed": missed,
        "count_warnings": count_warns,
        "false_positive_details": false_pos,
        "engine_diag": diag,
        "db_edges": len(edges),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=None)
    ap.add_argument("--fixture", default=None)
    ap.add_argument("--gold", default=None)
    ap.add_argument("--all", action="store_true", help="跑全部三个内置 fixture")
    ap.add_argument("--skip-analyze", action="store_true", help="不重跑分析，直接读已有 hologram.db")
    ap.add_argument("--out", default=None, help="结果 JSON 输出路径")
    args = ap.parse_args()

    binary = find_engine_binary(args.engine)

    runs = []
    if args.all or (args.fixture and args.gold):
        if args.fixture and args.gold:
            runs.append((args.fixture, args.gold))
        if args.all:
            for name in ("gap_probe", "gap_probe_ts", "gap_probe_rs"):
                runs.append((
                    os.path.join(REPO_ROOT, "engine", "fixtures", name),
                    os.path.join(REPO_ROOT, "engine", "fixtures", name, "gold_expected.json"),
                ))
    else:
        ap.error("需要 --fixture + --gold，或 --all")

    results = [bench_one(binary, f, g, args.skip_analyze) for f, g in runs]

    out = {
        "engine_binary": binary,
        "results": results,
        "summary": {
            "p0_recall": round(sum(r["tp"] for r in results) / max(1, sum(r["gold_positive"] for r in results)), 4),
            "p03_recall": round(sum(r["tp_p03"] for r in results) / max(1, sum(r["gold_positive_p03"] for r in results)), 4),
            "precision": round(
                sum(r["tp"] for r in results)
                / max(1, sum(r["tp"] for r in results) + sum(r["false_positive"] for r in results)),
                4,
            ),
        },
    }

    print(json.dumps(out, ensure_ascii=False, indent=2))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"[bench] 结果已写入 {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
