#!/usr/bin/env python3
"""排程冲突校验：检查计划是否违反固定占用、负荷上限、截止前置等硬约束。

用法:
    python check_plan.py plan.json          # 校验并输出冲突报告
    python check_plan.py --demo             # 用内置示例跑一遍

plan.json 结构:
{
  "preferences": {"daily_limit_min": 240, "buffer_min": 15, "day_start": "08:00", "day_end": "23:30"},
  "days": [
    {"date": "2026-10-28", "blocks": [
      {"title": "数据结构", "kind": "fixed", "start": "08:00", "end": "09:40"},
      {"title": "实验三", "kind": "task", "start": "19:00", "end": "22:00", "due": "2026-10-30 23:59", "priority": "P0"}
    ]}
  ]
}

kind 取值: fixed(不可移动) / task(可移动任务) / personal(个人安排) / break(休息缓冲)
"""

import json
import sys
from datetime import datetime, timedelta


def parse_hhmm(s):
    h, m = s.split(":")[:2]
    return int(h) * 60 + int(m)


def parse_dt(s):
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def minutes(a, b):
    return (b - a).total_seconds() / 60


def weeks_of(block):
    """取块的周次列表；没有周次信息时返回 None（表示"每周都上"）。"""
    raw = block.get("week_list")
    if isinstance(raw, list) and raw:
        weeks = set()
        for item in raw:
            try:
                weeks.add(int(item))
            except (TypeError, ValueError):
                continue
        return weeks or None
    return None


def weeks_overlap(a, b):
    """两块的周次是否相交。任一方无周次信息时保守判定为相交。"""
    wa, wb = weeks_of(a), weeks_of(b)
    if wa is None or wb is None:
        return True
    return bool(wa & wb)


def check(plan):
    prefs = plan.get("preferences", {})
    daily_limit = prefs.get("daily_limit_min", 240)
    buffer_min = prefs.get("buffer_min", 15)
    day_start = parse_hhmm(prefs.get("day_start", "08:00"))
    day_end = parse_hhmm(prefs.get("day_end", "23:30"))

    conflicts = []
    warnings = []
    summary = []

    for day in plan.get("days", []):
        date = day.get("date", "?")
        blocks = sorted(day.get("blocks", []), key=lambda b: parse_hhmm(b["start"]))
        load = 0

        for i, b in enumerate(blocks):
            s, e = parse_hhmm(b["start"]), parse_hhmm(b["end"])
            if e <= s:
                conflicts.append(f"{date} 「{b['title']}」结束时间不晚于开始时间")
            if s < day_start or e > day_end:
                warnings.append(
                    f"{date} 「{b['title']}」超出可用时段 {prefs.get('day_start','08:00')}-{prefs.get('day_end','23:30')}"
                )
            if b.get("kind") in ("task", "personal"):
                load += e - s

            # 重叠检测：只和时间上真压住、且周次相交的块算冲突。
            # 同一门课"4-13周 9-11节"与"第14周 9-10节"永远不会在同一周发生，不算冲突。
            for prev in blocks[:i]:
                pe = parse_hhmm(prev["end"])
                if s < pe and weeks_overlap(prev, b):
                    conflicts.append(
                        f"{date} 「{prev['title']}」与「{b['title']}」时间重叠（{prev['end']} / {b['start']}）"
                    )
                    break

            if i > 0:
                prev = blocks[i - 1]
                pe = parse_hhmm(prev["end"])
                if s >= pe and s - pe < buffer_min and b.get("kind") == "task" and prev.get("kind") == "task":
                    warnings.append(
                        f"{date} 「{prev['title']}」与「{b['title']}」之间缓冲仅 {s - pe} 分钟（建议 {buffer_min}）"
                    )

            # 截止前置：任务必须早于截止时间完成
            due = b.get("due")
            if due and b.get("kind") == "task":
                due_dt = parse_dt(due)
                end_dt = parse_dt(f"{date} {b['end']}")
                if due_dt and end_dt and end_dt > due_dt:
                    conflicts.append(
                        f"{date} 「{b['title']}」安排结束于 {b['end']}，晚于截止 {due}"
                    )
                elif due_dt and end_dt:
                    if minutes(end_dt, due_dt) < 60 * 6:
                        warnings.append(
                            f"{date} 「{b['title']}」距截止不足 6 小时，缺少安全余量（截止 {due}）"
                        )

        if load > daily_limit:
            conflicts.append(
                f"{date} 可移动负荷 {int(load)} 分钟，超过上限 {daily_limit} 分钟，需顺延 {int(load - daily_limit)} 分钟"
            )
        summary.append((date, int(load), len(blocks)))

    return conflicts, warnings, summary


def report(conflicts, warnings, summary):
    print("== 每日负荷 ==")
    for date, load, n in summary:
        print(f"  {date}: {load} 分钟 / {n} 个时间块")
    print()
    if conflicts:
        print(f"== 硬冲突 {len(conflicts)} 条（必须修正）==")
        for c in conflicts:
            print(f"  [X] {c}")
    else:
        print("== 硬冲突 0 条 ==")
    if warnings:
        print(f"\n== 提醒 {len(warnings)} 条（建议调整）==")
        for w in warnings:
            print(f"  [!] {w}")
    return 1 if conflicts else 0


DEMO = {
    "preferences": {"daily_limit_min": 240, "buffer_min": 15, "day_start": "08:00", "day_end": "23:30"},
    "days": [
        {
            "date": "2026-10-28",
            "blocks": [
                {"title": "数据结构", "kind": "fixed", "start": "08:00", "end": "09:40"},
                {"title": "大学物理", "kind": "fixed", "start": "10:00", "end": "11:40"},
                {"title": "实验三：最短路径", "kind": "task", "start": "19:00", "end": "22:00",
                 "due": "2026-10-30 23:59", "priority": "P0"},
                {"title": "打篮球", "kind": "personal", "start": "17:00", "end": "18:00"},
            ],
        },
        {
            "date": "2026-10-30",
            "blocks": [
                {"title": "课程论文初稿", "kind": "task", "start": "20:00", "end": "23:00",
                 "due": "2026-10-30 22:00", "priority": "P1"},
            ],
        },
    ],
}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == "--demo":
        plan = DEMO
    else:
        with open(sys.argv[1], encoding="utf-8") as f:
            plan = json.load(f)
    conflicts, warnings, summary = check(plan)
    sys.exit(report(conflicts, warnings, summary))


if __name__ == "__main__":
    main()
