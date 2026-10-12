# 渲染 / 纸面线（render-paper-line）— 已归档计划

> **已归档（2026-10-08 · 文档面收尾）**——本目录收「渲染与纸面」线的八份过程文档：代码均已落地，**余真机验收**。
> 判据 = CONVENTIONS §4：「**过程文档是否还活着**，不是验收跑没跑完」——真机欠账由
> [`plans/README.md`](../../plans/README.md) 欠账表承载（**本仓唯一在办真值**）。
> 现状承接：`docs/design/lantai-design-spec.md`（版式与几何契约）+ `src-ui/src/paper/README.md`。

| 件 | 是什么 | 现在看哪 |
|---|---|---|
| [`render-surface-completeness-plan.md`](render-surface-completeness-plan.md) | 渲染面补全：20 个查看器（图/视频/PDF/3D/Office/epub…）+ Mermaid + 尺寸预检 | 欠账表 + 施工单 §8 十项 |
| [`stream-rhythm-plan.md`](stream-rhythm-plan.md) | 会话流版式语法：事件语义分类 + 工作单元 + 节奏渲染 + 目次带阶段导航 | 欠账表「stream-rhythm 真机验收五项」 |
| [`streaming-fade-render-plan.md`](streaming-fade-render-plan.md) | 流式渐显渲染（旧块零动画，识别收在渲染器内部） | 欠账表相关条目 |
| [`scientific-rendering-plan.md`](scientific-rendering-plan.md) | 科研渲染：双通道决策模型 + kind 扩充（math / citation / chem / 交互 chart / 虚拟 table） | 欠账表 + 施工单 §7 真机项 |
| [`tool-image-context-plan.md`](tool-image-context-plan.md) | 工具附图通道（agent 眼睛环）：工具产出的截图进模型可见通道 | 欠账表「工具附图通道」 |
| [`pin-provenance-plan.md`](pin-provenance-plan.md) | 出处引导：钉块页边注常显卷名 + hover 引线 + 点行溯源 | 欠账表「出处引导手感」六条 |
| [`asset-state-plan.md`](asset-state-plan.md) | 资产状态：沙箱 html 卡的交互态经 postMessage 桥写回内核并按会话落盘 | 欠账表「资产状态」（**须重建 exe**） |
| [`asset-rack-plan.md`](asset-rack-plan.md) | 图版架（资产收纳面）：坞下横架，点=飞回块 / 拖出=钉到纸上 | 欠账表「图版架手感」九条 |
| [`paper-interaction-handoff.md`](paper-interaction-handoff.md) | 纸壳交互承接：审计「交互面断链全集」逐条修复（8/8 销账） | 守护 `src-ui/tests/paper-interaction-handoff.test.ts` |

**关联但仍在办**（不在本目录）：`docs/plans/paper-shell/`（R5 打磨环收尾中）· `docs/plans/canvas-space/`（画布 Stage-6 进行中）。
