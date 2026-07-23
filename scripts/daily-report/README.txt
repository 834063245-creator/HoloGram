# 每日进度报告 — 从 Git 历史自动生成

一条命令，把今天的 commit 变成比赛/日报需要的 Markdown 格式。

## 依赖

- [Fish shell](https://fishshell.com/) — Linux/macOS 默认包管理器都有，不需要额外装
- 没有其他依赖——只用了 `git log` 和 Fish 内置命令

## 安装

```bash
chmod +x scripts/daily-report/daily.fish
```

## 使用

```bash
# 今天的报告
fish scripts/daily-report/daily.fish

# 指定某一天
fish scripts/daily-report/daily.fish 2026-07-22

# 导出到文件
fish scripts/daily-report/daily.fish > 进度报告-$(date -I).md
```

## 输出示例

```
# 每日进度报告 — 2026-07-22

| 类型 | 数量 |
|------|------|
| 🚀 新功能 | 4 |
| 🐛 修复 | 6 |
| ...
```

直接贴到比赛平台就行。

## 工作原理

通过 `git log` 按日期过滤 commit，按 Conventional Commits 前缀自动分类并配上 emoji。`git-cliff` 仓库本身不需要——脚本直接读 git 历史的。

## 注意事项

- Commit 信息需要遵循 Conventional Commits 格式（`feat:` / `fix:` / `refactor:` 等），否则会被归到「其他」
- Merge commit 也会被计入，建议日常开发用 rebase 或以 squash merge 保持报告干净
