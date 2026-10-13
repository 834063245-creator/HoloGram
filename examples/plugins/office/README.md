# office —— Office 活预览窗插件（可选件）

给「正在改的那份 Office 文件」开一扇**实时渲染浮窗**：窗里跑的不是插件自己的页面，而是本机
`officecli watch` 服务的环回页（契约 v28 的「环回远端视图」形态）。

> **注意（2026-09-13 C 路改判；2026-09-15 R3 重构）**：本插件**不再挂 MCP server**。OfficeCLI 的读写能力已由兰台
> **内置 office 域工具**（`office(action,…)`）承担——经 `process_cap` 的 `office_exec` 动作在
> 沙箱里 spawn（命令由 Rust 拼装；权限只审声明的目标文件 `file`/`out`）+ 审计 + plan 按 action 分档。
> 本插件只负责"看"。
> 完整计划与实测数据：[`docs/archive/kernel-tooling-line/office-cli-integration-plan.md`](../../../docs/archive/kernel-tooling-line/office-cli-integration-plan.md) §10（C 路）与 §11（真机复盘 + R3 重构）。

## 1. 装

```powershell
# ① 二进制（读写能力用；活预览窗的 watch 也从它起）——正式安装包已自带（宿主 exe 同级）；
#    开发机用取件脚本或安装器装到标准位：
node scripts\fetch-officecli.mjs                            # 仓库根跑（推荐）
..\..\office-cli\install-officecli.ps1 -FromRelease        # 或 -FromLocal <已下载件>

# ② 本插件（可选的活预览窗）：设置 → 插件 → 安装框填本目录绝对路径 → 安装
```

二进制**不进插件目录**（正式包随兰台分发到宿主 exe 同级；开发机走标准安装位 `%USERPROFILE%\.lantai\tools\officecli\`），所以本插件目录很小、
换版本只换那一个文件。

## 2. 用

```powershell
# watch 必须由**你自己**用绝对路径起（Agent 的 shell 里没有 officecli——PATH 里没有它，
# 域工具只在它自己 spawn 的 shell 里解析二进制；别让 Agent 去找二进制起第二条通道）：
& "$env:USERPROFILE\.lantai\tools\officecli\officecli.exe" watch D:\path\to\文档.docx   # 打印 http://localhost:26315
# 然后让 Agent 调 office_preview_open 开窗
```

> ⚠️ **watch 占着的文件，Agent 能改，但两件事要知道（2026-09-15 受控实测）**：
> ① 域工具**不起自己的常驻进程**（`OFFICECLI_NO_AUTO_RESIDENT`），`view`/`set`/`add`/`batch`
> 在你的 watch resident 在场时照常工作、写入**照常落盘**（读回命中，等待 idle-autosave 之后也不被覆盖）；
> ② 唯一冲突是 **`create`**：watch 的 resident 持有文件锁时 `create` 被硬拒（`--force` 也无效），
> 所以域工具在 `create` 前会**自动 close 掉你的 resident**（结果里会说明）——**你的活预览窗需要重新起 watch**。
> 另外：resident 持有期间，**外部程序**（Excel/WPS/兰台媒体回读）读该文件会被锁住。

- 改文档 → watch 经 SSE 推**增量补丁**（实测约 0.6 s 一条 `word-patch`）→ 窗内自动刷新，
  **不需要轮询、也不需要重开窗**。
- 窗内容是**跨源远端页**：iframe 给 `allow-same-origin`（保住它自己的 origin，同源 SSE/fetch 才通——
  实测该服务不回 CORS 头，opaque origin 下活刷新必死），**但不绑宿主桥**（远端页不是插件代码）。
- 白名单硬边界：只许 127.0.0.1 / localhost / ::1，禁凭据，禁公网，**禁 fullscreen**（远端文档能覆盖
  宿主视觉面，全屏形态把界面辨识度也拿走）。
- 端口变了（`officecli watch --port N`）要同步改 manifest 里的 url——窗指向声明值，不做发现。
- **不想起 watch 的场合**：用截图路（`office(action='screenshot', out=…)` + `show_asset` 原地刷新纸面
  资产块）——零后台进程，代价是图不自动跟。

## 3. 边界（如实列出）

- **模型看不到工具结果里的图**：工具结果契约是纯文本，`screenshot` 产出的是**盘上 PNG**——
  用 `show_asset(kind='file', payload={filePath, ext:'png'})` 交给用户看；模型的机械自检走
  `validate` + `view issues`，视觉终审交人判。
- **watch 进程不随窗自动停**，且**只能由用户自己起**（Agent 的 shell 里没有 officecli，域工具也没有
  watch 动作）；本插件只开窗。
- **watch 占着的文件别同时让 Agent 改**（见 §2 的 ⚠️）：两边的 resident 会抢同一个文件。
- 版本漂移快：二进制按 pin 版本（1.0.149）验证；升版本走安装器换哈希 + 重跑
  `src-ui/tests/office-domain.test.ts` 与 Rust 侧 `process_cap::tests::office_command_real_binary_e2e`。

## 4. 守护测试

`src-ui/tests/office-plugin-example.test.ts`（形状：**不含 mcpServers**、app.url 环回、工具口成对、
二进制不进目录）+ `src-ui/tests/office-plugin-loader.test.ts`（真实装载路径：窗口定义 kind=remote、
工具行在册、**无 MCP 行**、卸载收口）。office 域工具本身的守护在 `src-ui/tests/office-domain.test.ts`
（18 例：argv / 目标声明 / 退出码 / 分块 / plan 分档）+ 强制层 Rust
（`tools::office_permission_tests` 权限矩阵、`process_cap::tests::office_exec_*` 与真二进制 e2e——
2026-09-15 R3 起命令拼装与 spawn 都在 Rust，端到端随之搬过去）。
