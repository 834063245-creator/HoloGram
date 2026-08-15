# 横向对比：HoloGram Browser CDP 套件 vs deepseek-harness web 能力族

> 生成：2026-08-15 · 方法：逐文件通读 + 双线并行子代理深挖（研究笔记见
> [`_cdp-hologram-notes.md`](./_cdp-hologram-notes.md) 与 [`_harness-web-notes.md`](./_harness-web-notes.md)），
> 主代理复核关键源码后合成。
>
> 对比对象：
> - **A 侧**：HoloGram `src-tauri/src/cdp*` + `src-ui/src/agent/tools/browser.ts`（HEAD `1593973` + 工作树第五批，即"刚刚落地的全套 CDP 系统"）。
> - **B 侧**：deepseek-harness `packages/web/` 六个包（`web` / `web-fetch-http` / `web-search-{exa,perplexity,deepseek}` / `tool-web`）——该仓库里最接近"browser 类"的系统实现。
>
> 引用格式：`文件:行`，A 侧相对 `HoloGram/`，B 侧相对 `deepseek-harness/`。

---

## 0. 结论先行

1. **两者不是同一平面的竞争品**。harness 全仓**没有任何 CDP/浏览器自动化实现**（playwright 仅出现在 `apps/web/package.json:45` 的 devDependency，用于前端 shell 的 e2e/性能测试，不是产品能力；`packages/web/` 六包零 CDP 依赖）。harness 的 web 能力族是**无状态 HTTP 检索层**（搜索 API 封装 + 单次 fetch），HoloGram 的 CDP 套件是**有状态浏览器自动化平台**。因此"横向对比"落在架构范式、安全哲学、模型工具契约、测试策略这些可比维度上，而非动作数 PK。
2. **规模与语言栈相反**：HoloGram 核心逻辑 ≈ 85% 在 Rust（生产 ≈3,976 行 + 测试/e2e ≈1,585 行 + 探针 JS 435 行 + TS 薄工具层 631 行），重运行时正确性；harness 全 TypeScript（src ≈2,903 行 + tests ≈3,082 行），重类型契约与插件化。
3. **安全哲学相反**：HoloGram 是**运行时人机共管**（L1-L3 权限分级 + 每次 Ask + 审计日志）；harness 是**部署期政策**（config 开关、超时/上限政策、SSRF 防护明确 deferred，文档明示"不要在有敏感内网可达的地方启用"）。
4. **模型契约哲学相反**：HoloGram 把 37 个 `browser_*` 收敛成模型可见的 **1 个领域工具** `browser`（工具数最小化）；harness 固定暴露 **2 个工具** `web_search`/`web_fetch`，但背后是 provider seam（provider 可换、schema 不动）。
5. **各自碾压对方的点**：harness 在"类型契约工程、截断/超时/abort 语义的精细度、测试行数≈源码行数"上强；HoloGram 在"真实浏览器端到端能力、事件观察通道、权限分级 + 审计、真实 Chrome e2e"上强（这些 harness 完全没有）。
6. **HoloGram 真正与 harness `tool-web` 对位的是自己的 `web` 域工具**（`web_fetch` 一个动作，search 已禁用），见 §13——那一段才是同平面比较，结论是 harness 的 fetch 链路细节远更完备，HoloGram 的 web_fetch 是简化版。

---

## 1. 规模与形态

| 维度 | HoloGram CDP 套件 | harness web 能力族 |
|---|---|---|
| 语言 | Rust 主体 + TS 工具层 + 4 个注入探针 JS | 纯 TypeScript（Node） |
| 生产代码 | Rust ≈3,976（transport 194 + session 1,751 + actions 1,955 + probes 31 + facade ~45）；TS 631 | ≈2,903（web 361 + fetch-http 476 + tool-web 902 + 三个 search 296-565） |
| 测试代码 | Rust ≈1,585（cdp.rs tests ~659 + e2e.rs 926）；TS 335 | ≈3,082（vitest spec + 少量 e2e） |
| 依赖 | `tokio-tungstenite`、`ureq`（自建 CDP 客户端，无现成自动化框架） | `turndown` + GFM 插件、平台 `fetch`、Cordis/schemastery（无浏览器依赖） |
| 组织 | 单仓库单模块（`src-tauri/src/cdp/` 四模块 + facade） | 六包三层 seam（Service Definition / Provider / Consumer） |
| 文档 | ADR 0003 + 3 份 plan（741 行） | 子系统参考 + Agent Note（~535 行）+ 双语 README |
| 状态 | 五批已落地，工作树第五批未提交；Windows e2e 未实跑 | 已实现；SSRF 明确 deferred |

形态一句话：HoloGram 是**竖切**（一套完整浏览器控制栈自建自养），harness 是**横切**（一个能力 seam 接多个可插拔后端）。

---

## 2. 架构分层对比

### 2.1 HoloGram：三层竖切 + 四模块横拆

```
LLM → browser 领域工具（browser.ts:90，37 个隐藏 browser_* 聚合为 1 个可见工具）
      │ agentInvoke（browser.ts:40-88）
      ▼
Tauri RPC（rpc.rs:396+ 每个 "browser_*" 分支）
      │ check_browser_permission（rpc.rs:64-84）→ BrowserTool 权限引擎
      ▼
Rust cdp 栈：cdp.rs（facade，cdp.rs:27-42）
      ├ transport.rs   HTTP /json + 命令 WS（短连接/批量）
      ├ session.rs     CdpSession / SESSIONS(agent+slot) / 租约 / observer / 审计
      ├ actions.rs     37 个动作的执行语义
      └ probes.rs      探针单一来源（include_str! 嵌入 content/inspect/report/snapshot 4 个 .js）
```

特点：**业务逻辑单点**（一个动作的 CDP 方法、超时、反馈全在 Rust 一侧）；TS 层是纯描述层。代价是 actions.rs 1,955 行仍是事实上的 god module（review-round2 §6 的 2,463 条耦合边只部分消化）。

### 2.2 harness：三层横切 seam

```
web_search / web_fetch 工具（tool-web，模型契约唯一拥有者）
      │ ctx.web.search() / fetch()
      ▼
WebRuntime（web/src/index.ts:74，ctx.web 服务）
      ├ registerSearchProvider / registerFetchProvider（web/src/index.ts:103-129）
      └ resolveProvider（web/src/index.ts:171-194，六分支执行期选择）
      ▼
providers：exa / perplexity / deepseek-official / http（fetch）
```

特点：**职责按"能力归属"切**——provider 注册**能力**而非工具（seam note `:25`），模型可见名字/schema/提示/presentation 全部归 tool-web 单一拥有。依赖方向严格单向（consumer → interface ← implementation，seam note `:45-54`），任何 provider 互换不触碰模型契约。

### 2.3 对比要点

- HoloGram 的"工具层"与"执行层"是 1:1 映射（nameMap 37 项）；harness 是 1:N（1 个工具 → N 个 provider → 执行期选 1）。
- HoloGram 的分层边界是**进程**（TS ↔ Rust 经 Tauri IPC）；harness 是**包**（同一进程内 Cordis effect-scoped 注册，HMR 可热卸载）。
- harness 用 `WebFetchBody` **封闭判别联合**（`web/src/types.ts:84-95`）+ 消费者 `assertNever`（`tool-web/src/fetch.ts:240-242`）把"新增能力"变成编译期协调改动；HoloGram 的新动作要手动同步五处（review-round2 §7.3 的纪律清单，靠文档与路由守护测试而非编译器）。

---

## 3. 传输与协议栈

| 维度 | HoloGram CDP | harness web |
|---|---|---|
| 协议 | CDP（HTTP `/json` + WebSocket 命令/事件） | HTTP(S) fetch |
| WS 库 | `tokio-tungstenite`（transport.rs:13） | 无 WS；平台 `fetch` |
| 命令通道 | 短连接：连 → 发 id=1 → 读到匹配 id → 关（`ws_command` transport.rs:78-134）；批量版 `ws_command_batch`（transport.rs:140-194，AX resolveNode 压到单次往返） | 单次请求；重定向手工跟随（`provider.ts:55-101`） |
| 事件通道 | attach 后**持久 WS 后台 task**（`start_observer` session.rs:459-603），订阅 Runtime/Log/Network/Page + 文件框拦截，环形缓冲 + `alive` 惰性重启 + 历史跨重启保留 | **无**（纯请求/响应，无事件流概念） |
| 超时 | 分层：WS 命令 10s（transport.rs:16）、`Runtime.evaluate` 5s（session.rs:32）、actionability 5s（session.rs:35）、导航轮询 2s/5s、HTTP `/json` 2-5s | 单层 `deadline` 30s 默认（provider.ts:46-53），外加工具级 `timeoutMs` 由 tool-call-timeout-policy 强制（tool-web/src/index.ts:71-90） |
| 进程控制 | spawn 受控 Chrome（session.rs:1207-1235）、connect 外部实例（session.rs:1318-1382）、kill 区分"杀进程 vs 只断开" | 无进程概念 |

关键差距：harness 没有事件观察能力（console/network/错误流），也没有"页面主线程卡死"这类需要 WS 全链路超时兜底的场景；HoloGram 的 `ws_command_batch`（为 AX 80 节点 160 次握手压到 1 次）这种 CDP 特有优化在 harness 无对应物。反过来，harness 的超时归属更精细：**provider 超时 vs 外部取消 vs 网络错误**用 `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')` 三分（provider.ts:235-239），HoloGram 的超时全部归并成同一条"CDP X 超时"错误。

---

## 4. 会话与状态模型

这是两边最本质的分野。

| 维度 | HoloGram | harness |
|---|---|---|
| 会话 | `CdpSession`（session.rs:623-675）：port/target_id/chrome_child/profile/slot/observer/租约；`SESSIONS` 键 = `agent + slot`（分隔符 `\u{1f}`，session.rs:693） | **无会话**。`WebFetchRequest` 只有 `url`（web/src/types.ts:63-65） |
| 多账号 | 具名 profile（`hologram-browser-profiles-<slot>`）+ `ACTIVE_SLOTS` + `switch_session`；被切走的 Chrome 不关、租约独立计时；cookie/登录态落在 Chrome 自有 `--user-data-dir` | 无。明示"carries no browser cookies or ambient credentials"（provider.ts:4） |
| 页面状态 | tab 管理（`/json/new` PUT、`/json/close`）、导航历史（back/forward）、attach/targets | 无；跨源重定向直接拒绝（`WEB_REDIRECT_BLOCKED`），每 origin 要新 tool call |
| 生命周期管理 | launch 复用校验（port/headless/windowSize/profile/proxy 形状一致才复用，session.rs:1093-1262）→ 空闲租约 10min 回收（`enforce_lease` session.rs:747-784）→ Chrome 崩溃 try_wait 检测 | 无（请求即弃；唯一跨请求保留物是渲染 memo 的 WeakMap，GC 即释放） |
| 并发 | 多 Agent 天然隔离；端口探测 16 个是隐性上限；锁序约定 SESSIONS→ACTIVE_SLOTS | `isConcurrencySafe: () => true`（tool-web/src/fetch.ts:478、search.ts:258），同一 session 内可并行调度 |
| 持久化 | 审计 jsonl 按日轮转 + profile/截图/HAR 目录保留 N 天清理 | 无（结果随 session log 走通用存储） |

harness 把一个设计限制做成了明确的安全特征：无状态 = 无泄漏面。HoloGram 把状态做成了产品能力（多账号/登录态/世界反馈），并为此付出租约、崩溃检测、profile 清扫（`sweep_stale_profiles` session.rs:103-129 还要防并发 launch 互删）等一整层运维代码。

---

## 5. 能力矩阵（动作对照）

HoloGram 37 个动作（§4 表见研究笔记）。harness 只有 2 个操作（search / fetch）。同口径对照：

| 能力 | HoloGram CDP | harness web |
|---|---|---|
| launch / connect / discover / kill | ✅（跨平台 find_chrome + 进程表 discover） | ❌ |
| navigate / back / forward / reload | ✅ | ❌ |
| tab 管理（new/close/切换） | ✅ | ❌ |
| snapshot + ref 交互范式 | ✅（AX 优先 + DOM 回退 + data-hg-ref 持久标记） | ❌ |
| 正文提取 | ✅ `content`（title/url/text/markdown-lite + 分页） | ⚠️ `web_fetch` 的 HTML→Markdown（turndown，无选择器 scope、无分页） |
| click / type / press / scroll / hover / select / upload / dialog | ✅ 全套 | ❌ |
| 截图 | ✅ fullPage + inline dataURL（3MB 上限） | ❌（二进制一律 `WEB_UNSUPPORTED_CONTENT_TYPE`） |
| 网络观察 | ✅ requestId 配对 + detail + HAR 1.2 导出（timing=-1） | ❌ |
| console / 错误观察 | ✅ | ❌ |
| cookie / profile / proxy / 多账号 | ✅（第五批） | ❌ |
| viewport emulation | ✅ `Emulation.setDeviceMetricsOverride` | ❌ |
| JS eval | ✅（静态白名单 + Ask，隔离 world 可选未做） | ❌ |
| 视觉 lint（对比度/间距/层级） | ✅ `report`（独有能力，report.js） | ❌ |
| 网页搜索 | ❌（web 域 search 已禁用，无后端） | ✅ 3 个 provider + 结构化 citations |
| 无头抓取 | ✅ 走浏览器（重） | ✅ 原生 fetch（轻，SPA 拿不到动态内容） |

harness 相对 HoloGram 多出来的只有"搜索"这一行；其余每行都是 HoloGram 单方面有。**功能覆盖不是一个量级**——但注意这不构成"harness 做得差"，因为 harness 的定位本来就是检索层而非浏览器层（§0.1）。

---

## 6. 快照 / 内容提取与 LLM 上下文管理

### 6.1 提取管线

- **HoloGram**：`snapshot` 双路径（AX 树优先，失败回退 `snapshot.js` 探针——可访问名称计算 / same-origin iframe 递归 / shadow DOM 穿透 / DOM 可推导 role，snapshot.js:53-115），对元素打 `data-hg-ref` 持久标记供 click/type/scroll 引用；`content` 探针输出 text / markdown-lite 双格式。
- **harness**：`web_fetch` 单路径——HTTP 响应体按 Content-Type 分类（html/text），turndown + GFM 转 Markdown，`script/style/noscript` 整体移除（tool-web/src/fetch.ts:25-31），自定义表格规则忽略 colspan 防扩张。

### 6.2 截断与分页

- **HoloGram**：多层静态上限——ref 条目 name/text 各 80（actions.rs:488-489）、snapshot 结果 8,000（actions.rs:545-549）、content 分页 maxChars 8,000/上限 20,000、console 300、network URL 200、cookie value 300、eval 4,000、TS 层再 8,000（browser.ts:32-37）；环形缓冲 console 200 / network 200 / error 100 / dialog 20 / file_chooser 20 / audit 500。**分页靠 offset 手动翻**。
- **harness**：三层 cap——provider 字节 5MB/字符 100k、工具源字符 200k、整体输出 200k，且**截断带指引 footer**（`(Content truncated. Fetch a more specific URL or section for the full text.)`，fetch.ts:247）；超大结果走通用 spill 落盘（模型只见预览 + locator，tool-web/tests/spill.spec.ts）。

### 6.3 对比要点

- HoloGram 的截断是**容量防御**（数字拼经验），harness 的截断是**语义化的**：`truncated` 从 provider 到 render 到 UI card 全链路一致（`fetchMetaFromValue` 保证 card 与模型所见文本永不分歧，fetch.ts:374-376），截断附"怎么拿全文"的指引，且渲染结果按 `(result, cap)` WeakMap memo 化避免 turndown 跑两遍（fetch.ts:284-300）。
- harness 对**恶意输入**有专门防线：HTML 嵌套深度 512 词法预扫描，超限/转换异常降级透传 raw（宁可给劣质文本也不挂事件循环，fetch.ts:94-243）；HoloGram 的探针跑在目标页面里，恶意页面是另一类威胁模型（靠权限 + 超时兜底）。
- HoloGram 的 `data-hg-ref` 打标是双刃剑：换来 ref 交互闭环，但污染页面 DOM（ADR 0003 D2 承认并接受）；harness 无此问题（根本不交互）。

---

## 7. 安全模型对比（哲学级差异）

| 维度 | HoloGram | harness |
|---|---|---|
| 总体范式 | **运行时人机共管**：权限引擎 + Ask 弹窗 + 审计 | **部署期政策**：config 开关 + 文档警告 + 明确的"不启用条款" |
| 分级 | L1 只读 Passthrough / L2 普通操作 attach 时批一次 / L3 敏感（submit、已填值框、下载、eval、cookie set/delete）每次 Ask（tools/mod.rs:205-258）；工具级 Deny 最高优先级，对 self 只读通道同样生效 | 无 per-action 分级；enablement 是 config 布尔（tool-web/src/index.ts:87-90），web 工具本身无任何审批代码 |
| 敏感目标识别 | 中英文高危文本共用同一正则源（Rust + 页面 JS，actions.rs:1707 起）+ 已填值/password 框检测 | 无对应物 |
| URL 边界 | 导航无域名白名单（靠会话级授权）；eval 静态字符串白名单（actions.rs:1868-1892，自认纵深防御非边界，actions.rs:1865-1867） | 协议白名单 http(s) + URL 长度 + **拒绝内嵌凭据**（policy.ts:24-41）+ 同源重定向约束 + 跳数上限 |
| SSRF / 私网 | 不适用（浏览器自己发起网络，走 --proxy 配置） | **明确 deferred**（policy.ts:18、provider.ts:6-8、README.md:49）：无私网/回环阻断、无 DNS-rebind 防护；文档直言"是 SSRF primitive，不得在有敏感内网可达处启用" |
| 凭据防泄漏 | connect 外部实例 Ask 文案明示登录态/Cookie 风险（tools/mod.rs:238-241） | 凭据型 URL 直接拒；凭据型 provider `redirect:'error'` 防重定向转发凭据（packages/web/AGENTS.md:5，deepseek/tests/redirect.spec.ts 用真实 server 证明目标未被联系） |
| 审计 | 全量写操作落 jsonl（agent/时间/动作/目标/结果摘要），按日轮转 + 保留天数可调，`browser(audit)` 可查（session.rs:894-935） | 无（只有 session log 的通用 tool result 记录） |
| 资源边界 | profile/截图/HAR 落 temp_dir，按前缀清理；slot 名清洗防路径穿越（normalize_slot_name session.rs:75-93） | 字节/字符/时间/跳数上限全套；`maxRedirects` 预算在跟随前检查（provider.ts:65-68） |

一句话：**HoloGram 的威胁模型是"Agent 会不会做坏事"，harness 的威胁模型是"网络目标会不会害我"**。两者互补而非冲突——harness 缺运行时审批（它把权限交给上层 guard 设施，web seam 本身无 gate），HoloGram 缺"恶意页面内容"级别的输入防御（它的输入防御全押在超时上）。

---

## 8. 错误处理与恢复

| 维度 | HoloGram | harness |
|---|---|---|
| 错误类型 | `Result<String, String>` 字符串错误，TS 层包 `[browser] {action} 失败: ...` | `WebError extends HarnessError`，**开放字符串 code**（types.ts:121-129），全仓 13+ code（子系统文档 web.md:128 全表） |
| 结构化程度 | 低：模型读的是人话字符串；无 code 可路由 | 高：模型读 message，hooks/UI/测试按 `error.info.code` 路由（core/tools/src/index.ts:641-647） |
| 超时区分 | 不分原因，统一超时文案 | provider 超时 / 外部取消 / 网络失败三分（provider.ts:235-239） |
| 重试 | 无自动重试；observer 惰性重启（历史保留） | 无自动重试（明确留给上层） |
| 进程级恢复 | Chrome 崩溃 try_wait 清句柄；租约回收；ref 失效给"请重新 snapshot"恢复指引（actions.rs:1243-1245） | 无（无进程） |
| 非 2xx 语义 | — | **是结果不是错误**（statusCode 进结果，web/src/index.ts:152） |
| 契约防漂移 | `probe_result_str` 契约 + `parse_world_value`（防 D5 数据通道静默失效回归）+ node --check 语法门 | 封闭联合 + `assertNever` 编译门 + `truncated` 语义单源 |

harness 的错误体系是教科书式的（分类、可路由、可扩展 code 空间）；HoloGram 的错误是实用主义的（字符串直传、模型可读、恢复指引内嵌）。值得注意：HoloGram 的字符串错误换来的是"错误里能直接塞恢复指引"（"页面已变化，请重新 snapshot"），harness 的 footer 式指引只出现在截断场景。

---

## 9. 模型工具契约

| 维度 | HoloGram | harness |
|---|---|---|
| 模型可见面 | **1 个领域工具 `browser`**（37 动作聚合，domains.ts:216-266），子命令语义全靠 description 承载 | **2 个工具** `web_search`/`web_fetch`，参数极小（query / url） |
| 参数设计 | 全量参数暴露给模型（含 port/headless/windowSize/profile/proxy 等运维参数） | **部署参数对模型隐藏**：timeout、maxResults、format、prompt 全部不给模型（tool-web 所有权，fetch.ts:79-90） |
| 超时归属 | 模型不可见；后端固定超时 | 双层：provider 资源兜底 30s + 工具 `timeoutMs` 由 policy 强制执行（模型不可见但由部署配置） |
| 并发安全 | 无显式声明（会话级串行天然） | `isConcurrencySafe: () => true` 显式声明（fetch.ts:478） |
| 结果呈现 | 字符串 + 8000 截断 | 结构化 result + `render` 文本 + `presentationMeta`（fetch card 可重放，meta 持久化进 session log） |
| schema 稳定性 | 新动作 = 改 5 处 + 路由守护测试 | provider 更换/增删对 schema 零影响；工具注册与 provider 可用性解耦（无 provider 也注册，执行期报结构化错误，seam note 核心决策） |
| 工具集大小 | 收敛最小化（37→1） | 固定 2（明确否决 per-provider 工具，seam note `:287-293`） |

两边在"模型不该看到什么"上选择了相反的裁剪方向：HoloGram 隐藏**工具数量**（收敛到领域动词），harness 隐藏**部署参数**（收敛到用户意图参数）。两条路都成立，但 harness 的"工具注册与后端可用性解耦"值得 HoloGram 借鉴：HoloGram 的 browser 工具在无 Chrome 环境下仍注册、执行期报错，这一点恰好一致（无 Chrome e2e 跳过 ≠ 工具消失）。

---

## 10. 测试体系

| 维度 | HoloGram | harness |
|---|---|---|
| 单元/契约 | Rust 单测（敏感文本、网络配对、AX 解析、HAR 形状、slot 校验、协议级 `/json/new` 本地 TCP 测试）+ node --check 探针语法门 + jsdom 探针行为测试 | vitest 高密度（tests ≈3,082 行 ≈ src 行数），本地 `node:http` server 起真网络，覆盖 policy 纯函数、重定向安全边界、abort 分类、memo、HMR 卸载 |
| 集成/e2e | **真实 Chrome e2e E2E-1~5**（926 行，无 mock transport），无 Chrome 自动跳过；固定端口 9444-9449 | 真实 API e2e 三个，**全部自跳过**（需 `$EXA_API_KEY` 等；deepseek 的 e2e 双重 skip——live endpoint 不可靠 merge 信号，body 保留只为"mock 无法确认 wire shape"） |
| 无环境保障 | 设计意图明确：e2e 跳过时由 jsdom 测试覆盖回退探针行为（browser-snapshot-probe.test.ts） | 设计意图明确：wire shape 靠录制 mock 断言，不靠 live 验证 |
| 已知欠账 | Windows 真机 E2E-1~5 未实跑；全量 cargo test 8 个历史环境失败 | 真实 API e2e ≈ 零覆盖 |

两边对"CI 无真实依赖"的应对都是"跳过 + 降级保障"，但方向相反：HoloGram 的 e2e 是真浏览器真页面（零网络依赖的本地 file:// 页 + 本地 HTTP server），**只缺 Windows 机器**；harness 的 e2e 是真 API 但**根本没跑过**。HoloGram 的 e2e 资产明显更重、更真实。

---

## 11. 扩展点

| 维度 | HoloGram | harness |
|---|---|---|
| 扩展方式 | 代码内加动作（5 处同步纪律） | 包级插件：实现 provider 接口 + `registerXxxProvider`（disposer 随 fiber 卸载，HMR 安全） |
| 新后端成本 | 无 provider 概念；换浏览器引擎（Edge/Electron）靠 `find_chrome` 路径 + connect 兼容 | 照抄 provider 模式即可，**不改 dsh-web、不改 tool-web**；新 code 空间开放 |
| 编译期强制 | 无（靠文档纪律 + 测试守护） | `WebFetchBody` 封闭联合：新增 body kind 是跨包编译强制协调改动（web/README.md:60） |
| 明确非扩展点 | — | provider 不得暴露工具 schema；模型工具名固定 2 个 |

harness 的 seam 是可插拔架构的正面范例：选择语义（含 `WEB_PROVIDER_AMBIGUOUS` 拒绝 first-wins、`available()` 禁网络调用）把"多实现共存"的坑全部提前堵死。HoloGram 没有这个需求（单一 CDP 后端），但将来若想支持 Playwright 通道或远程浏览器，harness 的注册表模式是现成参照。

---

## 12. 双向可借鉴清单

### 12.1 harness 值得 HoloGram 学的

1. **结构化错误 code**：`Result<String,String>` → 结构化 `{code, message}` 可路由错误，模型读 message、测试/UI 路由 code（现在 vitest 只能断言字符串前缀）。
2. **截断的语义完整性**：`truncated` 全链路单源 + "怎么拿全文"指引 footer + 恰好到 cap 不误报（provider.ts:177-185）——HoloGram 目前每层各截各的、无 footer、无单源标志。
3. **部署参数与模型参数分离**：timeout/maxResults 归 config 不归 schema（HoloGram 的 port/headless 等运维参数是否也该对模型隐藏，值得复议）。
4. **渲染 memo + presentationMeta 重放契约**：fetch card 与模型所见文本永不打架；HoloGram 的 UI 审计面板目前自己另查数据。
5. **`available()` 廉价检查 + 执行期解析**：把"后端可用性"从工具注册解耦，避免 HMR/凭据时序影响 schema。
6. **恶意输入防御**：HTML 深度预扫描 + 降级优先于报错——HoloGram 的 content/snapshot 探针面对恶意页面只有超时兜底。

### 12.2 HoloGram 值得 harness 学的

1. **有状态会话 + 多账号 slot 模型**：若 harness 将来做浏览器层，`agent+slot` 键控 + 具名持久 profile + 被切走不关机的租约独立计时，是可直接抄的成熟设计。
2. **L1-L3 运行时权限分级 + 审计**：web 工具的"是否允许"目前在 harness 是部署布尔；要做 per-URL/per-动作的运行时审批，HoloGram 的分级 + Ask 文案写实 + jsonl 审计是现成范本（尤其敏感动作二次确认与中英文高危文本同源正则）。
3. **真实依赖的 e2e**：E2E-1~5 用"真实 Chrome + 本地 file:// 页 + 本地 HTTP server"证明了一条零外网依赖的 e2e 路线，比 harness 的自跳过 e2e 实诚得多。
4. **事件观察通道**：持久 WS + 环形缓冲 + alive 惰性重启 + 历史跨重启保留，是"观察世界变化"的基础设施——harness 的 fetch 完全无观察面（seam note 明确放弃了 observation surface）。
5. **错误即恢复指引**：ref 失效返回"请重新 snapshot"而不是裸错误——错误类型里内嵌 next action，比 code 路由更进一步。

---

## 13. 同平面直接对位：HoloGram `web` 域 vs harness `tool-web`

两者各自真正的"检索层"：

| 维度 | HoloGram web_fetch（coding.ts:519-528） | harness web_fetch（tool-web/src/fetch.ts） |
|---|---|---|
| 参数 | 仅 url | 仅 url（一致） |
| 超时 | 15s（描述声明） | provider 30s 兜底 + 工具 policy 层 30s |
| 大小上限 | 1 MiB（描述声明） | 字节 5MB / 字符 100k / 输出 200k 三层 |
| 提取 | "scripts、styles、tags stripped"的简化可读文本 | turndown + GFM 表格 + 512 深度防护 + 降级透传 |
| 编码 | 未声明 | charset 显式处理，不识别即报错不 mojibake |
| 重定向 | 未声明 | 同源跟随（≤5 跳）+ 跨源拒绝 + 逐跳重校验 |
| 截断指引 | 无 | 有 footer + truncated 全链路标志 |
| 搜索 | 禁用（2026-07，无后端；代码骨架保留） | 3 个 provider 全活 |
| 工具注册 | 旧工具隐藏、领域工具 `web` 可见（domains.ts:162-167） | `ctx.tools.register` + systemPrompt 段 |

结论：同一能力，harness 的实现深 2-3 个数量级（编码/重定向/截断语义/安全边界全有断言），HoloGram 的是能用的简化版且搜索已禁用。**如果用户要"把 web 检索补强"，harness 的 fetch.ts + policy.ts 是照抄级参考**。

### 13.1 当前 dsh 部署的实际接线（2026-08-15 实测）

- host 平面（`packages/bundle/base/cordis.patch.yml:404-418`）：挂 `dsh-web`（`searchProvider: deepseek-official`）+ `dsh-web-search-deepseek`（`apiKeyEnv: DEEPSEEK_API_KEY`）+ `dsh-tool-web`（**`fetch: false`**、`searchTimeoutMs: 60000`）。
- agent 平面（`apps/cli/config/agent-presets/standard/agent.cordis.yml` 尾部 `tool-web` 行）：`fetch: false`、`searchTimeoutMs: 60000`。
- 结果：模型可见 web 工具**只有一个 `web_search`**，后端 = DeepSeek 原生服务端搜索（Anthropic Messages 端点 + `web_search_20250305`，检索发生在 DeepSeek 服务器端，harness 只发一次 Messages 请求）。`web_fetch` 被显式关闭，且 base bundle 注释写明理由（cordis.patch.yml:399-403）："that provider defers SSRF protection and the model would choose the request target"——即 SSRF 防护没做、不敢把自选 URL 的抓取能力交给模型。这解释了"dsh 的 browser 工具集"的完整来源：**没有浏览器、没有 CDP，只有一条搜索 API 封装**。

---

## 14. 各自弱点（诚实清单）

**HoloGram CDP 套件**：
- actions.rs 1,955 行单文件仍是 god module（review-round2 §6 的耦合债只消化了一半；session.rs:5-6 头注释已过时）。
- Windows 真机 e2e 未验证；Linux 8 个历史环境失败未清（非本套件）。
- 错误全是字符串，无 code，测试只能断言前缀。
- eval 白名单自认纵深防御；隔离 world 未做。
- 截图默认只回路径（vision 模型多一跳）；HAR timing 全 -1。
- 无 URL 域名白名单——安全性押在会话级授权上。

**harness web 族**：
- SSRF 防护**完全没有**，且是产品文档自认的 primitive（这是最大的洞）。
- 无任何浏览器能力（用户若预期它能"操作网页"，会完全失望）。
- 真实 API e2e 全跳过，wire shape 无 live 验证。
- exa/perplexity 的 abort 判定是 error-shape 型，带 reason 的 abort 会误报（各自 README 承认）。
- 无重试、无缓存、无观察面——都是"留给上层"的显式空白。

### 14.1 收口记录（2026-08-15，同日落地）

借鉴清单中今天可落地的部分已收口，全部测试绿后分批提交：

| # | 项 | 状态 | 提交 |
|---|---|---|---|
| 1 | 结构化错误 code：`cdp/errors.rs` 统一 `[CODE]` 前缀（13 个 code），transport/actions/session/probes 关键错误点全部转换；TS `parseBrowserError` 解析，模型读人话 message、测试按 code 断言 | ✅ 已落地 | `4ea88eb` |
| 2 | 截断语义收口：`cdp_console`/`cdp_network` 补 `truncated` 标志；TS 8000 截断 footer 给翻页指引（offset/maxResults/limit） | ✅ 已落地 | `4ea88eb` |
| 3 | web_fetch 补强：encoding_rs 按声明 charset 解码（GBK 不再整页报错）、读 cap+1 区分真截断（修恰好 1 MiB 假阳性）、输出 header+footer 对齐 harness；新增单测 | ✅ 已落地 | `f3ed688` |
| 4 | cdp 模块过时注释清扫（session.rs 头注释"actions 仍留在 cdp.rs"已过时） | ✅ 已落地 | `4ea88eb` 内 |

**明确不做的（附理由）**：

- **部署参数与模型参数分离**（§12.1-3）：harness 是部署期政策模型（多租户、产品定配置），HoloGram 是单用户桌面应用，模型自己控制 launch 形态（headless/windowSize/profile/proxy）是产品能力不是风险面。仅有的运维参数 `port` 保留给高级用法，不改。
- **渲染 memo + presentationMeta 重放契约**（§12.1-4）：HoloGram 的工具结果是字符串、UI 审计面板走事件总线订阅，无"双渲染点打架"问题；harness 的 memo 是为了喂它的 card 重放体系。等 UI 层引入结构化结果卡再引入，现在做是过度设计。
- **actions.rs 进一步拆分**（§14 弱点）：1955 行仍有 god module 味道，但今天动它违反 review-round2 §6 的"禁止一批同时改传输层和工具面"小步纪律；留给下窗口专项。
- **Windows 真机 E2E-1~5**：无 Windows 环境，保持跳过并记录为已知未验证项。
- **eval 隔离 world**：维持"可选未做"（ADR 0003 既定结论）。

**验证基线（本机 Linux）**：`cargo test cdp::` 35/35 ✅；`cargo test commands::web` 3/3 ✅；`npx tsc --noEmit` ✅；vitest（browser-tools/browser-snapshot-probe/domains-convergence/define-tool）57/57 ✅；`commands::shell` 4 个失败为历史 bwrap 沙箱环境失败（review-round2 §5 基线），与本次无关。

---

## 15. 附录

### 15.1 行数总表

| 侧 | 生产 | 测试/e2e | 探针/其他 |
|---|---|---|---|
| HoloGram CDP | Rust ≈3,976 + TS 631 | Rust ≈1,585 + TS 335 | 探针 JS 435、文档 741 |
| harness web | TS ≈2,903 | TS ≈3,082 | 子系统文档/Agent Note ≈535 |

### 15.2 关键文件索引

- A 侧：`src-tauri/src/cdp/{transport,session,actions,probes,e2e}.rs`、`src-tauri/src/cdp.rs`、`src-tauri/src/rpc.rs`（browser 分支）、`src-tauri/src/tools/mod.rs`（BrowserTool）、`src-ui/src/agent/tools/browser.ts`、`src-ui/src/agent/tools/domains.ts`、`docs/adr/0003-agent-browser-cdp-suite.md`、`docs/plans/browser-cdp-suite-review-round2.md`
- B 侧：`packages/web/web/src/{index,types}.ts`、`packages/web/web-fetch-http/src/{provider,policy}.ts`、`packages/web/tool-web/src/{fetch,search,index}.ts`、`packages/web/web-search-*/src/provider.ts`、`.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md`、`docs/subsystems/web.md`

### 15.3 方法学说明

- 双线并行子代理逐文件通读并落盘笔记（本文件同目录 `_cdp-hologram-notes.md`、`_harness-web-notes.md`），主代理通读两侧核心源码（ADR/plan、transport.rs、session.rs 头部、actions.rs 函数清单、rpc.rs 权限分支、tools/mod.rs BrowserTool、browser.ts、e2e.rs 头部、web/src/index.ts、web-fetch-http/{provider,policy}.ts、tool-web/{fetch,search,index}.ts、web-search-exa/provider.ts、seam note）复核后合成。
- 所有引用为撰写时的文件状态；HoloGram 第五批（cookies/profile/proxy/多账号）在工作树未提交，harness 侧无未提交依赖。
