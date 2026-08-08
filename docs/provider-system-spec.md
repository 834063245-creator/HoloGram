# HoloGram Provider 系统设计定稿

> 生成：2026-08-07 · 状态：定稿基线（施工按本文档执行，改动需回写本文档）
> 2026-08-07 二次全链路审计 + 收口已完成，见文末「二次审计与收口（P4）」——此后端/前端状态以该节为准。
> 范围：API Key 加密存储（后端）→ Provider 抽象层 → 模型目录 → 设置 UI 全链路。

## 一句话

Provider 系统 = **两种协议实现**（Anthropic / OpenAI 兼容）+ **一份数据目录**（6 厂商 JSON）+ **一条创建入口**（`createProvider` 工厂），密钥由 Rust 后端加密保管，前端只经 RPC 存取。

## 现状盘点（2026-08-07 实测）

### 后端（src-tauri）— 基本完好

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/credential.rs` (632 行) | DPAPI / Keychain / SecretService 三平台密钥存储 | ✅ 完整，有测试 |
| `src/rpc.rs` L414-426 | `credential_store/get/delete` 路由 | ✅ 完整 |
| `src/commands/identity.rs` | 命令封装 | ✅ 完整 |
| `credential.rs` L13-14 注释 | 声称「失败回退 localStorage 明文」 | ⚠️ 与 2026-08-04 治理后的现状矛盾 |

### 前端核心（src-ui/src/provider/）

| 文件 | 职责 | 状态 |
|---|---|---|
| `types.ts` (207 行) | Message/Chunk/ToolCall/Provider 抽象 + classifyError + sanitizeToolPairing | ✅ 完整，测试覆盖 |
| `anthropic.ts` (433 行) | Anthropic Messages API：手写 SSE + 4 缓存断点 + thinking effort | ✅ 完整 |
| `openai.ts` (307 行) | OpenAI 兼容（DeepSeek/Moonshot/Minimax/Qwen） | ✅ 完整 |
| `index.ts` (34 行) | `createProvider` 工厂（按 kind 分派） | ✅ 完整 |
| `retry.ts` (59 行) | 3 次指数退避重试 | ✅ 完整，测试覆盖 |
| `shared.ts` (109 行) | sseEvents / prewarm / fetchJsonWithTimeout / write 预览提取 | ✅ 完整 |
| `catalog.ts` (123 行) | 静态目录 + 动态模型合并 | ✅ 完整，测试覆盖 |
| `catalog/*.json` | 6 厂商模型数据（deepseek 4 / anthropic 14 / openai 29 / moonshot 10 / minimax 3 / qwen 5） | ⚠️ 覆盖不全（无 GLM/Ollama） |

### 设置与 UI

| 文件 | 职责 | 状态 |
|---|---|---|
| `settings.ts` (227 行) | ProviderSettings/AppSettings + 密钥落盘治理 + add/remove/update | ✅ 已治理 |
| `SettingsPanel.tsx` + `settings/*` | 五 tab 设置面板；Provider 页已拆为信号源控制台 | ✅ 可用（P5 重构） |
| `ModelSelector.tsx` (233 行) | 可搜索下拉 + 动态刷新 | ✅ 可用 |
| `runtime.ts` L16 | `createProvider` import | ⚠️ 死代码（未使用） |

### 使用方（不参与改造，只消费）

- `workspace.ts:601` — 主 Agent provider 创建（启动时一次）
- `agent.ts:1447` — 主对话循环 `prov.stream`
- `agent.ts:2045-2080` — 摘要模型自动选择（运行时读 settings）
- `FileTranslatorPanel.tsx:275` — 翻译器复用 provider 基础设施
- `chat-session.ts` / `ChatFooter` / `ChatBeacon` — 展示当前 provider

### 测试基线

- `tests/provider-*.test.ts` 5 个文件 59 用例 **全绿**（vitest）
- `npx tsc --noEmit` 通过

## 数据流全景

```
                      ┌─────────────── Rust 后端 ───────────────┐
  SettingsPanel ──RPC──> credential_store/get/delete ──> credential.rs
       │                     (DPAPI 加密, credentials.enc)
       │ localStorage(无明文)
       v
  settings.ts (AppSettings.providers[])
       │
       v
  createProvider(settings) ──kind──> anthropic.ts | openai.ts
       │
       ├─ prewarm()     → 预热 TCP+TLS
       ├─ fetchModels() → /models 动态模型 → mergeDynamicModels(catalog)
       └─ stream()      → POST + SSE → Chunk* → Agent 主循环 / 摘要 / 翻译器
```

## 数据契约（定稿）

### ProviderSettings（settings.ts）

```ts
interface ProviderSettings {
  kind: 'anthropic' | 'openai'; // 协议，不是厂商
  name: string;                 // 唯一标识（credential 的键名也用它）
  apiKey: string;               // 会话内明文，持久化权威=加密凭据
  baseUrl: string;              // 完整端点前缀（含 /v1）
  model: string;
  thinking?: string;            // 仅 anthropic：''|'off'|'low'|'medium'|'high'|'max'|数字
}
```

铁律：
1. `apiKey` **永不落 localStorage**（settings.ts saveSettings 抹空）——权威在 `persistSecrets` 写入的系统加密凭据
2. `name` 全局唯一——它是 provider 身份、credential 键、动态模型合并键的三合一

### ModelDescriptor（types.ts）

```ts
interface ModelDescriptor {
  id: string; kind: 'anthropic' | 'openai'; provider: string;
  baseUrl: string; reasoning: boolean;
  input: 'text'[];            // ← 定稿：仅 text。多模态未落地前禁写 'image'
  cost: ModelCost; contextWindow: number; maxTokens: number;
}
```

### Provider 接口

```ts
interface Provider {
  name(): string;
  stream(signal, req): AsyncGenerator<Chunk>;  // 唯一真实路径
  prewarm?(): void;
  fetchModels?(): Promise<ModelDescriptor[]>;
}
```

## 架构裁决（半成品问题逐条定稿）

| # | 现状现象 | 裁决 | 落点 |
|---|---|---|---|
| 1 | kind 仅 anthropic/openai 两种 | **保持**。新厂商优先走 openai 兼容端点；协议不兼容才新增 kind（现阶段无此需求，不做） | 本文档 |
| 2 | deepseek beta 模型挂 kind=anthropic | **保留**。这是特性——DeepSeek 提供 Anthropic 兼容端点；目录里加注释说明「kind=协议，provider=厂商」 | catalog 注释 |
| 3 | `input: ['text','image']` 图像假声明 | **砍**。Message.content 是 string，请求构建器无图像块；等真实传图入口出现再做（breaking change，单独立项） | anthropic.ts/openai.ts fetchModels |
| 4 | anthropic.ts `reasoning_tokens: 0` 写死 | **保留 + 注释**。Anthropic Messages API usage 无此字段，0 是事实正确 | 注释 |
| 5 | 动态模型 `reasoning: false` 写死 | **修**。按模型 id 启发式（含 think/reasoning/思考 关键词）；静态目录元数据仍优先 | openai.ts |
| 6 | 快速添加 chips 只填 name+kind | **修**。chips 同步带出 `defaultModel.baseUrl` | SettingsPanel.tsx |
| 7 | `defaultPricing` 硬编码三厂商 | **修**。优先读 catalog `cost`，读不到才走现有 fallback | settings.ts |
| 8 | runtime.ts 死 import | **删** | runtime.ts |
| 9 | credential.rs 过时注释 | **修**。对齐「apiKey 权威=加密凭据，localStorage 仅非敏感配置」 | credential.rs |
| 10 | 无「测试连接」 | **P1 新增**。复用 prewarm/fetchModels 或直接最小 stream 探测 | SettingsPanel.tsx |
| 11 | 主对话流无空闲超时 | **P1 新增**。参照 callSummaryLLM 60s idle 模式（agent.ts:2085） | ~~agent.ts~~ → provider/idle-stream.ts（P4 提取，三处复用） |
| 12 | provider 切换重建链 | **验证项**。确认 main.ts 注入的 `setOnSettingsSave` 重建 agent；文档锁定它为唯一切换入口 | 验收 |
| 13 | SSE 不解析 `event:`/多行 data | **保持**。所有目标服务商均单行 data；边界写入 shared.ts 注释 | 注释 |
| 14 | 目录缺 GLM/Ollama | **可选**。ollama 走 `http://localhost:11434/v1` openai 兼容，apiKey 可空；按需手写条目即可 | catalog/*.json |
| 15 | 目录数据维护（价格/窗口） | **定稿口径（2026-08-07）**：目录 = 开箱体验优化，非必需。全部消费点已有 fallback（clampMaxTokens 不钳制 / 窗口 fallback 200K / 摘要 fallback 主模型 / 徽章显示 LIVE / defaultPricing 硬编码回退）。厂商不提供元数据接口是行业现状；成熟 agent 软件（Chatbox/Cline/Cherry Studio）同为「手写列表 + /models 拉 ID」。**远程价格表（models.dev / LiteLLM GitHub raw）不做自动拉取**——国内网络 models.dev 不通、GitHub raw 时好时坏，引入启动依赖得不偿失 | 本文档 |

## 目录地位定稿（2026-08-07）

- **必需层**：URL + KEY + 模型名（手填或 /models 动态拉 ID）——无目录可跑
- **开箱层**：静态 catalog JSON（baseUrl/kind/默认模型）——低频手写维护
- **可选增强层**：远程价格同步（models.dev/litellm）——**不做**。要最新价格时按需手改 JSON

## 实测缺陷修复记录（2026-08-07）

### 缺陷 1：读 KEY 链路断裂 — key 前后被加双引号（已修）

- **症状**：key 存好后再读回前端，最前/最后面多出字符（JSON 双引号）
- **根因**：`rpc` 返回 JSON 编码字符串（`"sk-xxx"` 带引号，全仓库调用方均 `JSON.parse`），唯独 `settings.ts restoreSecrets` 直接 `stored.trim()` 未解析。2026-08-04 治理（localStorage 不再存明文）前此路径从未真正走到——旧版 localStorage 有明文 key，restoreSecrets 跳过读凭据；治理后首次暴露
- **修复**：`parseRpcString`（settings.ts）——JSON 编码/纯字符串/`null` 三态兼容；`restoreSecrets` 走它
- **回归测试**：`tests/settings-secrets.test.ts`（7 用例，mock bridge）

### 缺陷 2：模型下拉偶发失效 — 点选后 model 不填充（已修）

- **症状**：ModelSelector 点选模型偶发不填充
- **根因**：P1-A 改造把 `updateProvider` 从函数式 `setSettings(s => ...)` 改成闭包快照 + `commit`。`ModelSelector` 的 onChange 连续两次调用（model + baseUrl 自动填充），第二次基于旧 settings 克隆 → **覆盖掉第一次的 model 修改**。原版函数式更新可安全累积，是 P1-A 引入的回归
- **修复**：`updateProvider` 改回函数式 setSettings（连续调用安全累积）；落盘统一收口到 `useEffect(settings → saveSettings)`（updater 内不可做副作用）
- **验证**：tsc + 全量测试；下拉两连改场景人工验证

### 缺陷 3：key 填进去没被保存 — 回填竞态 + 误删（已修）

- **症状**：输入 key 后重开面板 key 丢失；多 provider 时其他凭据可能被误删
- **根因 A（回填竞态覆盖）**：面板挂载时 `restoreSecrets(loadSettings())` 异步回填——快照在用户已输入后到达时整体 `setSettings(s)`，**把刚填的 key 冲掉**（回填快照里 key 为旧值/空）
- **根因 B（空 key 误删）**：`persistSecrets` 对空 key 执行 `credential_delete`——state 与凭据因异步回填暂时不同步时，遍历会把**未回填的 provider 凭据误删**
- **修复**：
  - 回填改函数式合并：只填充仍为空的 key，不覆盖用户已输入
  - `persistSecrets` 空 key 不再 delete（删除只走 `removeSecret`：删 provider / 用户主动清空输入框）
  - `commitSecret` 只处理当前 provider：非空 store、空 removeSecret
- **回归测试**：persistSecrets 只 store 非空 + 永不误删（settings-secrets.test.ts，9 用例）

## 防再乱的规则（施工期强制）

新增一个 provider 的五步检查表（写进 CLAUDE.md 或本文档附录）：

1. `catalog/{name}.json` 加模型条目——`kind` 填**协议**（openai 兼容优先），`provider` 填厂商名
2. `baseUrl` 写完整端点前缀（含 `/v1`）
3. SettingsPanel 零改动（chips/ModelSelector 自动出现）
4. `tests/provider-catalog.test.ts` 补断言（厂商名、默认模型、kind）
5. 真机验证一轮带工具对话

## 分期施工计划

### P0 — 定稿落地（纯清理，零行为风险）

> 状态（2026-08-07）：**已完成**。

- [x] 删 `runtime.ts:16` 死 import（P1-C 顺手完成，含 `defaultPricing` 死 import）
- [x] 修 `credential.rs` L13-14 过时注释（对齐「apiKey 权威=加密凭据」）
- [x] 砍图像假声明：anthropic.ts/openai.ts fetchModels `input: ['text']` + **全量清理 6 个 catalog JSON 中 52 处 `"image"` 声明**
- [x] 动态模型 reasoning 启发式（openai.ts `guessReasoning` 导出，think/reason/r1/deepseek-v[34] 关键词）
- [x] anthropic.ts `reasoning_tokens: 0` 加注释（Anthropic usage 无此字段，0 是事实正确）
- [x] shared.ts SSE 边界注释（单行 data 契约，不支持 event:/多行）
- [x] catalog.ts 顶部注释（kind=协议非厂商；JSON 不支持注释故落于此）
- [x] 补测试：静态目录无 image 断言 + mergeDynamicModels 合并/跳过 + guessReasoning 启发式（provider-catalog.test.ts）
- [x] **额外修复**：`cargo test --bin hologram` 编译失败（utils.rs 残留 `clamp_depth` 死测试引用已删函数）——删除后解锁整个 bin test target：192 测试全绿，含 credential 4 项
- **验收**：`npx vitest run provider` 全绿（749 全量）+ `npx tsc --noEmit` 0 错 + `cargo test --bin hologram` 192 通过 ✓

### P1-A — 设置面板即时保存（方案 A，2026-08-07 定稿）

**原则**：面板是编辑器，不是事务——任何改动立即落盘，无 dirty 状态，无丢失风险。

| 操作 | 行为 |
|---|---|
| 字段编辑（baseUrl/model/thinking/temperature 等） | onChange 即时 `saveSettings`（localStorage 轻量） |
| apiKey 编辑 | onBlur 触发 `persistSecrets`（避免逐字符写 DPAPI 文件） |
| 切换当前 Provider | 立即 `saveSettings` |
| 添加 Provider | 一步到位表单（name/kind/key/baseUrl/model），确认即落盘 + 写凭据 + 激活 |
| 删除 Provider | confirm 后落盘 + `removeSecret` |
| 关闭面板 | 无确认弹窗（无未保存态） |
| 「应用」按钮 | 仅触发 onSave 重建链（字体缩放 / agent 重建 / 会话恢复），带成功反馈 |

**移除**：`dirty` state、`handleClose` 的 dirty 弹窗（L246-249）、`handleSave` 的 confirm 校验弹窗（L258-259，改为行内红字提示）。

- [x] SettingsPanel.tsx 即时保存改造（commit / commitSecret / handleApply，2026-08-07）
- [x] 添加表单一步到位（name/kind/key/baseUrl/model；catalog chips 带出 baseUrl+默认模型）
- **验收**：改字段→关闭→重开不丢；切换/添加/删除重开生效；`persistSecrets` 仅 key 失焦时写

### P1-B — 思考强度落地（三断点）

- [x] anthropic 「自动」模式补 `budget_tokens`（anthropic.ts L295，缺字段部分 API 版本 400）
- [x] `disableThinking` 语义统一到 anthropic：createProvider 时 `disableThinking → thinking='off'`（index.ts），翻译器/摘要路径自动受益
- [x] openai 协议思考强度 UI：仅落「深度思考」开关 + 说明文案（不编造 effort 参数——仓库无 DeepSeek effort 证据，API 支持后再加）
- **验收**：anthropic 翻译轮 thinking 关闭；「自动」模式真机不再 400；Agent 页开关真机生效

### P1-C — 其余协议硬化

- [x] `defaultPricing` 优先读 catalog（settings.ts：getModel 有 cost 即用，否则回退硬编码）
- [x] 「测试连接」按钮（SettingsPanel：最小 1-token 流式请求，15s 超时，classifyError 分类提示）
- [x] 主对话流空闲超时（agent.ts L1447：60s 无 chunk 视为挂起，自动中止并提示；外部 signal 只转发不直传）——P4 已提取为 `provider/idle-stream.ts`，主循环/摘要/main.ts 数据流解析三处复用
- [x] 顺手清理 runtime.ts 死 import（createProvider / defaultPricing，P0 遗留）
- **验收**：tsc 0 错 + 746 测试全绿；真机 DeepSeek 一轮对话

### P2 — 目录收口（2026-08-07 定稿：远程价格表不做，仅按需手写）

- [ ] ollama.json（本地端点，apiKey 可空路径验证）——**按需**手写
- [ ] glm.json（zhipu openai 兼容）——**按需**手写
- ~~远程价格同步（models.dev / LiteLLM GitHub raw）~~ **取消**：国内网络 models.dev 不通、GitHub raw 不稳定，目录非必需（裁决 #15），引入启动依赖得不偿失
- **验收**：`getCatalogProviders()` 含新厂商，五步检查表全过

### P3 — 真机回归（用户挂起，2026-08-07 暂不做）

- [ ] DeepSeek（openai 协议）带工具一轮
- [ ] Claude（anthropic 协议）带 thinking + 工具一轮
- [ ] 翻译器一轮（disableThinking 路径）
- [ ] 摘要模型自动选择路径一轮（触发条件：多 provider 有 key）——P4 已修复该路径的死链（见下），此前从未真正触发过
- [ ] 设置保存 → provider 切换 → 旧会话继续（重建链验证项 #12）

## 二次审计与收口（P4，2026-08-07 完成）

> 动机：P0–P1 后用户仍反馈「改来改去到处都有问题」。对后端→前端做全链路复审，结论：**协议层健康，病灶在胶水层**——读设置的姿势被复制了 5–6 份且漏了 1 份，造成静默断链。以下为修复定稿。

### 修复的断链级 bug

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 摘要模型自动选择从未生效 | `selectSummaryProvider` 读裸 `loadSettings()`，key 不落 localStorage 后 `keyed` 恒空 | 改走 `loadSettingsWithSecrets()`（agent.ts），新增 summary-model-selection.test.ts 钉死 |
| 清空 key 后旧 agent 仍在服务 | `ChatCore.setAgent(null)` 对 null 早退，旧 factory/provider 保持注册 | setAgent(null) 真正拆除：清 factory 注册 + `clearPanelAgents`（chat-core.ts / chat-session.ts） |
| 会话工厂双快照拼配置 | factory 用新设置算定价/窗口，却传外层闭包捕获的旧 provider | workspace.ts `_buildProvider()` 唯一创建收口；factory 从自己的新快照构建 provider |
| main.ts 数据流 NL 解析裸奔 | 无超时、signal 永不中止、忽略 ChunkType.Error | 接入 `streamWithIdleTimeout` + Error chunk 处理 + 静态 import |

### 收口（消除「复制即腐烂」）

- `loadSettingsWithSecrets()` = 读设置（含密钥）的**唯一入口**；`restoreSecrets` 不再被外部直接调用
- `getActiveProvider` 5 份内联克隆全删，统一 import（保留 agent.ts 无 fallback 变体——语义不同，非克隆）
- 60s 流式空闲超时提取为 `provider/idle-stream.ts`（主循环 / 摘要 / 数据流解析三处复用）
- 厂商 URL 字面量唯一化：`ANTHROPIC_DEFAULT_BASE_URL`（anthropic.ts）+ `PROVIDER_PROTOCOL_DEFAULTS` / `defaultBaseUrl()` / `isFactoryBaseUrl()`（settings.ts，catalog 优先）
- 设置变更响应式：`onSettingsSaved(cb)` 订阅（saveSettings 触发），ChatFooter/ChatBeacon/ChatHint 不再渲染期裸读 localStorage；ChatHint 不再解析 `[Agent] provider=` 日志串
- `sanitizeToolPairing` 去掉 agent 侧重复调用（provider 线格式关口仍在）
- SettingsPanel 刷新模型改用组件态快照（与测试连接一致）

### 删除的死代码

`_setActiveProvider` · `ProviderSettings.maxTokens` · `AppSettings.permissions` · `AgentOptions.maxTokens` 全链（option→字段→传参，唯一写入恒 0）· buildToolRegistry→agent-builder→coding.ts 的三层死 `provider` 参数 · `parse_keychain_dump_providers`（macOS 死函数 + 其测试）· identity.rs 三个从未注册的 `#[tauri::command]` 摆设

### 后端加固（credential.rs / rpc.rs）

- **损坏不再静默丢 key**：`credentials.enc` 解密失败先改名备份为 `credentials.enc.corrupt-<ts>` 再重建；备份失败则整体报错，永不覆盖仅存密文
- **原子写入**：tmp + rename（Win 覆盖语义兜底），崩溃不留半截文件
- **进程级写锁**：store/delete 串行化，8 线程并发测试不丢 key；get 无锁（原子 rename 保证一致读）
- **不堵 executor**：rpc 三个 credential 分支改 `spawn_blocking`
- **错误不再混淆**：macOS get 区分「未找到(44)」与真错误；macOS/Linux delete 幂等但真错误上抛
- `com.hologram.app`（cred_path）vs `com.hologram.hg`（tauri identifier）不一致**故意保留**——路径迁移 = 现存用户丢 key，已注释钉死

### 行为变化（有意为之）

- `addProvider` 改 catalog 优先：添加 `deepseek` 带出 DeepSeek 官方端点而非 `api.openai.com`（对齐裁决 #6）
- ChatHint 在 key 配好即显示就绪（不再等 setupAgent 诊断串）
- `isFactoryBaseUrl` 识别面扩到 qwen/moonshotai/minimax 出厂 URL（原 3 个 URL 数组的超集，同意图）

### 已知限制（如实记录）

- macOS/Linux 凭据分支在 Windows 主机上 cfg 编译不到，仅走查未真机验证
- `clearPanelState` 丢弃 exec 状态时未 `stop()`（handle dispose 会中止 runtime 侧，影响小）——既有缺口，列入后续
- `src-tauri/tests/hologram_dispatch_test.rs` 集成测试编译失败（engine API 漂移）——**既有问题，与 provider 无关**，需单独修
- biome check 仓库级基线噪音（未触及文件同样失败），构建门禁以 tsc 为准

### P4 验收（2026-08-07 实测）

- `npx tsc --noEmit` 0 错 · `npx vitest run` **771 全绿**（758 既有 + 13 新增）· `cargo test --bin hologram` **196 全绿**（含凭据 9 项）· 全量 diff 第三方复查结论 SHIP

## P5 — Provider 设置页 UX 重构（2026-08-08 完成）

> 动机：用户反馈 Provider 页「乱七八糟」。把 Provider 标签页从「下拉 + 竖排表单」重构为
> 「信号源控制台」，并修复两个数据丢失级缺陷（删除/清空 Key 的凭据时序错误）。

### 交互结构

- **左侧信号源列表**：每行一个 provider，状态点 = 未配置 / 已配置 / 正常 / 异常，
  当前使用中带「当前」角标；底部「＋ 添加信号源」。
- **右侧调谐控制台**：头部（名称/协议徽章/状态 pill/设为当前）+ 连接配置
  （API Key / 模型 / Base URL / Anthropic 思考等级）+ 诊断（测试连接 + 上次测试）+ 危险区（删除）。
- **添加弹层**：目录 chips 一键添加（name/kind/baseUrl/model 全带出，添加后自动聚焦 Key 输入框），
  或自定义表单（名称/协议/Base URL/模型/Key）。
- **面板内确认弹窗**（ConfirmDialog）替换原生 alert/confirm——删除、清除 Key、
  放弃未保存更改、空 Key/空模型强制保存。
- **保存按钮仅在 dirty 时可用**；dirty 状态在面板头部以「有未保存更改」chip 展示。

### 状态模型

- `ProviderSettings` 新增可选 `lastTest`（`{ status, latencyMs, at, message? }`，
  非敏感，随 localStorage 持久化）——左侧状态点与「上次测试」行的事实源。
- 测试结果按 provider 独立存储（`Record<name, phase/msg>`），切换信号源不再串台。
- `keyDirtyMap`（本会话内 Key 是否未保存）驱动「已保存到系统凭据 / 未保存 · 保存后写入」chip；
  保存成功后整体复位。
- `providerStatus()`（settings/status.ts）为状态推导唯一入口。

### 凭据时序（P0 修复）

- **删除 Provider**：只暂存删除（state + dirty），`removeSecret` 移到保存流程——
  用户取消/关闭面板不再丢 Key。
- **清除 Key**：显式「清除」按钮或手动清空输入框都会暂存清除；保存时才真正删系统凭据，
  杜绝「清空后重开面板 Key 复活」。输入新 Key 自动取消清除暂存。
- **Base URL placeholder / 重置** 按当前 provider 的 catalog 默认值计算，不再写死 deepseek。
- **模型刷新无 Key** 时明确提示「请先填写 API Key」，不再伪装成「未获取到新模型」。

### 组件拆分（SettingsPanel 单文件瘦身）

```
SettingsPanel.tsx（外壳：tab / dirty / 保存 / 凭据暂存）
└── settings/
    ├── ProviderPage.tsx       编排：选中态、测试 Map、添加/删除/清除确认
    ├── ProviderList.tsx       左侧信号源列表
    ├── ProviderDetail.tsx     右侧控制台（复用 ModelSelector）
    ├── AddProviderSheet.tsx   添加弹层（目录 chips + 自定义）
    ├── ConfirmDialog.tsx      面板内确认弹窗
    └── status.ts              状态推导 / 延迟 / 时间格式化
```

### 验证（2026-08-08 实测）

- `npx tsc --noEmit` 0 错
- `npx vitest run` **798 全绿**
- vite dev（浏览器 mock）+ headless Chrome CDP 真机冒烟：13 项交互断言全过
  （初始状态 / 无 Key 测试提示 / 添加弹层 / chips 一键添加 / Key 聚焦 /
  未保存 chip / 删除确认弹窗 / 删除后回落），零运行时错误

## P6 — 保存拆域 + 聊天面板模型切换（2026-08-08 完成）

> 用户反馈三点：① Provider 保存不应与全局设置共用一个事务；② 聊天面板左下角
> 模型按钮点开直接弹设置面板，不是真正的模型切换；③ 思考强度缺聊天面板入口。
> 用户明确拒绝自动保存（不接受其复杂度），故采用**手动、按域独立保存**。

### 保存拆域（Provider 独立保存）

- `SettingsPanel` 拆出 `providerDirty` 与全局 `dirty` 两条状态线。
- Provider 页所有变更走 `onCommitProvider`（只标 providerDirty），
  页内出现「有未保存的信号源更改 + 保存 Provider」保存条；
  Provider tab 下隐藏底部全局保存按钮。
- 全局保存（Agent / 显示等 tab）与 Provider 保存共用 `runSavePipeline()`
  （落盘 + 删暂存凭据 + 写新 Key + 重建 Agent）。落盘是全量的，
  因此任一保存成功后两个 dirty 标志一并复位，避免保存条/按钮残留假状态。
- 关闭确认按 dirty 组合给出不同文案；移除全局保存时空 Key/空模型的
  confirm 拦截（空 Key 是合法状态，如本地端点）。

### 聊天面板模型切换器（ModelSwitcher）

- 左下角模型徽章点击展开弹层（不再直接弹设置面板）：
  - 当前信号源模型列表（静态目录 + 动态模型，含推理/上下文/价格徽章）
  - 其他信号源一键切换（空模型自动带出 catalog 默认模型）
  - 思考强度：Anthropic 信号源 = effort 下拉（自动/低/中/高/极限/关闭）；
    OpenAI 兼容信号源 = 深度思考开关（全局 disableThinking）
  - 底部「管理 Provider…」进入完整设置
- 任何操作立即 `saveSettings` + `getOnSettingsSave()`（与设置面板保存同一重建链）。

### 验证（2026-08-08 实测）

- `npx tsc --noEmit` 0 错
- `npx vitest run` 全绿
- CDP 真机冒烟：Provider 页保存条出现/独立保存、聊天面板弹层展开/切模型/切信号源/思考强度

## P7 — 按词收敛：Protocol（2026-08-08 完成）

> 依据 CONTEXT.md「模型接入」词表的第一刀：把「协议」从字符串字面量与三份 `kindLabel`
> 拷贝中收敛出来。

- `provider/types.ts` 新增 `Protocol = 'anthropic' | 'openai'` 领域类型；
  `ProviderSettings.kind` / `ModelDescriptor.kind` 统一引用它。
- **存储键名 `kind` 保持不变**（localStorage 遗留名），只收类型与展示层；
  改存储键名需带迁移，见类型注释。
- `ui/react/settings/protocol.ts` 是协议标签唯一事实源（`PROTOCOL_LABELS` /
  `protocolLabel` / `isAnthropic`）；删除 ProviderList / ProviderDetail / ModelSwitcher
  三份 `kindLabel` 与 AddProviderSheet 内联三元。
- ModelSelector / ProviderDetail / AddProviderSheet 的 props 与 entry 类型统一为 `Protocol`。

### 验证

- `npx tsc --noEmit` 0 错
- provider/settings 相关 48 项测试全绿

## P8 — 按词收敛：ConnectionProbe（2026-08-08 完成）

> 依据 CONTEXT.md「ConnectionProbe」词条：把「测试连接」的三个表示
> （持久化结果 / UI 瞬时态 / 嵌入 provider 的结构拷贝）收敛为一套类型。

- `settings.ts`：`ProviderTestResult` 更名 `ConnectionProbe`，新增 `ProbeOutcome`；
  `ProviderSettings.lastTest` 字段名与存储形状不变（遗留名），仅类型统一。
- `ProviderDetail`：删除内联的 `lastTest` 结构拷贝（改为引用 `ConnectionProbe`）；
  `TestUiState` 更名 `ProbeUiState`，`phase` 类型基于 `ProbeOutcome`。
- `ProviderPage`：`tests` Map 与探针结果统一使用 `ProbeUiState` / `ConnectionProbe`。

### 验证

- `npx tsc --noEmit` 0 错，`ProviderTestResult` / `TestUiState` 零残留
- provider/settings 相关 48 项测试全绿

## P9 — 按词收敛：ProviderId（2026-08-08 完成）

> 依据 CONTEXT.md「ProviderId」词条：把 Provider 身份从裸 `string` 中救出来，
> 类型层面钉死「身份 = 系统凭据键 = 动态模型合并键」三合一语义。

- `CONTEXT.md` 新增 **ProviderId** 词条。
- `settings.ts`：`ProviderId`（branded string）+ `providerId()` 唯一构造入口；
  `ProviderSettings.name` / `AppSettings.activeProvider` / `removeSecret` /
  `addProvider` 全部类型化。运行时仍是 string，localStorage 存储键零迁移。
- `ProviderPage`：`tests` / `keyDirtyMap` / `keyVisibleMap` 从 `Record<string,…>`
  改为 `Map<ProviderId,…>`；`selected` / `delTarget` / `clearTarget` 类型化。
- `ProviderList` / `AddProviderSheet` / `ModelSwitcher` 身份相关 props 与 entry 类型化。
- `SettingsPanel`：`pendingDeletes` / `pendingClears` 改为 `ProviderId[]`。

### 验证

- `npx tsc --noEmit` 0 错
- provider/settings 相关 48 项测试全绿；全量 798 通过
- CDP 真机冒烟 8/8：tests Map / keyDirtyMap / keyVisibleMap / 添加 / 删除 / 保存条，零运行时错误

## P10 — 按词收敛：ThinkingPolicy（2026-08-08 完成）

> 依据 CONTEXT.md「ThinkingPolicy」词条：把「思考策略」的档位、标签与预算映射
> 收进单一模块，消除 ProviderDetail / ModelSwitcher 的选项重复与 anthropic.ts 的内联映射。

- 新增 `provider/thinking.ts`：`ThinkingEffort` / `ThinkingMode` / `StoredThinking` 类型、
  `THINKING_MODES`（档位 + 标签，唯一事实源）、`THINKING_EFFORT_BUDGETS`（档位 → token 预算）、
  `DEEP_THINK_LABEL`（全局开关文案）、`withThinkingDisabled`（全局开关对单 Provider 的生效语义）。
- `settings.ts` / `anthropic.ts`：`thinking` 字段类型收敛为 `StoredThinking`
  （含历史遗留数字预算）；存储字段名与形状不变。
- `anthropic.ts`：内联 effortMap 删除，改引 `THINKING_EFFORT_BUDGETS`。
- `provider/index.ts`：`disableThinking → 'off'` 的语义收口到 `withThinkingDisabled`。
- `ProviderDetail` / `ModelSwitcher`：选项列表改引 `THINKING_MODES`；两处「深度思考」文案统一用 `DEEP_THINK_LABEL`。

### 验证

- `npx tsc --noEmit` 0 错；档位文案零残留（只在 thinking.ts）
- provider/settings 相关 48 项测试全绿
- CDP 真机冒烟 11/11：保存拆域 + 聊天面板切换器 + 思考强度写入，零运行时错误

## P11 — 按词收敛：Vendor（2026-08-08 完成）

> 依据 CONTEXT.md「Vendor」词条：`ModelDescriptor.provider` 实际承载的是厂商
> （如 deepseek / anthropic），不是 Provider 实例——字段更名 `vendor`，语义钉死。

- `provider/types.ts`：`ModelDescriptor.provider` → `vendor`。
- 6 个 catalog JSON 的 `"provider"` 键全部改为 `"vendor"`（65 条目录条目；
  catalog JSON 是仓库数据而非用户存储，零迁移）。
- `catalog.ts`：`findModels` / `searchModels` 按 `vendor` 匹配；
  `getCatalogProviders` 更名 `getCatalogVendors`（返回厂商名）。
- `openai.ts` / `anthropic.ts` 的 `fetchModels` 描述符、`ModelSelector` /
  `ModelSwitcher` 排序过滤、`agent.ts` 摘要模型选择的 `keyed` 匹配全部改用 `vendor`。

### 验证

- `npx tsc --noEmit` 0 错；`getCatalogProviders` / `m.provider` 零残留
- provider/settings/摘要模型相关 51 项测试全绿；全量 798 通过
- CDP 真机冒烟 19/19：目录 chips 一键添加 / ProviderId 交互 / 聊天切换器 / 思考强度，零运行时错误
