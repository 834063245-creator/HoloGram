#!/usr/bin/env fish
# 每日进度报告 — 从 git commit 历史自动生成
# 用法: fish daily.fish            # 今天
#       fish daily.fish 2026-07-22 # 指定日期

set script_dir (dirname (realpath (status filename)))
set date_arg $argv[1]
if test -z "$date_arg"
    set date_arg (date -I)
end

set day_start (date -d "$date_arg 00:00:00" +%s 2>/dev/null)
set day_end   (date -d "$date_arg 23:59:59" +%s 2>/dev/null)
set output_file "$script_dir/report-$date_arg.md"

# 获取这一天的所有 commit（从旧到新）
set -l raw (git log --reverse --after="@$day_start" --before="@$day_end" --format="%s" 2>&1)

if test -z "$raw"
    echo "# 每日进度报告 — $date_arg" > $output_file
    echo "" >> $output_file
    echo "> 本日暂无 commit。" >> $output_file
    echo "报告已保存至: $output_file"
    exit 0
end

set all_commits (string split '\n' -- $raw)
set total (count $all_commits)
set feat_count 0; set fix_count 0; set refactor_count 0; set chore_count 0; set other_count 0

for msg in $all_commits
    if string match -rq "^feat[(:]" -- $msg
        set feat_count (math $feat_count + 1)
    else if string match -rq "^fix[(:]" -- $msg
        set fix_count (math $fix_count + 1)
    else if string match -rq "^refactor[(:]" -- $msg
        set refactor_count (math $refactor_count + 1)
    else if string match -rq "^chore[(:]" -- $msg
        set chore_count (math $chore_count + 1)
    else
        set other_count (math $other_count + 1)
    end
end

# 写入报告文件
echo "# 每日进度报告 — $date_arg" > $output_file
echo "" >> $output_file
echo "| 类型 | 数量 |" >> $output_file
echo "|------|------|" >> $output_file
echo "| 🚀 新功能 | $feat_count |" >> $output_file
echo "| 🐛 修复 | $fix_count |" >> $output_file
echo "| 🛠️ 重构 | $refactor_count |" >> $output_file
echo "| 🔧 杂项 | $chore_count |" >> $output_file
echo "| 📦 其他 | $other_count |" >> $output_file
echo "| **合计** | **$total** |" >> $output_file
echo "" >> $output_file
echo "## 详细变更" >> $output_file
echo "" >> $output_file

for msg in $all_commits
    if string match -rq "^feat[(:]" -- $msg
        set emoji "🚀"
    else if string match -rq "^fix[(:]" -- $msg
        set emoji "🐛"
    else if string match -rq "^refactor[(:]" -- $msg
        set emoji "🛠️"
    else if string match -rq "^perf[(:]" -- $msg
        set emoji "⚡"
    else if string match -rq "^docs[(:]" -- $msg
        set emoji "📝"
    else if string match -rq "^test[(:]" -- $msg
        set emoji "✅"
    else if string match -rq "^chore[(:]" -- $msg
        set emoji "🔧"
    else if string match -rq "^revert[(:]" -- $msg
        set emoji "⏪"
    else
        set emoji "📦"
    end

    echo "- $emoji $msg" >> $output_file
end

echo "" >> $output_file
echo "---" >> $output_file
echo "*由 daily.fish 自动生成，发布于 $date_arg*" >> $output_file
echo "报告已保存至: $output_file"
