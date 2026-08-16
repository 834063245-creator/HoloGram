# docs/research 索引

> 本目录只放**仍然有效的证据与决策**；已竣工的施工稿/历史设计在 `docs/archive/`。
> 每个文件一行：是什么、状态、给谁看。下划线开头 = 工作笔记，不看无妨。

## 主线（想了解「现在到哪了」先看这两份）

- **survival-position-verification-2026-08.md** — P0/P1 竞品防守清单主文档。**§0 是 TL;DR 状态总览**，§2.1 是逐条实测证据。已基本完工。
- **scip-bridge-tiering-decision-2026-08.md** — P1-1 决策：SCIP 语言分档表（T1 主力 / T2 兜底）+ 验收路径 + 实测数字。

## 竞品调研系列（survival 的证据底座，2026-08-15 采集）

- **competitor-landscape-full-2026-08.md** — 全量竞品地图（四十年技术史 + 巨头威胁模型），系列总结篇，其余各篇的细节来源。
- **code-graph-tools-gap-report.md** — 结构图谱/依赖图工具外部事实调研（dependency-cruiser / Sourcetrail / Kythe / Glean / stack-graphs 等）。
- code-intelligence-indexer-ecosystem-2026-08.md — SCIP/索引器生态一手调研（P1-1 分档依据）。
- engine-capability-audit-2026-08.md — 引擎内部能力审计。
- engine-gap-analysis-vs-established-tools-2026-08.md — 第一波 12 工具差距分析。
- external-deep-analysis-tools-baseline-2026-08.md — CodeQL/Semgrep/SonarQube/Snyk 基线。
- external-sast-giants-baseline-2026-08.md — Coverity/Fortify/Checkmarx/Joern/WALA/Soot/DOOP 等基线。
- architecture-governance-tools-baseline-2026-08.md — 架构治理商业老厂、可视化/度量工具、学术源头基线。

## 其他

- agent-context-injection.md — Agent 上下文注入设计。
- browser-cdp-vs-harness-web-comparison.md — 浏览器 CDP 套件与 harness Web 对比。
- _cdp-hologram-notes.md / _harness-web-notes.md — 工作笔记（下划线前缀）。
- benchmarks/ — 性能基准数据。
