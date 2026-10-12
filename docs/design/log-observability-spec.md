# 日志可观测性规格（log-observability spec）

> 状态：**当前**（2026-10-12 批 1–3 落地）。真源 = `src-ui/src/agent/obs.ts`（事件门面，
> 事件名与字段表在文件头定死）+ `src-ui/src/agent/logger.ts`（级别过滤与健康度）；
> 本页是它们的**长期规范**（给人读的契约面）。
> 立项与事故取证见 [`../plans/log-observability-plan.md`](../plans/log-observability-plan.md)。

## 0. 这条规格要保证的性质

> **任何未知 bug，只要它让用户看见了失败（墓碑 / toast / 面板 fatal），日志里至少留下一条，
> 且带「发生层」与「原始错误文本」。**

这不是「多记日志」，是消灭一个类别：**失败默认无痕**。触发事故（2026-09-27 用户报本地模型
`http://127.0.0.1:8080/v1` 配好却调不通）里，用户附的 `ui.log` 1158 行对该问题的可答信息
**0 条**——1024 行是同一条无 `method` 的 `invoke` 噪声，87 条 error 全是路径噪声，
`8080` / `127.0.0.1` / `localhost` 出现 0 次。

由此推出的设计纪律：**不按「可能出什么问题」穷举字段，按「结构上的接缝」覆盖。**
接缝数量由架构决定，与 bug 数量无关。

## 1. 条目形状

`ui.log` 是 NDJSON，一条一行。历史字段语义不变（只增不改，旧解析器不破）：

```jsonc
{"ts":"2026-09-28T04:42:58.119Z","level":"error","module":"chat","message":"人可读一句话",
 "ctx":{ /* 接缝专属字段 */ },                       // 历史字段，原样保留
 "event":"turn.failed","build":{"v":"1.0.4","commit":"658460cd"},
 "ids":{"session":7,"turn":3,"run":11},
 "dur_ms":1234,"out":"fail",
 "err":{"kind":"PROVIDER_ERROR","status":502,"phase":"stream","raw":"原始错误文本"}}
```

| 字段 | 语义 |
|---|---|
| `event` | ASCII 点分**判据**名（下表）。**不用中文句子当事件名**——判据与文案混同正是「日志答不了问题」的一半原因 |
| `build` | `{v, commit}` 构建锚。构建期由 `vite.config.ts` 的 `buildAnchor()` 烙入（版本真源 = `src-tauri/tauri.conf.json`，commit = 构建机 git；取不到记 `unknown`，不炸构建）。**收到的 log 靠它定位代码** |
| `ids` | `{session, agent, turn, run}`——哪个卷、哪一轮、哪条运行记录。由**调用点显式给**（见 §4） |
| `out` | 结局：`ok` / `fail` / `miss` / `hit` / `empty` |
| `err` | `{kind, status, phase, raw}`——失败的结构化面，`raw` = 原始错误文本（经脱敏） |
| `dur_ms` | 耗时（毫秒），有起止的事件才带 |
| `truncated` | 本条超 4KB 上限被**截断**（截断后仍是可读记录，不是丢弃） |

**单条上限 4KB**（字节）。超出按「保信号优先」逐级收缩：削 `err.raw` → `ctx` 字符串削到
160 字 + 长数组裁到前 8 项（尾巴留 `…(+N)` 计数）→ 丢 `ctx` → 削 `message`。

## 2. 事件表

| 事件 | 级别 | 何时 | 关键字段（`ctx` / `err`） |
|---|---|---|---|
| `boot` | info | 工作区打开、logger 落定后一次 | platform、tz、utc_offset_min、workspace、providers_yml、proxy_port、log_channel、**log_level、log_level_source**（批 3：这份 log 是哪个级别、开关从哪来） |
| `config.load` | info/warn/error | provider 文档装载出口（**成功也写**） | path、sections、rows、section_errors、fatal、empty、source（file/localStorage）、keys（`N/M` 带 Key 行数） |
| `panel.providers_reload` | info/warn/error | 设置面板重读（外部改动 / 重试路径两条） | 同上 + trigger |
| `cred.get` | info/warn/error | **真解析**一次凭据（IPC 往返；缓存命中不记） | provider、len；`err.kind=CRED_IPC_ERROR` 区分「IPC 抛错」与「真没配」 |
| `cred.store` / `cred.remove` | info/error | 凭据写入 / 删除（逐 provider） | provider；失败带原文 |
| `llm.send` | info | 请求发出前（含重试第 n 次） | provider、model、kind、target（`host:port`）、tools、prompt_est、attempt |
| `llm.first_byte` | info | 响应头到达（挂起判定的分水岭） | 同上身份面 + `dur_ms` |
| `llm.done` | info | SSE 流**正常读完** | 同上 + status、finish_reason、prompt_tokens、completion_tokens、events |
| `llm.error` | error | 每次尝试失败（重试链上逐次） | 同上 + status；`err.kind` = 错误分类（transient / rate_limited / auth_or_param / context_overflow） |
| `turn.failed` | error/warn | **唯一漏斗**：任何用户可见的回合失败（墓碑） | `err.phase` = preflight / stream / tool；`err.kind`；`err.raw`；同 (session, turn, phase) 去重 |
| `ui.toast` | error | error 级 toast 出口（用户看见了） | text（前 200 字） |
| `log.self` | warn | 日志器自身健康度：写失败补偿 / 失败现场的前情倒出（**批 3 落地**，生产者在 `logger.ts` 而非门面——反向调用会与 import 方向成环） | channel、dropped、ring_dumped、level、source |

**`phase` 的判定**（定位的关键——「哪一层」比「什么错」先要答出来）：

- `preflight` 配置 / 凭据 / 协议构造 / 档位断言，**请求未发出**；
- `stream` 出网 → 首字节 → 中止；
- `tool` 工具层。

判定靠**类型**不靠文案：`ApiError` 的 `status` / `kind` 优先；只有具名契约标记
（`MISSING_CREDENTIAL` / `PROVIDER_NOT_FOUND` / `PROTOCOL_UNSUPPORTED`——历史形态是
`provider/live.ts` 的凭据闸抛的普通 Error，该闸已于 2026-09-28 无 Key 放行批撤除，
标记表保留为防御面）才用文本匹配。⚠ 空 Key 之后的鉴权失败走**响应侧**：带 HTTP
status 的 401/403（文案「本行没有 API Key」）按类型判为 `phase: stream`——请求真
发出去了，不得记成 `preflight`。

## 3. 不记什么（唯一脱敏审查点）

脱敏**只在** `src-ui/src/agent/obs.ts` 一处（`scrubText` / `hostPort`），评审只看这一个文件。

**永不落盘**：apiKey / token 明文、消息正文、请求体全文、请求头、URL 的 query。

**只记**：长度、存在性、`host:port`、节数 / 行数、错误原文（经脱敏）。

规则表（**顺序敏感**，见 `obs.ts` 的 `REDACTIONS`）：① 削 URL query → ② 抹裸 `Bearer XXX`
（**必须早于**③——否则 ③ 会把 `Authorization: Bearer XXX` 整段吃成 `Authorization=<redacted>`，
`XXX` 变成孤儿裸串漏网）→ ③ 抹显式凭据字段（值可带引号）→ ④ 兜各家 Key 字面形态。
`\b` 边界让 `max_tokens` / `tokens` 这类**计数**字段不误伤。

调用点把**整条 URL** 递给门面（`url` 字段），由门面削成 `host:port`——收整条而不是收削好的，
是为了让调用点忘不了这件事。

## 4. 两条设计裁定（偏离「门面自动注入」处）

1. **`ids` 由调用点显式给，不做模块级 ambient 上下文。** 本仓库的并发模型是**多卷同时跑**
   （`agent/execution-state.ts` 的运行账按卷各记一条，子 Agent 另持私账）——单个 ambient 槽位
   会把 A 卷的失败记到 B 卷头上，正是 `INVARIANTS.md` #1「全局变量 = 跨面板串流」那一族。
   代价 = 每次调用多写一行 `ids`；收益 = 并发正确 + 门面零状态（可纯函数测）。
2. **事件字段搭既有 `log.*` 的第 4 参，不另开写口。** `log.*` 是本仓库测试替身
   （`vi.mock` logger）唯一复现过的写面——另开导出会让几十处替身当场缺键。形态上也不发明
   第二套写 API。门面**绝不抛**（日志写不出去最多丢一条，绝不打断用户动作）。

## 5. 加一条新接缝

1. 在 `agent/obs.ts` 的事件表（文件头注释）加一行 + 一个函数——**不散点**；
2. 字段先过 `scrubText` / `hostPort`（门面内部已统一做，只需不绕过 `emit`）；
3. 内核调用点直接 `import * as Obs from '.../agent/obs'`；
   **产物域**（`plugins/builtin/<name>/`）经宿主面 `./host` 取用，并在
   `plugins/builtin/host-modules.ts` 的 `faceDeps` 登记（漏登记 tsc 就红——
   `host-surface-seal.test.ts` 封印，改宿主面须同 commit 跑 `npm run gen:host-surface`）；
4. 配一条守护测试（门面不变量 → `tests/log-observability.test.ts`；
   接缝接线 → `tests/log-observability-seams.test.ts`；级别开关与丢条补偿 →
   `tests/log-level-and-health.test.ts`）。

## 6. 级别与开关 + 健康度 + Rust 出网（批 3，2026-10-12 落地）

### 6.1 级别过滤与运行时开关

- **默认 `info`，`debug` 默认丢弃**——触发事故那份 1158 行 `ui.log` 里 1024 行是同一条
  无 `method` 的 `invoke` debug 行（88%）：信号被自己的噪声淹了。`bridge` 的 rpc invoke
  属 debug 档（打开 debug 才写，写则带 `method`）。
- **优先级**：`LANTAI_LOG_LEVEL` 环境变量 > `localStorage['lantai.log.level']` > 默认
  `info`。环境变量经壳转一手（RPC `log_level_hint`）——WebView 里读不到进程环境变量，
  而壳读得到。认不出的值**不猜**（回落下一档）：猜错会把「我明明设了 debug」变成更难查
  的形态；未设 / 认不出 / 通道不通一律回空串。
- **级别上得了台面**：`boot` 的 `log_level` / `log_level_source`（`env` / `storage` /
  `default`）——拿到一份没有 debug 行的 log，必须能回答「是没发生，还是级别把它挡了」。
- 开关当前**无 UI**（设置页开关留到下一批）：`LANTAI_LOG_LEVEL=debug` 放进启动环境，
  或在开发者控制台写 `localStorage['lantai.log.level']='debug'` 后调一次
  `applyLogLevelFromShell()`（幂等，改完再调即生效）。**但日常不需要它**——被挡下的
  debug 不是丢掉，而是进「前情缓冲」（§6.2 ③），失败时自动连现场一起落盘。
- **过滤点只有一处** = `logger.ts` 的 `write()`：`log.*` 与门面 `obs.*` 都从这里过。

### 6.2 日志健康度（丢条可见）与 debug 前情缓冲

「日志里没有」有两种可能：**没发生**，或**写不出去 / 被级别挡了**。两条都在批 3 收口：

1. **丢条可见**（写失败）：计数 + **首次** `console.error`（此后只计数，不刷屏）；
   下一条成功写入补一条 `log.self{dropped:N, channel, level, source}`。
2. **通道未初始化**（无工作区，`logPath = null`）：条目留在**缓冲**、**不计丢条**——
   把「攒着」报成「丢了」是健康度读数在说谎。
3. **debug 前情环形缓冲**（2026-10-12 用户拍板：「不靠人记得开开关」）：被级别挡下的
   debug 条目**不丢**，留在内存定长缓冲里（≤2000 条 / 128K 字符，实测 ≈0.13MB、最坏
   ≈0.4MB，**跑多久都不涨**）；一旦出现**用户可见的失败**（错误级 **且带 `event`** =
   接缝认定的失败），先倒一条 `log.self{ring_dumped:N}` 头，再把 N 条前情连失败一起写盘
   （前情在前、失败在后，读起来是一条完整现场）。
   三条纪律：① 裸 `log.error`（路径噪声那类）**不触发**——本机 `ui.log` 有 5.2 万条
   这种 error，认它们等于让噪声泵爆文件；② 倒一次清空，下次要**攒够 25 条**才再倒
   （错误风暴不刷屏）；③ 级别真开到 debug 时缓冲恒空（直接写盘，不倒，避免写两遍）。
   单条超 4KB **不入缓冲**（截断会破坏 NDJSON；宁可少一条前情）。

通道可用性由 `boot` 的 `log_channel` 如实记（`ok` / `unavailable`，批 1 已有）。

### 6.3 Rust 侧出网日志（`src-tauri/src/llm_proxy.rs`）

- 五处 `eprintln!` → 结构化留痕（**只记 `host:port`** + status + 脱敏后的错误原文），
  并**新增两条**：上游回 4xx/5xx（「配好了却调不通」的关键判据：401 是 Key、404 是路径、
  502 是本地端点没起）、SSE 中途断流（「答到一半停了」的唯一线索，此前全无痕迹）。
- **落点按就绪度二选一**（与计划原文「一律落 bridge.log」的偏离，理由是「失败不静默」
  这条硬要求）：`bridge.log` 的 tracing subscriber 要等工作区打开才装（`logging.rs`
  由 `workspace_service` 调用），而代理在 `main.rs` 的 setup 期就起来了——窗口期内
  `tracing::warn!` 的记录会**静默消失**（无 subscriber = 无人接盘）。故
  `logging::bridge_sink_ready()` 为 false 时回退 `log` 门面（`boot.log`，进程启动期即装）。
  诊断时三份合并看：`boot.log`（启动期）+ `bridge.log`（工作区期）+ `ui.log`（前端）。
- **脱敏在 Rust 侧另有一份**（前端 `obs.ts` 那套门面到不了这里）：只记 `Url::parse`
  出来的 `host:port`（userinfo 一并摘掉），第三方错误原文先过 `scrub_url_query`
  （与前端 REDACTIONS ① 同形的正则）——reqwest 的 `Display` 会带上整条 URL，可能含
  `?api-key=`。⚠ 原文里的**路径保留**（只削 query）：路径不是凭据，且 404 判别要看它；
  「只记 host:port」是 `target` 字段的纪律，不是 `err.raw` 的。

## 7. 尚未做（批 4）

- **诊断包导出**（带可信度段：通道可用性 / 断档区间 / 文件 mtime / 字段来源标签）。
- **日志轮转 / 保留窗口**：`bridge.log` 现状 `Rotation::NEVER`（`max_log_files` 配着
  也不生效——永不切分就没有多余文件可清），`ui.log` 是前端纯追加，两者都会无限增长
  （实测见过 71MB+）。`boot.log` 有单代 4MB 轮转，是唯一的例外。
- 设置页的**级别开关 UI**（批 3 的旋钮当前只能靠环境变量 / 控制台）。

详见计划 §2.5 / §4。
