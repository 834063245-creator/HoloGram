# Skills 与 MCP 生产级改造计划

> 状态：**Commit 1-6 全部落地（4667f2b8 … a9d82b2a）+ 文档收口完成（2026-10-08：技能配方 [`../cookbook/adding-a-skill.md`](../cookbook/adding-a-skill.md) · MCP 用户级一节 [`../cookbook/adding-an-mcp-server.md`](../cookbook/adding-an-mcp-server.md)）；剩余 = 真机验收**
> 立项：2026-09-07 用户拍板（决策见 §0）
> 参照调研：deepseek-harness（DSH，本宿主同构）/ kimi-code / openhanako / jeecg-cc 四仓库 Skills/MCP 实现（调研结论见 §1）
> 改造对象：兰台 `agent/skills.ts`（Skills）+ `plugins/mcp-bridge.ts` / `agent/mcp/*`（MCP）+ Rust 沙箱 + 设置面板 UI
> 施工进度（2026-09-07）：4667f2b8（内核+注入）· b41ed197（沙箱）· e102659b（UI）
> · 55eca277（工具名哈希）· 00f8cd4b（用户级 mcp.json）· 3c176280（死代码清理）
> · 9f224bd5（断线感知）· f1cefef9（mcp.json 沙箱豁免）· a9d82b2a（MCP tab）

## 0. 用户拍板决策（2026-09-07，全部已定）

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 范围 | **Skills + MCP 一起做，先 Skills 后 MCP**（含各自管理 UI） |
| 2 | MCP client | **保留自研 client，只补缺口**（不换官方 SDK——现有 4 套测试守护，自研层已精） |
| 3 | 技能目录 | **`.lantai/skills`（项目）+ `~/.lantai/skills`（用户级新增）**；不追 `.agents/skills` 跨 agent 标准（互通性让步于改动面） |
| 4 | 发现注入 | **每步注入 available_skills + digest 增量**（目录摘要进 system prompt/reminder，sha256 digest 控制重发，空目录零注入） |
| 5 | MCP 配置入口 | **只做用户级 `~/.lantai/mcp.json`**（不做项目级 `.mcp.json` 三档/跨 agent 兼容） |
| 6 | 管理 UI | **设置面板加「技能」「MCP」两个 tab**（仿 PluginsPage/ProviderPage） |
| 7 | 安装渠道 | **目录 + git 链接（本期）**；GitHub+LLM 安全审查安装闭环下期 |

## 1. 参照调研结论（四仓库 Skills/MCP 实现速记）

调研代理逐仓库读了实现（jeecg-cc=Claude Code 系完整蓝图 / kimi-code 含 `~/.agents/skills` 与 MCP 三档 `.mcp.json` / deepseek-harness=registry+provider+6 层 rank 目录与 `<available_skills>` digest 注入 / openhanako 含 GitHub+LLM 安全审查安装闭环与 needs-auth 终态）。

**共识要点（抄什么）**：
1. **frontmatter 用真 YAML 库**解析（kimi-code/DSH/openhanako 全用 js-yaml 或 yaml 包），坏文件 warn 跳过不炸发现——兰台现手写 20 行行扫是明显短板。
2. **渐进披露**：name+description 以目录摘要注入（`<available_skills>` / system-reminder），正文按名加载；**sha256 digest 控制增量重发**（DSH tool-skill）→ KV cache 稳定。
3. **发现层级**：项目级 + 用户级 + rank 决胜（DSH 6 层 / kimi-code 4 层）。用户级目录（`~/.agents/skills` 或品牌目录）是跨工具技能库标准。
4. **资源基址**：技能正文里 `${SKILL_DIR}` 占位符 + 目录并入文件工具白名单（kimi-code path-access / DSH resourceBase）→ 技能可带 scripts/references/assets。
5. **热装载**：chokidar/fs watcher + invalidate（DSH/kimi-code 都做，兰台现每次调用全量重扫）。
6. **MCP 工具名防塌缩**：超长/非法字符 lossy 归一后追加 sha256（DSH tools.ts:112 / kimi-code tool-naming.ts）——兰台 client.ts 只替换不哈希是洞。
7. **MCP 生命周期**：意图门控重连 + 指数退避 + 有界重试（DSH maxAttempts 10 / openhanako 四门控）；needs-auth 终态 + OAuth（openhanako）；兰台治理器已有 lazy/eager/with-window + 就绪时限 + 崩溃退避，是强项，保留。
8. **断线自动恢复**：调用级 ping 探测 + reconnect 一次（kimi-code tools/mcp.ts:79-131）——兰台现"未就绪即抛错让模型重试"可补。

**兰台差异化优势（不抄，保留）**：ServerGovernor 三档生命周期 + 就绪时限 + 崩溃退避 + 进程树 kill（DSH/jeecg-cc 都只有简单 lazy/eager）；cordis 插件贡献通道（`manifest.mcpServers` 折算工具行）——比 DSH"每 server 一个插件实例"更集中。

## 2. 兰台现状病理（代码级诊断，2026-09-07 已核实）

### Skills（不止糙，是断的）
| 缺陷 | 代码证据 |
|---|---|
| 私有目录零互通 | `agent/skills.ts:52` 硬编码 `.lantai/skills`；不读用户级/`.agents` |
| 手写 frontmatter 行扫 | `agent/skills.ts:23-46`；无 schema 校验；坏技能 `/* skip */` 静默吞 |
| 发现注入为零 | name+description 不进 system prompt/reminder——模型只能盲猜技能名 |
| slash 菜单是断的 | `ui/command-registry.ts:59` `setSkillProvider` **从未被调用** → `/` 命令菜单技能列表恒空 |
| slash 无脑路由 | `app/chat/chat-core.ts:1222` 一切未知 `/xxx` 都当技能丢给模型 |
| 无用户级 | `SkillRegistry` 只吃工作区 `.lantai/skills` |
| 无资源支持 | 技能纯文本，无 scripts/references 暴露 |
| 无测试守护 | 无 skills 测试（对比 MCP 4 套） |
| Rust 沙箱锁死 | 用户级读取以项目根为界（`sandbox.rs` 只 `global_memory` 例外） |

### MCP（马达精，油管窄）
| 面向 | 判断 |
|---|---|
| 自研 client + ServerGovernor | **精，保留**（4 套测试守护：mcp-client/mcp-bridge/mcp-bridge-governance/plugin-dataflow-mcp-e2e） |
| 配置入口 | **只有插件 manifest.mcpServers 一条路**；无用户级/项目级直配 |
| `mcpClients` 旁路参数 | `agent/runtime/agent-builder.ts:111` 定义但**零生产调用方** = 死代码 |
| 工具名 | `agent/mcp/client.ts:80-87` 只替换不哈希 |
| HTTP 鉴权 | headers 明文（openhanako 有 OAuth 可抄但本期不做） |

## 3. 目标架构

### 3.1 Skills

```
发现层级（项目 + 用户）：
  <project>/.lantai/skills/<name>/SKILL.md     ← 现有（保留兼容）
  ~/.lantai/skills/<name>/SKILL.md             ← 新增用户级

解析（agent/skills.ts 重写）：
  - frontmatter 用 yaml 包（已在 src-ui deps）解析，schema 校验
    （name kebab-case + 必填 description 等），坏文件可见诊断（skip 带 reason）
  - 双形态支持：目录包 <name>/SKILL.md（推荐）+ 扁平 <name>.md（可选项）
  - 字段：name / description / when_to_use / allowed-tools / metadata（宽松）

发现注入（每步 available_skills + digest）：
  - SkillRegistry 每次扫描产出技能目录（name + description + 摘要）
  - 注入点 = agent loop 每步（agent.ts / state-inject 模式）：目录渲染成
    available_skills 文本块，sha256 digest 控制"未变不重发/变了替换"
  - 空目录 → 不注入（零 token 开销；convergence fixture 无技能 → 零漂移）

资源支持：
  - 技能正文 ${LANTAI_SKILL_DIR} 占位符 → 展开为技能目录绝对路径
  - 技能目录内 scripts/references/assets 经既有 fs 工具可读（非 agent 读已通）

热装载：
  - 保留"调用时重扫"兜底 + 加变更检测（扫描结果缓存 + digest）——避免每轮全量 list+read
  - 或 Rust composition_watcher 同款 notify 监听（评估成本后定）

管理 UI（设置面板「技能」tab）：
  - 技能列表（来源项目/用户 + name/desc/状态）
  - 安装：目录/git 链接（git clone 进用户或项目技能目录）
  - 删除/禁用（禁用 = 元数据标或移目录——定稿）
  - slash 菜单接通 setSkillProvider（修 command-registry 断线）
    ↳ 现状（2026-09-19）：command-registry 已整文件退役（斜杠命令面重做，
      见 docs/archive/kernel-tooling-line/command-surface-rework-plan.md）——技能候选改由 app/commands/skill-catalog
      按工作区路径键控提供，`/` 面板与 Ctrl+K 面板消费同一份合流清单
```

### 3.2 MCP

```
用户级配置入口（新增）：
  ~/.lantai/mcp.json        ← 新增用户级 server 声明（仿 manifest.mcpServers 形状）
  装载：boot/workspace 期读盘 → 折算成工具贡献行（复用 registerMcpServerTools 逻辑，
  插件名 = 特殊"user"命名空间，行 id plugin/user-mcp/<server>）
  schema：zod 校验（复用 McpServerDeclSchema），坏文件可见诊断
  watch：mcp.json 变更 → 重载（Rust notify 或轮询——评估）

工具名防塌缩（修洞）：
  publicToolName 超长/非法 → lossy 归一 + 追加 sha256（8-12 hex）——对齐 DSH/kimi-code

断线自动恢复（补）：
  旧形态（非受治）client 意外断开 → 自动重连（指数退避，仿治理器 on-crash）
  调用期：ping 探测存活 → 死则 reconnect 一次重试（仿 kimi-code）

死代码清理：
  agent-builder.ts mcpClients 旁路参数——删除或接线统一到用户级配置装载

管理 UI（设置面板「MCP」tab）：
  server 列表（来源插件/用户级 + transport/状态）
  用户级增删改（写 ~/.lantai/mcp.json）
  状态展示（受治面 ready/starting/not-running + 旧形态 connected）
```

## 4. Commit 序列（每步门禁全绿才进下一个）

1. ✅ **Skills 内核**（4667f2b8）：重写 `agent/skills.ts`（yaml 解析 + 用户/项目双层 + 双形态 + 坏档诊断）。门禁绿。
2. ✅ **Skills 发现注入**（4667f2b8）：装配期 skillCatalog 段（agent-builder + runtime——空技能零注入，convergence 零漂移）。
3. ✅ **Skills 沙箱**（b41ed197）：Rust `sandbox.rs` `is_user_data_path` 泛化（skills 读放行，写锁项目内）。cargo 测试绿。
4. ✅ **Skills 管理 UI**（e102659b）：设置面板「技能」tab（SkillsPage 列表/新建/删除二次确认）+ slash 候选接通 setSkillProvider + 宿主桥封蜡三处。
5a. ✅ **MCP 工具名哈希**（55eca277）：publicToolName lossy 归一追加 FNV-1a 防塌缩。
5b. ✅ **MCP 用户级配置**（00f8cd4b）：`~/.lantai/mcp.json` 装载（user-mcp.ts 折算工具贡献 + main.ts 接线）。
6a. ✅ **MCP 死代码清理**（3c176280）：mcpClients 直连旁路删除。
6b. ✅ **MCP 断线自动恢复**（9f224bd5）：McpTransport.onUnexpectedClose + client 进程退出 isConnected 翻 false + 在途判负——装配级重连闭环生效。
6c. ✅ **设置面板「MCP」tab**（a9d82b2a）：McpPage 用户级 server 列表/新建/删除 + 沙箱 mcp.json 读写豁免（f1cefef9）。
7. ✅ **文档收口**（2026-10-08）：技能配方落 [`../cookbook/adding-a-skill.md`](../cookbook/adding-a-skill.md)、MCP 用户级配置补进 [`../cookbook/adding-an-mcp-server.md`](../cookbook/adding-an-mcp-server.md)（`~/.lantai/mcp.json` 一节）＋ cookbook 索引登记；**本计划待真机验收后归档**。

## 5. 验证门禁（每 commit）

- 前端：`cd src-ui && npm run build`（tsc --noEmit + vite build）
- 前端逻辑：`cd src-ui && npx vitest run`（跑前 `$env:NODE_ENV='test'`）
- 前端格式：`cd src-ui && npx biome ci .`（0/0）
- 组合层：`cd src-ui && npm run verify:convergence`（exit 0；技能目录空 → 零漂移）
- Rust（改沙箱时）：`cd src-tauri && cargo test`
- **不碰工作区既有未提交改动**（8 个 paper-shell 文件，属用户活跃工作）

## 6. 已核实的事实锚（施工引用）

- 用户级目录解析先例：`src-tauri/src/commands/fs_cap.rs:134`（`global_memory_dir` → `USERPROFILE/.lantai/global_memory`）；`sandbox.rs:98` `is_global_memory_path`
- yaml 包已在 src-ui deps（preset-discovery/patch-loader 用它解析用户 YAML）
- Skill 工具不在 convergence tool-schemas 快照里（改 schema 相对自由）
- MCP 测试守护：mcp-client / mcp-bridge / mcp-bridge-governance / plugin-dataflow-mcp-e2e（改造兼容护栏）
- 设置面板 tab = 硬编码数组（settings-domain/SettingsPanel.tsx:372-391），新 tab 要改 Tab union + 数组 + content 块
- workspace 有 8 个未提交 paper-shell 改动（用户活跃工作，不碰）
