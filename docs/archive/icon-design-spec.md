# Hologram 图标设计规范

> 方向 A · 纯天文几何
> 适用于 `src-ui/src/ui/icons.ts` 及所有内联 SVG 图形

## 设计语言

所有图标只用四种图元：**圆 · 弧 · 直线 · 点**。
不画具象物体——没有齿轮、纸飞机、垃圾桶。功能隐喻通过天文仪器的抽象表达：刻度盘、透镜、信号弧、星图连线。

这套语言来自项目整体的"深空观测台"设计方向（参考 `tokens.css` 的 `--obs-*` 变量）。图标是仪器的刻度，不是拟物图标。

## 硬规格

| 维度 | 值 |
|------|-----|
| viewBox | `0 0 24 24` |
| 中心点 | `(12, 12)` |
| stroke-width | `1.5` |
| stroke-linecap | `round` |
| stroke-linejoin | `round` |
| fill | 仅用于"恒星"点（小圆 `fill="currentColor"`），其余一律 `fill="none"` |
| 色彩 | `stroke="currentColor"`，由 CSS 控制 |
| 网格对齐 | 坐标取整数或 `.5`，禁止 `4.05` 这类任意小数 |

## 视觉重量层级

| 层级 | 用途 | 半径范围 |
|------|------|---------|
| 外环 | 主轮廓 | r = 7 ~ 9 |
| 内环 | 次级结构 | r = 3 ~ 4 |
| 恒星点 | 焦点/状态 | r = 0.8 ~ 1.5 |
| 刻度线 | 装饰/方位 | 长度 1.5 ~ 2 |

图标之间的视觉平衡靠这三个层级的比例关系维持，不是靠统一外框。

## 禁止清单

- ❌ `<text>` 标签 — 用几何标记代替文字标签
- ❌ `<polygon>` 拟物形状 — 用 `<path>` 弧线或 `<line>` 组合代替
- ❌ `<rect>` 作为主体 — 仅用于容器类图标（terminal、keyboard、plan 等面板型）
- ❌ 不一致的 stroke-width — 全部 1.5，装饰性次级线可用 `stroke-width="0.75"` + `stroke-opacity="0.5"`
- ❌ 18×18 viewBox — 统一 24×24
- ❌ 本地内联 SVG 字典 — 一切走 `icons.ts` 的 `iconSvg()`

## 新增图标流程

1. 在 `icons.ts` 的 `icons` 对象中按分类添加条目
2. 路径只用 `<circle>` `<path>`（弧）`<line>` `<polyline>` `<ellipse>` `<rect>`（仅面板）
3. 有"恒星"焦点时用 `<circle r="0.8~1.5" fill="currentColor"/>`
4. 提供 `label`（无障碍标签，中文）
5. 在 `icon-full-preview.html`（如需）或 `dev` 模式下验证 14px 可读性
6. 跑 `npx tsc --noEmit && npx biome check src/ui/icons.ts`

## 分类与语义

| 分类 | 语义 | 示例 |
|------|------|------|
| Layout | 布局导航 | chevron-right, close, fold |
| Toolbar | 模式切换 | mode-minimal, mode-standard, mode-full |
| Panels | 面板入口 | settings, search, terminal, timeline |
| Actions | 操作按钮 | send, stop, save, undo, redo |
| Status | 状态反馈 | loading, alert, check-circle, blink-dot |
| Objects | 文件/数据 | file, folder, chart, edit, eye |
| AI/Agent | AI 相关 | agent, translate, blast, puzzle |
| Git | 版本控制 | git-branch, upload, download, refresh |
| Dataflow | 数据流 | dataflow, arrow-*, layers, zap |
| Permissions | 权限 | shield, lock, block |
| Symbols | 抽象 | brand, galaxy, link |

## 特殊图标说明

- **brand** — 品牌标识，同心圆 + 十字准星，是整个图标语言的"原型"
- **mode-standard** — 星座连线（三点 + 底边），代表项目的星图核心
- **galaxy** — 螺旋弧线，唯一允许的"有机"曲线，因为是星系
- **code-py / code-rs / code-go** — 不用 `<text>`，用几何标记区分语言（点阵/十字/环）

## 与其他 SVG 的关系

项目中有两类 SVG **不属于本系统**，不需要遵循本规范：

- `ChatBeacon.tsx` 观测信标装饰（32×32，独立图形）
- `graph-interaction-controller.ts` 瞄准星光标（56×56，独立图形）

但它们已经天然符合 Direction A（弧 + 圆 + 线），视觉上是协调的。
