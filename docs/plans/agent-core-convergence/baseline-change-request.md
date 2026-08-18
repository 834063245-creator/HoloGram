# Baseline 变更申请 — phase-0/tool-schemas.{full,plan}.json（desktop 域新增 UIA 动作枚举）

> ⚠️ 状态：**已批准并执行完毕**（2026-08-18）——用户在对话中批准（"两个都修 + 生成 baseline-change-request.md"）。
> 本文件同时是后续申请的模板：既有快照漂移时，按本格式重写此文件（对象/理由/
> 证据/拟议内容/落地步骤），停工等用户审批。
> 前例：create-agent.wiring.txt 行尾归一申请（2026-08-16）原文见 git 历史。

> 申请日期：2026-08-18 · 申请人：编码助手（CDP/e2e 修复期间跑全量 vitest 发现）

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`
- 变更内容：`desktop` 领域工具的 `action` 枚举由 `["probe","screenshot"]` 扩展为
  `["probe","screenshot","uia_tree","uia_find","uia_click","uia_right_click","uia_type","uia_scroll","uia_window_shot"]`
  （新增 7 个 UIA 动作）；同时随各 `uia_*` 工具参数并入 desktop 域 schema 的合并属性，
  以及 browser.ts 对 uia 工具 description/depth 语义的更新，一并反映在快照里。
- **模型可见表面：确有计划性变更**（新增桌面 UIA 自动化工具面），非行尾/时序伪漂移。

## 2. 为什么必须变

- UIA 桌面自动化通道（commit `e33d6204` 起 + 后续修复提交 + 2026-08-18 的 locator 必填校验 /
  depth 语义 / 前台置顶增强）在 convergence baseline 冻结（2026-08-17）**之后**落盘；
- baseline 的 tool-schemas.full.json 中 `uia_` 关键词出现次数 = 0（实测），说明快照冻结
  早于全部 UIA 工具面；
- 领域工具契约（CONVENTIONS.md §1.7 / AGENTS.md §7）要求新领域动作同步 `DOMAIN_SPECS` +
  `collectHiddenToolNames()` + 本文件——diff 与实代码一致，属工具面变更的正常审批路径。

## 3. 证据

- `npm run verify:convergence`（vitest phase-0）报 tool-schemas.full.json 首个差异在第 906 行：
  `"screenshot"` → `"screenshot",`（枚举项后补逗号）起，随后 `enum` 新增
  `uia_tree / uia_find / uia_click / ...`；tool-schemas.plan.json 首个差异在第 885 行同型；
- `DOMAIN_SPECS` 的 desktop.actions 现有 9 个动作（probe / screenshot / uia_*×7），
  `tests/agent-boundary.test.ts` 的 BROWSER_API_RE 误报已独立修复（74 tests 全绿），
  与本次 baseline 变更无耦合。

## 4. 拟议变更（record 已生成的内容）

- 重新生成 `phase-0/tool-schemas.full.json` 与 `phase-0/tool-schemas.plan.json`，
  使 desktop 域 `action` 枚举及合并属性与当前 `buildToolRegistry` / `planRegistry`
  输出逐字节一致；
- record 后 `git diff` 应只含这两个文件（其余 6 个 baseline 文件零变化）。

## 5. 落地步骤（已执行）

1. 修复 `tests/agent-boundary.test.ts` 的 `BROWSER_API_RE`（缩小为 "window./document." 后跟
   标识符 / 括号访问 / `requestAnimationFrame(` 的真实调用形态，消除英文描述文案误报）——
   独立于本变更的防自证修复；
2. 本文件按格式重写；
3. `npm run record:convergence` 重录 baseline（diff 应只含 tool-schemas.{full,plan}.json）；
4. `npm run verify:convergence` 全绿 + 全量 vitest 复跑全绿；
5. `npx biome check --write` 改动文件（增量：agent-boundary.test.ts / 本文件无样式内容）。

## 6. 遗留观察（不在本次范围）

- 本漂移由 UIA 功能提交在 baseline 冻结后引入；CI 前端只跑 build 不跑 vitest（ci.yml），
  漂移长期未暴露，与 src-tauri CDP/e2e 修复无耦合。
- 全量 vitest 的 `desktop-tools.test.ts` 已由用户今晚更新并通过；browser.ts 描述文案与
  `--obs-*` 无关，属模型可见面内容，计入本快照。
