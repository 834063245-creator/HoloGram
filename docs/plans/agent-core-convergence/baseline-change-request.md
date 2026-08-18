# Baseline 变更申请 — phase-0/tool-schemas.{full,plan}.json（desktop UIA 重构 + browser/desktop 复合动作）

> ⚠️ 状态：**已批准并执行完毕**（2026-08-19）——用户在对话中批准（"好，批准，弄好后记得提交你的改动"）。
> verify:convergence check exit 0（check-2026-08-18T18-33-57Z）。本文件保留为后续申请模板。

> 申请日期：2026-08-19 · 申请人：编码助手（computer-use 改造 Phase 2/4/5）

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`
- 变更内容：
  - `desktop` 域 `action` 枚举 9 → **18 项**（新增 `uia_read / uia_wait / uia_select / uia_expand / uia_keys / uia_activate / uia_fill / audit / status`）；
  - `browser` 域新增 `fill / navigate_snapshot` 两项；
  - `uia_tree` 新增 `all/offset/max_results`、`uia_find` 新增 `all`、`probe` 新增 `route`；
  - 全部 desktop 工具 description 重写（ref 新语义 / world-diff / 权限分层 / [UIA_*] 错误码）。
- **模型可见表面：确有计划性变更**（Agent 优先 computer-use 改造核心交付物），非伪漂移。

## 2. 为什么必须变

- 2026-08-19 computer-use 改造：UIA 引擎进程内化（Rust `src-tauri/src/uia/`）、反馈闭环、
  新动作六件套 + 审计/状态 + 复合动作（fill/navigate_snapshot/uia_fill）；
- 领域工具契约（CONVENTIONS.md §1.7 / AGENTS.md §7）要求新领域动作同步 `DOMAIN_SPECS` + baseline 审批。

## 3. 证据

- record 后 `git diff` 只含这两个快照文件（其余 6 个 baseline 零变化）；
- 工具契约测试 94/94 通过（desktop/browser/tool-name/tool-param/tool-semantics/rename-impact）；
- `npm run verify:convergence` check exit 0（record 后）。

## 4. 拟议变更（record 已生成）

- 采纳 record 快照（desktop 18 动作 + browser 38 动作枚举与实代码逐字节一致）。

## 5. 落地步骤

1. ✅ DOMAIN_SPECS + 工具注册 + Rust 侧全量交付；
2. ✅ 本文件重写；
3. ✅ record:convergence ×2（Phase 4 一次 + Phase 5 复合工具一次）；
4. ⏳ 用户批准；
5. ✅ biome check 改动文件（2 个 biome 报错为存量非本次引入：domains.ts noNonNullAssertion L362 / browser.ts noExplicitAny——stash 验证 HEAD 上同样存在）。

## 6. 遗留观察（不在本次范围）

- 本机环境事件（已恢复）：父进程注入 `NODE_ENV=production` → npm omit=dev 剥 devDependencies →
  测试收集失败。已在 AGENTS.md 验证基线表注明对策（装包/跑测试前清该变量）。
- vitest 全量在干净环境下 1213 passed / 1 skipped（曾偶发 UI 家族 act 时序失败，重跑绿——存量）。
- cargo test 337/338 绿（1 个 encoding GBK 集成测试在本机偶发，单跑绿——存量环境敏感）。

