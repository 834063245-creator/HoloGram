# MCP / ACP 协议支持补全 — 落地规格

> 状态：已实现（2026-08 落地规格单）· 面向：实施 Agent（可复制本文件给独立 Agent 窗口）
>
> **实施摘要（本文件作者落地）**
> - §3 MCP server 补全：`engine/src/mcp.rs` 已补 notifications/initialized、notifications/cancelled、notifications/progress（长任务 analyze/validate）、prompts/list+get、能力协商；未知工具改返回规范 JSON-RPC 错误（-32000），不再 `_isDegraded` 假冒成功；工具失败用 `result.isError`。`cargo test --lib` 全绿。
> - §4 MCP client：新增 `src-ui/src/agent/mcp/`（client/transport/registry/tauri-io + index），stdio / streamable-http / 回环三传输，`mcp__<server>__<name>` 命名，支持进度与取消；接入 `agent-builder.ts` 的 buildToolRegistry（`mcpClients` 选项）。测试 `tests/mcp-client.test.ts`。
> - §5 ACP server：新增 `src-ui/src/agent/acp/`（server + index），initialize / session/new / session/prompt(流式 agent_message_chunk) / session/cancel / session/delete / 权限通道；行 I/O 与 Agent 工厂注入，可测。测试 `tests/acp-server.test.ts`。
> - Tauri stdio 桥：新增 `src-tauri/src/commands/protocol_bridge.rs`（spawn/write/kill）+ rpc 分发 + `rpc-contract.ts` 方法/事件 + `tauri-io.ts` 适配，webview 里 MCP/ACP 可驱动真实子进程。`cargo build`(src-tauri) 通过。
> - **测试分三层（不只单测）**：① 单测（回环/内存，协议语义）→ `mcp-client.test.ts` / `acp-server.test.ts` / `engine mcp.rs` 14 用例；② **真实 stdio 进程集成** → `mcp-client-stdio.test.ts`（Node 起 fixture MCP server 子进程，真握手/调工具/收进度）；③ **跨组件互测** → `mcp-interop-engine.test.ts`（TS client 连真实 `engine.exe serve`，真握手 + tools/list 全量 + 真图查询）。全套 `vitest` 972 通过。
> 作者：Wenbing Jing · 源起：2026 年 HoloGram 协议层盘点
> 性质：把 HoloGram 建成"角色齐备"的标准 Agent 软件，补齐对外协议支持。

---

## 0. 一句话目标

HoloGram 要承担三个**标准角色**（不是发明双向协议，是照范式把该有的角色各自建对）：

1. **MCP server** —— 把 engine 能力对外暴露（已有雏形，需补全）
2. **MCP client** —— 让 HoloGram 的 Agent 能调用外部 MCP server 的工具（完全没有）
3. **ACP server** —— 让 HoloGram 的 Agent 实体能被外部程序驱动/观察/接管（完全没有）

三个角色都照 [MCP 规范](https://modelcontextprotocol.io) 和 [ACP 规范](https://agentclientprotocol.com) 填满，不做非标准扩展。

---

## 1. 现状盘点（已实地核查）

### 1.1 HoloGram 架构事实（决定落点）

    src-ui (TypeScript)  —— HoloGram 的 Agent 主体就在这
    +-- provider/   8 个模型提供商(deepseek/anthropic/openai/...)
    +-- agent/      Agent loop + 工具系统 + 多Agent + 会话
    |   +-- agent.ts        runLoop -> stream -> executor -> 循环
    |   +-- streaming-executor.ts  并发工具执行
    |   +-- message-types.ts / message-bus.ts  多Agent通信
    |   +-- tool.ts        ToolRegistry + ToolExecutor
    |   +-- runtime/agent-builder.ts   工具桥接(到Rust)
    +-- bridge.ts         agentInvoke/typedRpc -> Tauri invoke
    |
    |  Tauri 命令桥 (typedRpc / agentInvoke)
    v
    src-tauri (Rust shell)  —— 命令 + 权限 + 沙箱 + 事件
    +-- commands/engine_dispatch.rs  hologram_call->ToolRegistry
    |     v
    engine (Rust)  —— 代码分析引擎 + 图存储 + 27语言IR
    +-- tools/   ToolRegistry (35 个 hologram_* 工具)
    +-- mcp.rs   McpServer (stdio JSON-RPC)  <-现有MCP server
    +-- main.rs  TCP:9777 / MCP serve / CLI

### 1.2 三块现状

| 块 | 现状 | 代码位置 |
|----|------|---------|
| **MCP server** | 有最小实现：initialize/tools-list/tools-call/ping（无通知、无进度、无 resource/prompt） | engine/src/mcp.rs |
| **MCP client** | 完全缺失 | - |
| **ACP server** | 完全缺失 | - |

### 1.3 关键既有资产（补全要复用的）

- **工具执行**：src-ui/src/agent/tool.ts 的 ToolExecutor + ToolRegistry —— MCP client 把外部工具注册进来后，直接走这套
- **会话实体**：src-ui/src/agent/agent.ts 的 Agent(run/runLoop/stream)，持久化到 .hologram/agents/{id}/（NDJSON）—— ACP 驱动它
- **流式输出**：src-ui/src/provider/stream 已有流式 chunk —— ACP 的流式从这里来
- **取消**：Agent 的 run(signal) 已支持 AbortSignal —— ACP 的 session/cancel 从这里来
- **权限/确认**：src-tauri 有 permission-ask 事件 —— ACP 的 permission 从这里来

---

## 2. 角色落点（架构决策，勿改）

| 角色 | 落点 | 理由（范式自然导向） |
|------|------|---------------------|
| **MCP server** | Rust engine（engine/src/mcp.rs 扩展） | 要暴露的能力(graph/图查询)在 Rust；现有实现已在这 |
| **MCP client** | TS agent 层（新增 src-ui/src/agent/mcp/client.ts） | 它是**消费者**，agent 在 TS；调外部工具要进入 ToolRegistry，而 ToolRegistry 在 TS |
| **ACP server** | TS agent 层（新增 src-ui/src/agent/acp/server.ts） | ACP 驱动的"对话实体"Agent 在 TS，不在 Rust |

> 铁律：**不要**为了对称而在 Rust 里硬造 ACP，去驱动一个"不存在的 Rust 对话实体"——对话状态机在你 TS 的 Agent 里。落点必须在 TS。

---

## 3. MCP server 补全（Rust，扩展 engine/src/mcp.rs）

### 3.1 现有（保留）
- initialize（握手，capabilities 目前只有 tools）
- tools/list
- tools/call
- ping

### 3.2 需补

**a. 协议完整度**
- 处理 notifications/initialized（现在被"无 id 忽略"直接丢掉了——不能丢）
- 支持 notifications/cancelled（取消进行中的工具调用）
- tools/call 的进度：支持 notifications/progress（对长任务如 analyze_project、dataflow 发进度）
- resources/list、resources/read（可选，暴露图数据为资源）
- prompts/list、prompts/get（可选，暴露预置提示词）

**b. 错误语义规范化**
- 现在"未知工具"降级成成功响应 + _isDegraded 标志 —— 这是错误的。工具不存在应返回规范 JSON-RPC 错误码（如 -32602 Invalid params 或自定义 -32000 带说明），而不是成功里带标志。
- 明确 isError 语义（MCP 1.0 里 tools/call 的 isError 字段），区分"处理失败"和"参数错误"。

**c. 能力协商**
- initialize 的 capabilities 字段扩展，如实声明 tools/resources/prompts 哪些开了。
- 保持向后兼容现有 protocolVersion（2024-11-05），必要时升级。

### 3.3 验收
- engine.exe serve 能被标准 MCP client（如 Claude Desktop / Cursor / 我们自己的 MCP client）连接
- tools/list 返回全部 35 个工具；tools/call 能跑图查询
- 长任务发 notifications/progress
- notifications/cancelled 能中止分析
- 未知工具返回规范错误，不再 _isDegraded 假冒成功

---

## 4. MCP client（TS，新增 src-ui/src/agent/mcp/client.ts）

### 4.1 职责
让 HoloGram 的 Agent 能调用**外部 MCP server** 的工具，并把它们注册进 ToolRegistry。

### 4.2 组件

    interface McpClientConfig {
      serverName: string;                  // 本地命名空间，工具名带前缀
      // 传输二选一：
      transport: 'stdio' | 'streamable-http';
      command?: string;                    // stdio：子进程可执行
      args?: string[];                     // stdio
      url?: string;                        // streamable-http
      headers?: Record<string, string>;    // streamable-http
      failurePolicy?: 'startup-error' | 'lazy';
    }

    class McpClient {
      async connect(): Promise<void>;      // 握手 + 拉 tools/list
      disconnect(): void;                  // 断开 + 卸载其工具
      listRemoteTools(): McpToolSchema[];  // 远端工具
      callTool(name, args, signal?): Promise<McpResult>;  // 调远端工具
      onProgress?(notification): void;     // 进度转发
    }

### 4.3 工具名规范
外部工具注册进 Registry 用 mcp__<serverName>__<rawName>（参考 dsh 的 mcp-client 做法），避免与本地 hologram 工具冲突。SDK/Prompt 里声明时保留该限定名。

### 4.4 接入点
- 在 agent-builder.ts 的 buildToolRegistry 旁新增 buildMcpTools(client, exec)：把每个远端工具包装成 Tool，execute 走 client.callTool。
- 在 ToolExecutor 里为 mcp 工具走 McpClient.callTool，其余逻辑不变。

### 4.5 进度/取消
- callTool 透传 AbortSignal -> 支持 notifications/cancelled
- notifications/progress -> 桥接成 onProgress 回调（可复用现有 tool onProgress 通道）

### 4.6 验收
- 建一个测试 MCP server（如 echo/repo 工具），HoloGram Agent 能通过 mcp__* 工具调用它
- 工具出现在 registry.schemas()，模型能看到并能调用
- 断开重连能重建工具集
- stdio 与 streamable-http 两个传输都通

---

## 5. ACP server（TS，新增 src-ui/src/agent/acp/server.ts）

### 5.1 职责
让外部程序把 HoloGram 的 **Agent** 当驱动对象：发 prompt、收流式输出、取消、处理权限请求。

### 5.2 协议面（ACP 规范）
| method | 作用 |
|--------|------|
| initialize | 版本协商 + capabilities 声明 |
| session/new | 新建一个 Agent 会话 |
| session/prompt | 发送 prompt，进入流式输出 |
| session/cancel | 取消当前 prompt（Agent 的 AbortSignal） |
| session/update | 流式输出：agent_message_chunk 等 |
| session/request_permission | 权限请求（走现有 permission-ask） |

### 5.3 落地映射（复用你已有的 Agent）
- session/new -> 创建一个 Agent 实例（复用 runtime/agent-builder.ts 的构建逻辑）
- session/prompt -> agent.run(signal, text)，把流式 chunk 转成 agent_message_chunk
- session/cancel -> abort 对应 run 的 signal
- request_permission -> 接 src-tauri permission-ask 事件
- 生产者：当前用 stdio（JSON-RPC over stdin/stdout）起步，后续可加 SSE/WebSocket

### 5.4 工具集
受 ACP 驱动的 Agent 工具集，起点 = 你 standard 那套（coding + hologram 图工具 + subagent 等）。可通过 ACP capabilities 声明限制范围（如只暴露只读工具）。

### 5.5 验收
- 用标准 ACP client（或用 Python/curl 手写 JSON-RPC）能：initialize -> session/new -> prompt -> 收到流式输出 -> cancel
- 权限请求能被外部回答 allow/reject
- 与主 GUI 的 Agent 并行运行不冲突（会话隔离）

---

## 6. 实现顺序（建议）

按依赖倒排：

1. **MCP server 补全**（Rust，你已有一半）—— 工作量最小、独立，先做
2. **MCP client**（TS）—— 依赖 server 完善后便于互测；同时打通"Agent 调外部工具"
3. **ACP server**（TS）—— 依赖 Agent 已有的 run/stream/signal，最后做

> 理由：1 是已有基础上补全；2 能立刻用到 1（自测闭环）；3 完全依赖 Agent 能力，放最后最稳。

---

## 7. 参考资料 / 遵循范式

- MCP 规范：https://modelcontextprotocol.io （client/server 角色、transport、notification、isError）
- ACP 规范：https://agentclientprotocol.com （session/prompt/cancel/流式/permission）
- dsh 的 packages/mcp/mcp-client 和 packages/acp/acp：作为"标准角色长什么样"的参考实现（读它学范式，不抄代码）

---

## 8. 设计铁律（实施时勿违）

1. **三个角色分开建**，不发明"双向协议"。MCP client 和 MCP server 是两个组件。
2. **MCP client / ACP server 必须在 TS**（Agent 在 TS）；**MCP server 留在 Rust**（能力在 Rust）。
3. **会话/对话实体只在 TS**。ACP 驱动它；Rust 引擎没有对话实体，别在 Rust 造。
4. **MCP server 不再用 _isDegraded 冒充成功**——用规范错误码和 isError。
5. **工具命名隔离**：外部工具用 mcp__<server>__<name> 前缀，不与 hologram 冲突。
6. 每个角色照规范填满方法，不做非标准扩展；被 ACP/MCP 驱动的行为必须与 GUI 一致（同一 Agent、同一会话语义）。
