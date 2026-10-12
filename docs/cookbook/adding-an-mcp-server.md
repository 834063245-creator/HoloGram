# Adding an MCP Server（挂接外部 MCP server）

> 平台契约示例（平台化 Phase 6）。真源：`src/plugins/mcp-bridge.ts`（机器桥）+ `examples/plugins/dataflow-mcp/`（端到端活例子）。

## 声明式挂接（manifest.mcpServers）

```json
{
  "name": "my-mcp",
  "version": "1.0.0",
  "entry": "entry.js",
  "mcpServers": [
    {
      "name": "dataflow",
      "transport": "stdio",
      "command": "node",
      "args": ["./server.cjs"],
      "failurePolicy": "startup-error",
      "readOnly": true
    }
  ]
}
```

- `command` 相对插件目录解析（含分隔符形态）；`args` 的 `./`/`../` 前缀相对插件目录解析，其余原样。
- `failurePolicy`：`startup-error`（装载期急连接验证，失败 = 插件 error）| `lazy`（缺省——首装配连接，失败 = 空集 + 下次装配重试）。
- `readOnly`（可选）：该 server 全部工具的只读担保。**缺省不表态**——按远端 `annotations.readOnlyHint` 判，远端也无声明则 fail-closed **视为写**（plan 模式拦截 + 退出只读并行组）。只读 server 请显式声明 `true`，写型 server 勿声明。判定真源 = `src/agent/mcp/registry.ts` 的 `resolveMcpToolReadOnly`。
- 一个 server = 一条工具贡献（行 id `plugin/<插件名>/mcp/<server名>`）——**patch/preset 可寻址禁用**。
- 工具名前缀 `mcp__<server名>__<工具名>`；进程 kill 归插件 fiber disposer（链式停）。
- ⚠️ **该子进程是全权用户进程**：不经 `fs_cap`、不受 `os_sandbox` 约束（可写任意路径）——需要沙箱/权限类/审计的动作应走 `process_cap`（shell 域）而不是 MCP 路。

## 用户级挂接（不写插件）：`~/.lantai/mcp.json`

只想给自己加一个 server、不打算发插件包时走这条（跨项目生效）：

```json
{
  "mcpServers": [
    {
      "name": "my-tools",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@some/mcp-server"]
    }
  ]
}
```

- **路径**：`~/.lantai/mcp.json`（Windows = `%USERPROFILE%\.lantai\mcp.json`）。也收映射形态 `{ "mcpServers": { "my-tools": { … } } }`。
- **条目 schema 与 `manifest.mcpServers` 同构**（复用 `McpServerDeclSchema`，单一真源）——字段含义与上节一致（`failurePolicy` / `readOnly` 都在）。
- **`command` 解析与插件不同**：用户级的裸名（`npx` / `node` / `uvx`）**走 PATH**；`./x` 形态相对 `~/.lantai` 解析。插件里的 `./` 才是相对插件目录。
- **宽容语义**：缺文件 / 坏 JSON / 空表 = 没有 server（不算错误）；**单条目 schema 失败只跳过该条**，原因进可见诊断（设置 → MCP 页）。
- 工具贡献行 id = `plugin/user/mcp/<server>`——patch / preset 里可按它禁用。
- 装载真源 `src-ui/src/plugins/user-mcp.ts`（复用插件的治理分岔与生命周期，受治字段在场走 ServerGovernor）；守卫 `tests/user-mcp.test.ts`。

## 协议面（MCP JSON-RPC over stdio）

- `initialize` → 返回 capabilities.tools + serverInfo；
- `tools/list` → 工具 schema（name/description/inputSchema + 可选 `annotations.readOnlyHint`）；
- `tools/call` → 结果 `{ content: [{ type: 'text', text }], isError? }`。
  **注意**：兰台的工具结果契约是纯文本（`Tool.execute(): Promise<string>`）——image 等非 text 内容块会被丢弃（模型看不到工具结果里的图）。
- 完整可运行参考：`examples/plugins/dataflow-mcp/server.cjs`（零依赖，直读 .lantai/dataflow/ 文件）。

## 端到端验证

- `tests/mcp-bridge.test.ts`：折算与解析域（行 id / 惰性连接 / 相对命令解析 / failurePolicy / 只读语义）。
- `tests/office-cli-e2e.test.ts`：**真实外部二进制**端到端（真 stdio + 真进程；二进制缺席自动跳过）——装载→工具面→真命令→真落盘/截图/批注/xlsx 全覆盖，是"照着本文挂一个真 server"的可运行样板。
- `tests/office-plugin-example.test.ts`：载体形态（`./bin/xxx.exe` 相对命令 + 插件目录锚）真机语义。
- MCP 是**能力加面路径之一**（不是唯一）——同一能力既可走进程内 seam，也可走外部 MCP server（D1 收口）。
