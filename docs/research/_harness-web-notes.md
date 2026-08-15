# Harness Web 能力族研究笔记（deepseek-harness / packages/web）

> 生成对象：`/home/jingjianhua/deepseek-harness` 仓库 `packages/web/` 整个目录树。
> 用途：供主代理做横向对比（相对 CDP 浏览器自动化套件）。
> 所有 `file:line` 引用均相对 `/home/jingjianhua/deepseek-harness/`。

## 0. 结论先行：无 CDP 浏览器自动化（已确认）

本仓库 **没有任何 CDP / chrome-remote-interface / puppeteer / selenium 浏览器自动化实现**。

- 全仓 `.ts` 文件里唯一的浏览器自动化相关符号是 `playwright` 与 `CDPSession`，且全部位于 `apps/web/` 的 **e2e/perf 测试**里（如 `apps/web/tests/chat-scroll-contract.e2e.ts:8-9`、`apps/web/tests/complex-history.perf.ts:9` 用 `chromium` 和 `CDPSession` 做 UI 回归 + 性能采样）。
- `playwright` 只出现在一个 `package.json`：`apps/web/package.json:45`（`"playwright": "^1.49.0"`，**devDependency**），用于驱动前端 shell 的浏览器测试，不是产品能力。
- 全仓 `package.json` 中没有 `puppeteer`、`chrome-remote-interface`、`selenium`（grep 只命中 playwright）。
- `packages/web/` 六个包内 **零** playwright/CDP 依赖，无任何 `import { chromium }`、`page.goto`、`newCDPSession` 等自动化代码。

因此：web 能力族 = 「HTTP fetch + 搜索 API 封装」，是**无状态单次网络请求**模型，与「浏览器类系统」（页面会话/DOM/JS 执行/截图）是两类东西。

---

## 1. 架构：provider seam（ctx.web）设计

### 1.1 三层包拓扑（Service Definition / Provider / Consumer）

`packages/web/README.md:7-14` 给出六个包的角色：

| 包 | 角色 | 注册键 |
|---|---|---|
| `web/` (`@deepseek-ai/dsh-web`) | 服务定义：`WebRuntime`、provider 注册表、选择策略、请求/结果词汇、`WebError` 体系 | `ctx.web` |
| `web-search-exa/` | 搜索 provider：Exa | 注册进 `ctx.web` |
| `web-search-perplexity/` | 搜索 provider：Perplexity | 注册进 `ctx.web` |
| `web-search-deepseek/` | 搜索 provider：DeepSeek 原生（Anthropic Messages + web_search 工具） | 注册进 `ctx.web` |
| `web-fetch-http/` | fetch provider：匿名公共 HTTP(S) | 注册进 `ctx.web` |
| `tool-web/` (`@deepseek-ai/dsh-tool-web`) | 消费者：模型可见的 `web_search` / `web_fetch` 工具 | `ctx.tools` |

依赖方向（`.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md:45-54`）：
```
dsh-tool-web  --depends on-->  dsh-web  <--depends on--  dsh-web-search-{exa,perplexity,deepseek}
   consumer                   interface                    implementation
                                                       <--depends on--  dsh-web-fetch-http
```

关键设计决策：**providers 注册「能力」，不注册「工具」**。模型可见的名字/描述/schema/提示/presentation 全部由 `tool-web` 单一拥有（`packages/web/web/README.md:27`、seam note `:25`）。这避免了「每个 provider 自己暴露工具 schema」和「把 provider 调度塞进 tool 包」两种反模式（seam note `:287-301`）。

### 1.2 `WebRuntime` 服务（`ctx.web`）

- `packages/web/web/src/index.ts:74` 声明 `class WebRuntime extends Service`，注册名 `'web'`。
- Cordis 类型增强 `ctx.web: WebRuntime`（`web/src/index.ts:35-39`）。
- 两个 `Map` 私有注册表：`searchProviders` / `fetchProviders`（`web/src/index.ts:85-86`）。
- 注册 API（`web/src/index.ts:103-129`）：`registerSearchProvider` / `registerFetchProvider`，重复 id 抛 `WEB_DUPLICATE_PROVIDER`；用 `ctx.effect()` 包裹使注册随 fiber 卸载（HMR 安全，返回 disposer）。
- 执行 API：`search(request, signal?)`（`web/src/index.ts:140-147`）、`fetch(request, signal?)`（`web/src/index.ts:157-163`）。`search()` 执行完会调用 `capSources()` 强制 `maxResults`（`web/src/index.ts:196-200`）。

### 1.3 注册/选择机制（执行期解析，永不依赖注册顺序）

`resolveProvider()`（`web/src/index.ts:171-194`）实现六分支选择，语义见 `web/src/index.ts:62-73` 与 `web/README.md:29-42`：

| 情形 | 行为 |
|---|---|
| configured id 已注册且 `available()` | 运行该 provider |
| configured id 未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
| configured id 已注册但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配置，恰好一个可用 provider | 自动选择 |
| 未配置，多个可用 provider | `WEB_PROVIDER_AMBIGUOUS`（拒绝 first-wins） |
| 未配置，无可用 provider | `WEB_PROVIDER_UNAVAILABLE` |

- 配置来源：`WebRuntimeConfig.searchProvider/fetchProvider`，或等价环境变量 `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER`（`web/src/index.ts:80-94`）。seam note `:152` 强调环境变量走同一条显式路径，「不是隐藏优先级链」。
- provider 的 `available(): boolean` 必须是**廉价本地检查**（凭据存在、配置可解析），**禁止网络调用**（`web/src/types.ts:103-105`、`web/README.md:42`、seam note `:109`）。
- `tool-web` 永不调用 `available()`，只走 `ctx.web.search()/fetch()` 并按抛出的 code 路由（`tool-web/README.md:42`），保证选择策略单一所有者。
- 无观测面：没有 registry-change 事件、无能力状态查询（`web/README.md:58`、`web/src/invariant.ts:17-21`）。

### 1.4 provider-neutral 错误类型 `WebError`

- `packages/web/web/src/types.ts:129`：`export class WebError extends HarnessError {}`（继承 `@deepseek-ai/dsh-llm` 的 `HarnessError`）。
- `code` 是**开放式字符串**（不是封闭联合），provider 可自增 code 而无需改 `dsh-web`（`types.ts:121-128`、`docs/subsystems/web.md:128`）。
- 完整 code 分类见 §6。

---

## 2. 能力面

### 2.1 search 有哪些 provider

三个搜索 provider，各自稳定 id（provider.ts 中定义）：

1. **Exa** — `id='exa'`（`web-search-exa/src/provider.ts:19`）。`POST {base}/search`，`type` 检索模式 `auto|keyword|neural`，`contents.highlights.highlightsPerUrl` 请求高亮句；把首个非空 highlight 映射为 `snippet`，`publishedDate→publishedAt`，无高亮的结果整条丢弃（`provider.ts:56-65`）。`content` 恒缺省（Exa 无生成答案）（`provider.ts:74-81`）。
2. **Perplexity** — `id='perplexity'`（`web-search-perplexity/src/provider.ts:19`）。`POST {base}/chat/completions`（OpenAI 兼容 shape，但**不用** `ctx.llm`）；`choices[0].message.content→content`（生成答案），`sources` 优先结构化 `search_results[]`、缺省退化为 URL-only `citations[]`（`provider.ts:73-83`）。无结果数控制 → `maxResults` 由 seam 事后截断。
3. **DeepSeek 原生** — `id='deepseek-official'`（`web-search-deepseek/src/provider.ts:27`）。Anthropic-compatible Messages API `POST {base}/messages`，启用原生 `web_search_20250305` 服务端工具（`provider.ts:197-218`）；解析结构化 `web_search_tool_result` 块 + 从 text 块的 `citations[].cited_text` 拼接 snippet，按 url 去重（`provider.ts:121-174`）。**严格模式**：无 `web_search_tool_result` 块即抛 `WEB_PROVIDER_ERROR`，绝不从模型散文里刮 URL（`provider.ts:150-155`、`README.md:13`）。

三者共同点：`fetch(..., { redirect: 'error' })` — 凭据型请求**拒绝跟随任何重定向**（exa `provider.ts:103`、perplexity `provider.ts:106`、deepseek `provider.ts:224`），这是 `packages/web/AGENTS.md:5` 的硬性规则（重定向不得把凭据/请求数据转发到另一 origin）。

### 2.2 fetch 的实现细节（`web-fetch-http`）

provider id = `'http'`（`web-fetch-http/src/provider.ts:33`）。`available()` 恒 `true`（匿名公共 fetcher，无凭据）（`provider.ts:41-44`）。

**HTTP client**：平台原生 `fetch`，`method:'GET'`，`redirect:'manual'`（手工跟随重定向）（`provider.ts:103-110`）。无第三方 HTTP 库。

**请求头**：显式产品 UA `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)`（`index.ts:25`），`accept` 收窄到 `text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8`（`provider.ts:108`）。明确「从不伪装浏览器」。

**重定向**：`followAndRead()`（`provider.ts:55-101`）循环——只跟随**同源**重定向（`isSameOrigin`，scheme+hostname+port 三者全同，`policy.ts:52-54`）；跨源抛 `WEB_REDIRECT_BLOCKED` 要求新的 tool call；重定向目标会重新过 `validateFetchUrl`（含凭据、非 http(s)、超长再校验）（`provider.ts:80-88`）；跳数上限 `maxRedirects` 默认 5（`provider.ts:65-68`）。重定向状态码：301/302/303/307/308（`provider.ts:211-213`）。

**超时**：`deadline(signal, timeoutMs, 'WEB_FETCH_TIMEOUT')`（`@deepseek-ai/dsh-timeout`），一个 signal 同时管请求与 body 读（`provider.ts:46-53`）。`timeoutMs` 默认 30_000ms，是「资源兜底」而非模型可见 tool-call 预算——后者由 `dsh-tool-call-timeout-policy` 持有（`web-fetch-http/README.md:13-15`）。超时 vs 外部取消的区分通过 `timeoutOf()` 恢复 `TimeoutReason` 判定（`provider.ts:235-239`）。

**大小限制**（`index.ts:49-56` 默认值，`provider.ts:155-207` 强制）：
- `maxUrlLength` 2048（URL 字符串长度上限，`policy.ts:24-27`）。
- `maxResponseBytes` 5_000_000：`Content-Length` 声明超限 → 立即 `WEB_FETCH_TOO_LARGE`；流式超限 → 截断并 `truncatedByBytes=true`（`provider.ts:155-186`）。
- `maxBodyChars` 100_000：解码后字符截断（`provider.ts:137-138`）。
- 恰好到 cap 不判 truncated（`provider.ts:177-185`）。

**内容分类与解码**：`classifyContentType()`（`policy.ts:65-71`）——`text/html`/`application/xhtml+xml`→`html`；`text/*` + `application/json|xml` + `*+json|*+xml`→`text`；其余（二进制）→ `WEB_UNSUPPORTED_CONTENT_TYPE`。charset 只来自 `Content-Type` 头（HTML `<meta charset>` 被忽略），默认 UTF-8，`TextDecoder` 不识别 → 抛错而非 mojibake（`policy.ts:83-104`、`README.md:51`）。body 返回 `WebFetchBody` 封闭判别联合 `html | text`（`web/src/types.ts:93-95`）。

### 2.3 HTML→Markdown 转换库

**是 `turndown`**，且带 GFM 插件：

- `tool-web/src/fetch.ts:9-10`：`import TurndownService from 'turndown'` + `@joplin/turndown-plugin-gfm` 的 `gfm`。
- 配置：`headingStyle:'atx'`, `codeBlockStyle:'fenced'`, `bulletListMarker:'-'`（`fetch.ts:25-29`）；`remove(['script','style','noscript'])`（`fetch.ts:31`）。
- 自定义 GFM 表格规则（`fetch.ts:34-77`）——**忽略 `colspan`**（GFM 无跨列表示，防止从不可信数字属性扩张输出）。
- 深度防护：`MAX_CONVERSION_DEPTH = 512`（`fetch.ts:102`），`exceedsConversionDepth()` 单遍词法扫描（`fetch.ts:138-205`）——深嵌套/歧义 HTML 直接**原文透传**（降级优先于报错，`fetch.ts:224-243`）；turndown 抛异常也降级为 raw HTML（`fetch.ts:232-237`）。
- 转换是**同步**、在事件循环上运行，因此有源字符上限 `fetchMaxOutputChars`（默认 200_000）先切片再转（`fetch.ts:225`）。

### 2.4 content 截断策略（双层）

1. **provider 层**（采集侧）：`maxResponseBytes` 字节截断 + `maxBodyChars` 字符截断，`WebFetchResult.truncated` 表示 provider 截断（`web-fetch-http/src/provider.ts:135-146`）。
2. **tool 层**（呈现侧）：`renderBody` 先把源切到 `maxOutputChars`（`fetch.ts:225`），`computeFetchOutput` 再对「header + 渲染 body + footer」整体二次截断并追加 footer `(Content truncated. Fetch a more specific URL or section for the full text.)`（`fetch.ts:247,310-319`）。`renderFetchOutput` 用 `WeakMap` 按 `(result, cap)` memo 化，保证 registry 的 `render`+`presentationMeta` 双调用只跑一次 turndown（`fetch.ts:284-300`）。

---

## 3. 安全（SSRF 防护现状）

### 3.1 结论：SSRF / 私网防护**未实现，明确 deferred**

多处权威确认：

- `web-fetch-http/src/provider.ts:6-8`（文件头）："Private-network and SSRF protection is not implemented; do not enable this provider where it can reach sensitive internal targets."
- `web-fetch-http/src/policy.ts:18`："SSRF / private-network blocking is deferred — see the package Agent Note."
- `web-fetch-http/README.md:49`：SSRF / 私网防护 deferred —— **无**私网/回环/链路本地/组播/非公网目标阻断，**无** DNS-resolve-then-validate，**无** per-hop 再校验；"Until it lands, this provider is an SSRF primitive and must not be enabled…"。
- seam note `:327`：正确实现需要 DNS-resolve-then-connect-to-validated-IP（防 DNS rebinding / TOCTOU）+ 每跳重校验 + IPv6 边界（私网段、IPv4-mapped）；「是 harness 唯一的 SSRF 防线，值得专门 spike」。
- `docs/subsystems/web.md:132`："The local backend does not block private-network targets; do not enable `web_fetch` where it can reach sensitive internal ones."

### 3.2 已实现的「基础传输卫生」（`validateFetchUrl`，`policy.ts:24-41`）

| 限制 | 实现 | 错误码 |
|---|---|---|
| 协议白名单 | 仅 `http:` / `https:` | `WEB_INVALID_URL` |
| URL 长度 | `maxUrlLength`（2048） | `WEB_INVALID_URL` |
| URL 内嵌凭据 | 拒绝 `user:pass@` | `WEB_BLOCKED_URL` |
| 重定向跳数 | `maxRedirects`（5） | `WEB_REDIRECT_BLOCKED` |
| 跨源重定向 | 拒绝（同源才跟随） | `WEB_REDIRECT_BLOCKED` |

即：**有协议白名单、有凭据拒绝、有长度/字节/字符/时间/跳数上限、有同源重定向约束**；但**没有端口黑名单、没有私网/回环 IP 阻断、没有 DNS rebinding 防护**。端口未做任何限制——`isSameOrigin` 只比较端口是否相等，从不拒绝任何端口（`policy.ts:52-54`）。

### 3.3 凭据型 provider 的重定向策略（独立安全面）

`packages/web/AGENTS.md:5` + exa/perplexity/deepseek 三个 provider 的 `redirect:'error'`：凭据型请求在接触重定向目标前失败（`WEB_PROVIDER_ERROR`），防止自动把凭据/请求数据转发到别的 origin。`web-search-deepseek/tests/redirect.spec.ts:52-67` 用真实 HTTP server 证明重定向目标从未被联系到。

---

## 4. 工具暴露（`tool-web` → `ctx.tools`）

### 4.1 工具名与 schema

两个工具，由 `defineTool()` 注册到 `ctx.tools`（`tool-web/src/search.ts:224-273`、`tool-web/src/fetch.ts:436-494`）：

**`web_search`**（`search.ts:224-226`）
- 描述：`Search the web for current information. Returns an optional summary answer and a list of source URLs.`
- 参数 schema：仅 `{ query: string (required) }`（`search.ts:227-229`）。**`max_results` 不是模型参数**——由 `searchMaxResults` config（默认 8）持有，作为 `maxResults` 塞进 seam 请求（`search.ts:262`、`WEB_SEARCH_MAX_RESULTS=8` at `search.ts:20`）。
- 输出 schema（`search.ts:230-252`）：`{ content?: string, sources: [{url,title?,snippet?,publishedAt?}], truncated: boolean }`。

**`web_fetch`**（`fetch.ts:436-438`）
- 描述：`Fetch the content of a specific HTTP(S) URL and return it decoded to text.`
- 参数 schema：仅 `{ url: string (required) }`（`fetch.ts:439-441`）。**无 `format`/`prompt`/`timeout` 参数**。
- 输出 schema（`fetch.ts:442-472`）：`{ url, statusCode, body: oneOf(html|text), truncated }`。

两个工具都：
- `isConcurrencySafe: () => true`（provider 读不改变父 agent 状态，可并行调度）（`search.ts:258`、`fetch.ts:478`）。
- `timeoutMs` = config `searchTimeoutMs`/`fetchTimeoutMs`（默认 30_000），由 `dsh-tool-call-timeout-policy` 强制（`index.ts:26-27`、`index.ts:71-90`）。
- 执行时把 `exec.signal` 直接透传给 `ctx.web.search()/fetch()`（`search.ts:261-264`、`fetch.ts:481-484`）。

### 4.2 工具如何被模型调用（注册链路）

- `tool-web` 插件 `inject: ['tools', 'web', 'systemPrompt']`（`tool-web/src/index.ts:24`）。
- `apply()`（`index.ts:80-90`）按 `search`/`fetch` config 布尔（默认 true）分别调 `applyWebSearchTool` / `applyWebFetchTool`。
- 每个 `applyWebXxxTool` 做两件事：(1) `ctx.systemPrompt.section(...)` 注册提示段（`search.ts:216-222`、`fetch.ts:430-434`）；(2) `ctx.tools.register(defineTool({...}))`（`search.ts:224`、`fetch.ts:436`）。
- `ctx.tools` = `ToolRuntime`（`packages/core/tools/src/index.ts:137-140` 类型增强 `Context.tools`）。`ToolRuntime.register()`（`core/tools/src/index.ts:1037-1062`）校验 `output{ schema, render, presentationMeta? }` 后写入 scoped layers，返回 disposer。
- 模型可见 schema 由 `schemas()` 白名单只含 `name/description/parameters`（`core/tools/src/index.ts:255` JSDoc）；`timeoutMs`/`isConcurrencySafe` 等**永不**发给模型。
- 失败如何回模型：`ToolRuntime.execute()` 把 `WebError`（`HarnessError` 子类）转成错误 tool result，`error.info.code` 携带结构化 code（`core/tools/src/index.ts:641-647` `errorInfo`；seam note `:279`）。

### 4.3 结果格式化与 LLM 上下文优化

**search 结果**（`search.ts:54-75`）：可选 `content` 答案 + `Sources:` markdown 列表（`- [title|hostname](url) — snippet (publishedAt)`，标题缺省回退 hostname，`search.ts:34-44`）+ 截断提示 + 结尾固定句 `Cite the relevant URLs above as markdown links in your answer.`。

**fetch 结果**（`fetch.ts:310-319`）：`Fetched <finalUrl> (HTTP <statusCode>)\n\n` + 渲染 body + 截断 footer。

**上下文优化（truncate 大小）**：
- search：`searchMaxResults`（默认 8）截断 `sources[]`，由 seam 强制执行并置 `truncated`。
- fetch：三层 cap——provider `maxBodyChars`(100k) / 工具源 `fetchMaxOutputChars`(200k) / 整体输出 `fetchMaxOutputChars`；`DEFAULT_FETCH_MAX_OUTPUT_CHARS = 200_000`（`index.ts:34`）。
- 超大 fetch 结果走通用 spill 栈（`dsh-spill-policy`）自动落盘，模型只见预览+locator（`tool-web/tests/spill.spec.ts:1-8,72-96` 证明，无 tool 专属 spill 代码）。

---

## 5. 状态模型：无会话/标签页/cookies/登录态（已确认）

**预期「无」，已确认**：

- `WebFetchRequest` 只含一个 `url`（`web/src/types.ts:63-65`）；`WebFetchResult` 只含 final url + statusCode + body + truncated（`web/src/types.ts:73-82`）。
- fetch 是**单次无状态 GET**：`requestOnce()` 每次新建 `fetch()` 调用，无 cookie jar、无 header 持久化、无会话对象（`web-fetch-http/src/provider.ts:103-110`）。
- provider 头文件明说 "Requests carry no browser cookies or ambient credentials."（`provider.ts:4`）；seam note `:202` 明确 "carries no browser cookies, editor credentials, git credentials, internal auth tokens, or implicit access to private services."
- 无标签页/窗口/DOM/导航历史概念——`packages/web/` 全树没有 `Page`/`Tab`/`Context`/`Cookie`/`Session`（web 领域意义）类型或状态。唯一的 `SessionEventMap` 出现在 deepseek provider 的**日志**用事件 `web/deepseek-search-llm-request`（`web-search-deepseek/src/provider.ts:80-85`），是记录辅助请求、不是浏览器会话。
- 无重试/backoff 状态机；无连接池；无缓存。
- 跨请求唯一保留的「状态」是 `tool-web/src/fetch.ts:300` 的 `WeakMap` 渲染 memo（同一次 tool 结果内部避免双重转换，key 是 frozen result 值，GC 即释放）——非跨请求状态。

结论：与浏览器类系统（Playwright/CDP 的 `BrowserContext`/`Page`/`cookies`/storage state）完全不同，这里是纯函数式「一次 URL → 一次 HTTP 响应 → 一段解码文本」。

---

## 6. 错误处理（WebError 体系）

### 6.1 code 全表（`docs/subsystems/web.md:128` 权威列举，按 owner 分）

**seam 中性（`WebRuntime` 契约抛）**：
- `WEB_PROVIDER_UNAVAILABLE`、`WEB_PROVIDER_CONFIGURED_MISSING`、`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`、`WEB_PROVIDER_AMBIGUOUS`、`WEB_DUPLICATE_PROVIDER`（注册期编程错误）、`WEB_ABORTED`、`WEB_PROVIDER_ERROR`（provider 自身失败兜底，含 DNS/connection refused/TLS 等网络失败，无独立 `WEB_NETWORK`）。

**fetch 传输专属（`dsh-web-fetch-http` 拥有，其他 fetch 后端可不必抛）**：
- `WEB_INVALID_URL`、`WEB_BLOCKED_URL`、`WEB_REDIRECT_BLOCKED`、`WEB_FETCH_TOO_LARGE`、`WEB_FETCH_TIMEOUT`、`WEB_UNSUPPORTED_CONTENT_TYPE`。

**provider 专属（开放式，消费者须容忍未知 code）**：
- `WEB_PROVIDER_CREDENTIAL_MISSING`（仅 deepseek，`web-search-deepseek/src/provider.ts:294-299`）。

`WebError extends HarnessError`（`web/src/types.ts:129`），code 是开放字符串非封闭 union（`web/src/types.ts:121-128`）。

### 6.2 重试逻辑

**没有任何自动重试**。三个 search provider 与 fetch provider 都是单次 `fetch`，失败即抛 `WebError`；无 backoff/retry 循环。重试若需要，由上层（agent loop / `dsh-tool-call-timeout-policy` 之外）负责。seam note 全篇无 retry 提及；`tool-web` 无 retry。

### 6.3 失败如何回给模型

- provider 抛 `WebError` → `ToolRuntime.execute()` 捕获 `HarnessError`，生成 `ToolFailure{ message, info:{ name:'WebError', code } }`（`core/tools/src/index.ts:641-647,480-486`）。
- 模型读到的文本：`Error: <message>`（`tool-web/README.md:110`）；结构化 code 供 hooks/UI/tests 路由（seam note `:279`）。
- 非 2xx 的 fetch 响应是**结果**不是错误（`web/src/index.ts:152`、`web-fetch-http/src/provider.ts`），状态码进 `WebFetchResult.statusCode`。
- abort 传播链路：`exec.signal` → `ctx.web` → provider `fetch(signal)`；abort 分类见下。

### 6.4 abort / timeout 分类细节

- fetch provider 用 `deadline` + `timeoutOf(signal,'WEB_FETCH_TIMEOUT')` 区分：本 provider 超时 → `WEB_FETCH_TIMEOUT`；外部/上层取消 → `WEB_ABORTED`；signal 未 abort 的 throw → `WEB_PROVIDER_ERROR`（`web-fetch-http/src/provider.ts:225-239`）。
- exa/perplexity 的 abort 判定是 **error-shape 型**（只认 `DOMException name==='AbortError'`），已知局限：带自定义 reason（如 `TimeoutReason`）的 abort 会误报 `WEB_PROVIDER_ERROR`（exa `README.md:42`、perplexity `README.md:65`）。
- deepseek 更严谨：`signal.aborted || isAbortError` 双条件 + `abortable()` 竞速预检（`provider.ts:238-240,308-325`）。

---

## 7. 测试

### 7.1 单元测试（vitest，无真实 key，mock/stub fetch 或本地 HTTP server）

- `web/tests/web.spec.ts`（215 行）：注册/选择/`maxResults` 截断/abort 契约 + `WebError` 是 HarnessError（`web.spec.ts:209-214`）。
- `web-fetch-http/tests/fetch-http.spec.ts`（429 行）：起本地 `node:http` server，覆盖 policy 纯函数 + 成功/截断/重定向（含同源跟随、跨源拒绝、跳数预算、Location 无/带凭据重校验）+ abort/timeout/连接失败 + body cancel 清理 + 插件注册/HMR 卸载 + 构造期参数校验。
- `tool-web/tests/tool-web.spec.ts`（747 行）：格式化、meta 投影/round-trip、注册（启用/禁用、无 provider 仍注册、`WEB_PROVIDER_AMBIGUOUS`、`INVALID_ARGS`）、执行透传 signal、`searchMaxResults`/`fetchMaxOutputChars`/timeout config；另有 `integration.spec.ts`(177)、`load-path.spec.ts`(41)、`spill.spec.ts`(97)。
- 三个 search provider 各一个 spec：exa(261)、perplexity(243)、deepseek(534) 行——映射函数、`available()`、请求映射（`vi.stubGlobal('fetch')`）、错误分类、插件注册/HMR、env fallback、deepseek 另有 credential 轮换 + 严格模式 + settings 热切换。deepseek 的 `redirect.spec.ts`(129) 用真实 HTTP server 证明凭据型重定向目标未被联系；`settings.spec.ts`(124) 覆盖 settings 层热切换/密钥脱敏。

### 7.2 e2e（真实 API，自跳过）

三个 `.e2e.ts`，均遵循 `docs/testing.md` 的 with-key 政策，**无 key 即 `describe.skip` 自跳过**（CI 无密钥）：

- `web-search-exa/tests/exa.e2e.ts:8-22`：需 `$EXA_API_KEY`，否则 `describe.skip`；断言真实查询返回 sources 且 url 匹配 `^https?://`，30s 超时。
- `web-search-perplexity/tests/perplexity.e2e.ts:8-22`：需 `$PERPLEXITY_API_KEY`；断言 `content` 非空 + sources url 合法。
- `web-search-deepseek/tests/deepseek.e2e.ts:22-38`：需 `$DEEPSEEK_API_KEY`，但用例**双重 skip**（`describe` 层 key 判定 + `it.skip` 固定跳过，`deepseek.e2e.ts:26`）——注释说明：live endpoint 可能无结构化 source 块完成，故「不可靠 merge 信号」，body 保留只为「mock 无法确认 wire shape」。**因此实际没有任何 e2e 会在 CI 跑真实 API**。

### 7.3 覆盖程度评估

- **单元/契约覆盖高**：seam 选择语义、truncate、abort、redirect 安全边界、错误分类、HTML→markdown（含深层嵌套/畸形输入/colspan 防扩张/超时边界）都有断言。seam note `:283` 明确「每一层在自己的边界 pin 住」。
- **真实 API 覆盖≈零**（自跳过 + deepseek 永久 skip），wire shape 靠录制的 mock 断言，不靠 live 验证。
- e2e 与 `apps/web` 的 playwright e2e 无关（那是前端 shell 的浏览器回归，不测 packages/web 能力）。

---

## 8. 扩展点（第三方新增 provider / fetch 后端）

### 8.1 新增 search provider

照抄三个 provider 的模式（均为 function/namespace 插件，`inject: ['web']`，**不是** default-export service）：

1. 定义 `id`（稳定字符串，capability kind 内唯一）。
2. 实现 `WebSearchProvider`（`web/src/types.ts:101-107`）：`id` + `available(): boolean`（纯本地检查，禁网络）+ `search(request, signal?): Promise<WebSearchResult>`。
3. `apply(ctx, config)` 里 `ctx.web.registerSearchProvider(new MyProvider(...))`（如 `web-search-exa/src/index.ts:59-70`）。
4. 凭据型请求必须 `redirect:'error'`（`packages/web/AGENTS.md:5`）。
5. 可选：挂 settings 段（deepseek 的 `installSettingsSection` 模式，`web-search-deepseek/src/index.ts:127-137`）；可选凭据 seam（deepseek `resolveApiKey`，`provider.ts:278-300`）。
6. 映射到 `WebSearchResult`：`content?` + `sources[]`（url 必填，title/snippet/publishedAt 可选）+ `truncated:false`（seam 负责截断，如 exa `provider.ts:80`）。

无需改 `dsh-web`、无需改 `tool-web`。provider 可自由引入自己的 `WebError` code（开放式 code 空间）。

### 8.2 新增 fetch 后端

1. 实现 `WebFetchProvider`（`web/src/types.ts:113-119`）：`id` + `available()` + `fetch(request, signal?): Promise<WebFetchResult>`。
2. `apply` 里 `ctx.web.registerFetchProvider(...)`（`web-fetch-http/src/index.ts:84-101`）。
3. 返回 `WebFetchBody` 封闭联合 `html|text`——**新增第三种 body kind 是跨 `dsh-web`+provider+`tool-web` 的编译强制协调改动**（`web/src/types.ts:84-95`、`web/README.md:60`），不是插件自由扩展。

### 8.3 选择接入

新 provider 注册后：无显式配置时，若恰好一个可用 provider 即自动选中；有多个需在 `web` 行配置 `searchProvider`/`fetchProvider`（seam note `:127-150` 给完整 YAML）。`tool-web` 的 schema 完全不变。

### 8.4 明确的「非扩展点」

- 不给 provider 暴露模型工具 schema（provider 只注册能力）。
- `WebFetchBody` 封闭联合，新 kind 是协调改动。
- 模型可见工具集固定为 `web_search`/`web_fetch` 两个名字（seam note `:287-293` 否决了 per-provider 工具）。

---

## 9. 相对 CDP 浏览器自动化的明确差距清单

`packages/web/` 是「无状态单次 HTTP 检索」，相对 CDP 浏览器自动化缺以下全部：

| 缺失能力 | 证据（为什么没有） |
|---|---|
| **JS 执行 / 动态渲染** | fetch 是静态 GET，只解码 HTTP 响应体（`web-fetch-http/src/provider.ts:103-146`）；无 V8/无 `page.evaluate`。SPA 内容拿不到。 |
| **DOM 交互**（点击/输入/滚动/表单提交） | 无 DOM、无 Page 对象；`WebFetchRequest` 只有 `url`（`web/src/types.ts:63-65`）。 |
| **页面/浏览器状态**（tab、navigation history、back/forward） | 单次请求即弃；`followAndRead` 只是重定向跟随，无历史栈（`provider.ts:55-101`）。 |
| **cookies / 登录态 / storage** | 明示「无浏览器 cookies」与「无 ambient credentials」（`provider.ts:4`、seam note `:202`）。 |
| **截图 / PDF 渲染输出** | 只解文本类（html/text），二进制一律 `WEB_UNSUPPORTED_CONTENT_TYPE`；PDF 解码是 deferred（`web-fetch-http/README.md:50`、seam note `:328`）。 |
| **多页面 / 多标签并行上下文** | 无 `BrowserContext` 概念；连跨源重定向都拒绝（`WEB_REDIRECT_BLOCKED`）。 |
| **网络拦截 / 请求改写 / 响应 mock** | 无拦截层；唯一「改写」是固定 UA + accept 头。 |
| **表单认证 / OAuth 流程** | 凭据型 URL 直接被拒（`WEB_BLOCKED_URL`）；无登录流程。 |
| **对动态元素 wait / selector 引擎** | 无 selector；`web_search` 结果只是结构化 citations。 |
| **下载文件 / 上传** | 只有 GET 文本读取，无 POST 表单、无文件上传下载。 |
| **CDP 级调试（console/network/performance 事件流）** | 无；唯一 CDP 用法在 `apps/web` 前端 perf 测试，与产品能力无关。 |

**有但窄的对应能力**：web_search（结构化搜索 API，非页面抓取）、web_fetch（单 URL → 解码文本）、重定向跟随（仅同源）、超时/大小截断、abort 传播。这些是「检索层」，不是「浏览器层」。

---

## 10. 规模统计

`src/` 行数（wc -l，逐文件）：

| 包 | src 行数 | 明细 |
|---|---|---|
| `web/` | 361 | index 202 · types 129 · invariant 30 |
| `web-fetch-http/` | 476 | provider 240 · policy 105 · index 101 · invariant 30 |
| `tool-web/` | 902 | fetch 495 · search 274 · index 91 · invariant 30 · turndown-plugin-gfm.d.ts 12 |
| `web-search-exa/` | 303 | provider 165 · index 70 · types 38 · invariant 30 |
| `web-search-perplexity/` | 296 | provider 167 · index 64 · types 35 · invariant 30 |
| `web-search-deepseek/` | 565 | provider 347 · index 138 · types 49 · invariant 31 |

**`packages/web` src 总计 ≈ 2,903 行。**

`tests/` 行数：

| 包 | tests 行数 |
|---|---|
| `web/` | 215 |
| `web-fetch-http/` | 429 |
| `tool-web/` | 1,062（tool-web.spec 747 · integration 177 · spill 97 · load-path 41） |
| `web-search-exa/` | 284（spec 261 · e2e 23） |
| `web-search-perplexity/` | 266（spec 243 · e2e 23） |
| `web-search-deepseek/` | 826（spec 534 · redirect 129 · settings 124 · e2e 39） |

**tests 总计 ≈ 3,082 行**（测试行数 ≈ 源码行数，覆盖强度高但以 mock/本地 server 为主，真实 API e2e 自跳过）。

---

## 附：关键文件索引

- seam 决策全文：`.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md`（336 行，含 deferred work 与 alternatives）。
- 子系统参考：`docs/subsystems/web.md`（199 行，含生成的 cordis-surface）。
- 工具注册机制（`ctx.tools`）：`packages/core/tools/src/index.ts`（`ToolRuntime`，`register()` at :1037，`ToolDefinition` at :222-288，`defineTool` 在 `schema.ts:545`）。
- 包级硬规则：`packages/web/AGENTS.md`（凭据型请求拒绝重定向）。
