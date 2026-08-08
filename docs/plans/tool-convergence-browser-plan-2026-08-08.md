# HoloGram 前端测试能力 + 工具层收敛计划（2026-08-08 v2）

> 现状：注册路径约 95~100 个工具（coding 35 + engine MCP 25~28 + agent/任务/记忆/计划/通信等 ~35）。
> 目标：前端验证能力以 **Skill 驱动的工作流** 落地——零新增工具、零新增进程、零新增协议；
>       工具层收敛同步推进（三层架构 + 每轮可见性 + 意图而非机制）。
> v2 变更：放弃 v1 的 Node 桥方案（browser-bridge + Rust RPC + 常驻进程），理由见 §3.4。
> 执行方式：渐进收敛，旧工具名以 alias 过渡；每阶段独立可交付、带验收与回归。

## 全局约束

- 遵守根目录 `AGENTS.md`：不恢复 Python 引擎路径；不改布局参数；打包用 `cargo tauri build`。
- 每个阶段只动自己声称的位置，不顺手重构无关模块。
- 修改工具集清单时同步更新 `AGENTS.md` 与对应 docs。
- 每阶段验证：`cd src-tauri && cargo test`、`cd src-ui && npx tsc --noEmit`、相关 vitest。
- **能用现有机制解决的，不新建机制**（本计划核心原则）。

---

## 1. 设计原则

### 1.1 三层架构，各管各的增长

| 层 | 职责 | 增长方式 |
|---|---|---|
| 核心 registry | 稳定的小工具集（领域工具） | 几乎不增长 |
| MCP / 本地桥 | 能力插件（图查询、外部服务） | 按需接入 |
| Skill | 使用知识（何时用、怎么用、流程） | 无限扩展 |

### 1.2 每轮可见性小于目录

100 个工具可以存在，但**每轮只给模型 5~12 个**。目录（catalog）与可见集（visible set）分离：

- 模型每轮看到 `ToolSchema[]` 是注入器筛选后的子集；
- 注入器 = 任务相关性（先词法/领域映射，Phase 2 后接引擎语义搜索）；
- 常驻工具（`ask_user`、`plan`、`wait`、`skill`）永远可见；
- 其余按 domain + 描述相关性取 top-K，K 可配置（默认 12）。

### 1.3 暴露意图，不暴露机制

worktree 隔离、inbox、merge、board 等是框架内部机制，收敛后不作为独立工具暴露；
模型只看到 `agent` 领域工具的动作：`spawn / status / kill / message / merge / discover`。

### 1.4 能用现有机制解决的，不新建机制

前端验证所需的全部动作 = **写测试 + 跑测试 + 读报告**，而这三个动作已经存在：

| 动作 | 现有工具 | 备注 |
|---|---|---|
| 写测试 | `write_file` / `edit_file` | 测试文件本身就是可审查资产 |
| 跑测试 | `run_shell` | 已有 sandbox / streaming / timeout / kill / 后台任务 |
| 读报告 | `read_file` | JSON reporter 输出结构化结果 |

因此**不新增常驻进程、端口、token、状态文件、HTTP 协议**——这些都是新的故障面，
与"收敛"叙事直接冲突。

---

## 2. 目标形态：领域工具总表（12 + 1 暂缓）

| # | 领域工具 | 主要 action | 吸收的现有工具 |
|---|---|---|---|
| 1 | `fs` | read / write / edit / list / glob / move / delete / mkdir | read_file_content、write_file、edit_file、list_directory、glob、move_file、delete_file、create_directory、rename_file |
| 2 | `shell` | run / output / wait / kill | run_shell、bash_output、bash_wait、bash_kill |
| 3 | `git` | status / diff / log / stage / commit / push / pull / checkout / branch / stash / discard / init / blame | git_* 全部 |
| 4 | `search` | content / symbols / files | search_content、search_code |
| 5 | `web` | fetch / search | web_fetch、web_search |
| 6 | `agent` | spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolate | agent_spawn、agent_status、agent_kill、agent_message、agent_request、agent_reply、agent_inbox、agent_ack、agent_list、agent_merge、agent_discover、agent_lookup、agent_isolation_* |
| 7 | `task` | create / get / list / update / stop / board | task_*、agent_board |
| 8 | `memory` | save / read / search / list / delete / recall | hologram_memory_*、aura_* |
| 9 | `plan` | enter / exit / review | enter_plan_mode、exit_plan_mode |
| 10 | `skill` | run / list | Skill |
| 11 | `ask` | question | ask_user |
| 12 | `wait` | until | wait |
| – | `browser`（暂缓） | – | v1 不建；交互式浏览器仅在 v2 决策（Rust 原生 CDP），见 §3.5 |

**过渡策略**：`ToolRegistry.alias()` 已有别名能力。每收敛一个领域，先注册领域工具，
同时把旧名 alias 到领域工具（旧工具名对模型仍可用、测试不炸），观察后再移除别名。

---

## 3. 前端测试能力：v1 推荐实现（测试即代码）

### 3.1 架构

```
Agent ──write_file──> .e2e/frontend.spec.ts
Agent ──run_shell──> npx playwright test --reporter=json
Agent ──read_file──> report.json（含失败、截图路径、console、trace）
Agent ──edit_file──> 修断言/修代码 → 重跑，直到绿
```

全部走现有工具与现有权限/超时/进程管理，无常驻状态。

### 3.2 新增内容（Phase 1 全部）

| 内容 | 说明 |
|---|---|
| `src-ui` devDependency：`@playwright/test` | 一次性依赖；文档化 `npx playwright install chromium` |
| `.hologram/skills/frontend-test/SKILL.md` | 流程 + 模板 + 约束（data-testid、本地 URL、report 解读、超时约定） |
| `scripts/playwright-report.mjs`（可选） | 把 report.json 压成摘要（passed/failed/截图/console）——**瞬时 CLI，不是常驻服务** |
| `src-ui/e2e/smoke.spec.ts` 示例 | 一个可跑通的冒烟测试，作为 skill 模板参照 |

### 3.3 为什么这是"先进"

- 与专业团队一致：前端验收本来就是 Playwright 测试文件；
- 可复现、可审查、可回归：测试是资产，不是会话状态；
- 模型能力栈零新增：写/跑/读三件套已有，只多一份"怎么用"的说明；
- 截图、console、trace、视频由 Playwright 自带，不需要自研；
- Skill 热加载机制（`skills.ts`）就是为这类流程设计的。

### 3.4 为什么放弃 Node 桥（v1 方案雷点）

| 雷点 | 说明 |
|---|---|
| 常驻进程 | 生命周期、崩溃、僵尸、App 退出清理——每个都是新故障面 |
| 端口 / token / 状态文件 | 三处同步状态，任一失配即"假死"，错误发生在协议层 |
| 五跳协议链 | TS → Rust RPC → HTTP → Node → CDP → Chrome，排错成本指数上升 |
| 绕过权限引擎 | `browser_start` 直接 spawn 进程，脱离 `require_command` / `require_write` 体系 |
| 运行时漂移 | Node 版本、Chrome 路径、CDP 协议版本各自升级，互不保证兼容 |
| 与收敛叙事冲突 | 为 1 个能力建 1 个子系统，是最贵的加法 |

### 3.5 何时才上交互式浏览器（v2 决策点）

仅当"逐步骤调试 UI 状态"成为高频需求时立项。届时实现方式为 **Rust 原生 CDP**
（tokio-tungstenite），走 `os_sandbox` 启动、挂 `ResourceLedger` 生命周期管理；
**不使用 Node 桥**。v1 的测试工作流可覆盖 90% 的前端验证场景。

---

## 4. 工具检索（Phase 2）

### 4.1 Tool 元数据

`Tool` 接口增加可选元数据（不影响既有实现）：

```ts
export interface Tool {
  // ...existing...
  domain?(): string;        // 例如 'fs' | 'shell' | 'agent'
  actions?(): string[];     // 例如 ['start','navigate','snapshot']
}
```

`ToolRegistry` 增加：

```ts
catalog(): ToolDescriptor[]   // 完整目录（供检索器）
visible(names: string[]): ToolRegistry  // 注入子集
```

### 4.2 注入策略（默认值）

- 常驻：`ask_user`、`plan`、`skill`、`wait`（4 个）；
- 任务相关：从 catalog 按 domain 匹配 + 描述关键词打分取 top-K（K=8 默认）；
- 总可见 ≤ 12；
- 配置项 `tools.visibleLimit`（0 = 全量，兼容旧行为）；
- Phase 2 后期可接引擎语义搜索（`search_symbols` 同款向量通道）做工具选择。

---

## 5. 开放决策

| 决策 | 推荐 | 备选 |
|---|---|---|
| v1 前端验证 | 测试即代码（Skill + Playwright） | – |
| v2 交互式浏览器 | Rust 原生 CDP，另行立项 | 不做 |
| 截图感知 | Playwright 截图落盘，给用户 / 视觉模型 | 给 `Message` 加 image 通道 + 换视觉模型（另行评估） |
| 收敛节奏 | 渐进：alias 过渡，每轮移除一批 | 一次性重写 registry |

---

## 6. 分阶段落地

### Phase 1：frontend-test Skill 工作流（本次候选）

- **范围**：`@playwright/test` devDependency + `frontend-test` skill + report 摘要脚本（可选）+ 示例 spec。
- **不做**：新增工具、新增 Rust 命令、新增常驻进程、工具检索、其他领域收敛。
- **验收**：Agent 在真实仓库中：写 spec → `run_shell` 跑通 → `read_file` 解读 report →
  修复断言 → 重跑通过；工具 schema 数量不变。
- **回归**：现有工具 schema 零变化；`npx tsc --noEmit`；相关 vitest。

### Phase 2：工具检索注入

- Tool 元数据 + catalog/visible + 注入器；默认 K=12，可配置关闭。
- **验收**：同一任务下模型收到的 schemas 数 ≤ 12；关闭配置后行为与现状一致；常驻工具永在。

### Phase 3：coding 35 → 5 个领域工具

- fs / shell / git / search / web 落地 + alias 过渡。
- **验收**：旧工具名调用仍工作（alias）；新工具名全动作有测试；`AGENTS.md` 工具清单同步。

### Phase 4：agent / task / memory / plan 收敛

- 隐藏 plumbing（merge/inbox/isolation 不暴露给模型）。
- **验收**：模型可见工具降至 12 个领域工具 + 动态注入；全量回归（agent 协作、goal、plan 模式测试）。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Playwright 浏览器下载体积 / 网络 | 文档化 `npx playwright install chromium`；离线可用缓存 |
| 选择器脆弱（SPA 动态 DOM） | skill 约定 `data-testid`；优先 role/text 定位 |
| 测试运行时长 | 超时约定；`runInBackground` 兜底；report 只读摘要 |
| 无交互式点击体验 | v2 Rust CDP 决策点，不提前建子系统 |
| 与在途 consolidate 分支冲突 | Phase 1 只加文件 + `src-ui/package.json` 一行依赖，不碰 runtime.ts/hooks.ts |

