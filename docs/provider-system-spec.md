# HoloGram Provider 系统设计定稿

> 生成：2026-08-07 · 状态：定稿基线（施工按本文档执行，改动需回写本文档）
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
| `SettingsPanel.tsx` (853 行) | 五 tab 设置面板 | ✅ 可用 |
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
| 11 | 主对话流无空闲超时 | **P1 新增**。参照 callSummaryLLM 60s idle 模式（agent.ts:2085） | agent.ts |
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
- [x] 主对话流空闲超时（agent.ts L1447：60s 无 chunk 视为挂起，自动中止并提示；外部 signal 只转发不直传）
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
- [ ] 摘要模型自动选择路径一轮（触发条件：多 provider 有 key）
- [ ] 设置保存 → provider 切换 → 旧会话继续（重建链验证项 #12）
