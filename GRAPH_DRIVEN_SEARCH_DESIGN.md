# Graph-Driven Search — 设计草案

> 状态：Feature 提案，暂不实施
> 优先级：多 Agent 通信层落地后
> 前置条件：图引擎覆盖率验证、summary 质量评估

## 1. 问题陈述

当前所有编码 Agent（Claude Code、Cursor、Codex、HoloGram）理解代码的方式是**探索模式**：read → grep → read → search → read，用线性工具调用暴力重建代码心智模型。

痛点：
- token 消耗大：一个任务可能 5-10 次 read/search，每次返回大量无关上下文
- 建模速度慢：Agent 需要多轮调用才能建立局部代码理解
- 图谱工具被忽略：31 个 MCP 工具作为可选项挂在旁边，Agent 训练数据里没有"先查图再定位"的模式

## 2. 设计目标

**不是替换传统工具，是分层整合。**

图引擎负责**结构问题**：谁依赖谁、blast radius、调用链、脆弱度。
传统 read/grep 负责**内容问题**：这段代码做了什么、这个字符串是什么、配置值。

将图数据焊进 search 工具的返回值，让 Agent 不需要改变行为就获得图感知能力。

## 3. 核心方案：层级 Search

### 第一层：结构化搜索

Agent 调用 search 时，返回的不是原始 grep 匹配行，而是：

```
[图引擎结果]
匹配文件：src/auth.ts (脆弱度 0.82, 12 个符号, 3 个入边, 2 个出边)
匹配文件：src/session.ts (脆弱度 0.65, 8 个符号, 循环依赖: auth.ts ↔ session.ts)

[文件 Summary]
auth.ts: 认证模块，导出 authenticate(), verifyToken(), refreshSession()
  - 依赖：token.ts (L2 耦合), crypto.ts (L1 耦合)
  - 被依赖：router.ts, api.ts, middleware/auth.ts

session.ts: 会话管理，导出 createSession(), destroySession(), getSession()
  - 依赖：auth.ts (L3 耦合, 循环), store.ts (L1 耦合)
  - 被依赖：router.ts

[精确匹配行 — 压缩格式]
auth.ts:42  export function authenticate(email, password) { ... }
auth.ts:78  export function verifyToken(token) { ... }
session.ts:15  import { authenticate } from './auth'
session.ts:42  export function createSession(userId) { ... }
```

### 第二层：精确展开

Agent 看到结构 + summary 后，传参定位精确位置：

```
search(target_file: "src/auth.ts", symbol: "authenticate", expand: true)
```

返回：
```
[精确代码]
auth.ts:42-65
export function authenticate(email: string, password: string): Promise<AuthResult> {
  const user = await userStore.findByEmail(email);
  if (!user) throw new AuthError('not_found');
  const valid = await crypto.compare(password, user.passwordHash);
  if (!valid) throw new AuthError('invalid_credentials');
  const token = await tokenStore.create(user.id);
  return { token, user };
}

[图上下文 — authenticate 符号]
调用方：router.ts:postLogin, api.ts:authRoute, middleware/auth.ts:handleAuth
被调用：userStore.findByEmail, crypto.compare, tokenStore.create
数据流：读取 userStore, 写入 tokenStore
耦合深度：L2 (跨文件直接调用)
```

## 4. 关键设计决策

### 4.1 不删除传统工具

静态图谱有局限：注释、字符串模板、配置、运行时行为、逻辑分支——这些图抓不到，传统 read/grep 能抓到。

图引擎和传统工具是**互补关系**，不是替代关系。

### 4.2 物理隔离 vs 共存

**共存模式（推荐初期）**：传统 search 和图驱动 search 同时存在。Agent 可以两条路都走。
- 优点：有 fallback，图索引不全时不会卡死
- 缺点：Agent 可能绕过图驱动 search，直接用传统 search

**隔离模式（后期验证后）**：图驱动模式下 `unregister` 传统 search。
- 优点：Agent 被迫走图驱动路径
- 缺点：图索引覆盖不全时没有 fallback，可能灾难

### 4.3 Summary 质量

层级方案的核心风险：第一层 summary 质量决定了 Agent 能否准确判断"该深入哪个位置"。

- summary 太泛 → Agent 第二次传参偏 → 需要第三次调用 → 层级退化成低效多轮
- summary 太细 → 第一层返回就很大 → 没有省 token

需要实验确定 summary 的最佳粒度。

### 4.4 图索引覆盖率

图驱动 search 的前提是图索引覆盖了目标文件。如果文件未被索引：
- 返回空图上下文 + 传统 grep 结果作为 fallback
- 或者提示 Agent 该文件未被索引，建议使用传统 read

## 5. 现有引擎能力评估

基于代码探索结果，图引擎已经具备以下能力：

| 能力 | MCP 工具 | 粒度 | 状态 |
|------|---------|------|------|
| 邻居查询 | `get_neighbors` | 符号级 | ✅ 可用 |
| Blast radius | `trace_impact` | BFS 多层 | ✅ 可用 |
| 符号详情 | `inspect_symbol` | 符号级 | ✅ 可用 |
| 依赖路径 | `find_dep_path` | 路径级 | ✅ 可用 |
| 耦合分析 | `coupling_report` | 模块级 | ✅ 可用 |
| 数据流 | `trace_dataflow` | 文件级 | ✅ 可用 |
| 前置检查 | `preflight_check` | 文件列表 | ✅ 可用 |
| 符号搜索 | `search_symbols` | FTS5 + 向量 | ✅ 可用 |
| LSP 调用解析 | `resolve_call` | 符号级 | ✅ 可用 |
| LSP 引用查找 | `find_references` | 符号级 | ✅ 可用 |
| LSP 类型推断 | `infer_type` | 符号级 | ✅ 可用 |
| LSP 实现查找 | `find_implementations` | 符号级 | ✅ 可用 |

**结论：引擎能力已足够支撑图驱动 search，瓶颈在消费端整合，不在分析能力。**

## 6. TS 层现有基础

- `buildFileNodeIndex(graphData)` → `Map<filePath, NodeBrief[]>` — <0.1ms 查询
- `createGraphContextHook(ctx)` — 已经在 read/search 后注入图上下文（hook 方式）
- `createGraphPreflightHook(ctx)` — 已经在编辑前注入风险评估

hook 方式的问题：Agent 把注入的图上下文当背景噪音忽略。
整合方式的优势：图数据直接焊进工具返回值，Agent 无法忽略。

## 7. 实施计划（待定）

| 阶段 | 内容 | 前置条件 |
|------|------|---------|
| 0 | 验证图引擎覆盖率 | 无 |
| 1 | 设计 summary 生成逻辑 | 覆盖率 > 80% |
| 2 | 实现图驱动 search 原型 | summary 质量验证 |
| 3 | 对照测试：传统 vs 图驱动 | 原型可用 |
| 4 | 决定共存/隔离模式 | 对照数据 |

## 8. 开放问题

1. **Summary 生成方式**：用 LLM 生成（成本高但质量好）还是用结构化模板拼接（成本低但可能不够语义化）？
2. **图索引实时性**：文件被编辑后图索引多久更新？编辑后立即 search 会拿到过时的图数据吗？
3. **多语言支持**：图引擎当前支持哪些语言的索引？未支持的语言如何 fallback？
4. **成本模型**：图驱动 search 的两次调用总 token 是否真的少于传统 search 的多次调用？需要实测。
5. **Agent 行为适配**：Agent 的训练数据中没有"层级 search"模式，它能否自然地学会二次定位？还是需要在工具描述中强引导？
