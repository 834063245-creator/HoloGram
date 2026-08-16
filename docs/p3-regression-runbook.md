# P3 真机回归 Runbook（需要真实 API Key）

> 状态：API 级预检已实跑 6/6（DeepSeek/GLM，`ef65d07`）；UI 级检查仍需打开 App + 真实 Key。脚本只做 API 级预检。

## 前置条件

- 本地构建可用：`cd src-ui && npm run build`（或 `cargo tauri build` 打真包）
- 真实 Key：DeepSeek（`sk-...`）、Anthropic（`sk-ant-...`）；GLM / Ollama 可选
- Key 只从环境变量或系统凭据读取，**不要写进脚本或仓库**

## API 级预检（脚本）

方式 A：凭据直读（推荐，Key 不落盘、不打印）

```powershell
# 脚本从 %LOCALAPPDATA%\com.hologram.app\credentials.enc（DPAPI）解密后经 stdin 传入
node scripts/p3-regression/check-providers.mjs --from-stdin
```

方式 B：环境变量

```powershell
cd scripts/p3-regression
$env:DEEPSEEK_KEY='sk-...'
$env:ANTHROPIC_KEY='sk-ant-...'
node check-providers.mjs
```

> 不要把 Key 粘贴进聊天/文档；`--from-stdin` 模式由本机 DPAPI 解密后管道直传，全程不落盘。
> Anthropic 需要 App 内已配置 Key（credentials.enc 中有 anthropic 条目），否则脚本会 SKIP。

脚本逐项检查：

1. DeepSeek 带工具一轮：`chat/completions` + tools，要求模型返回 `tool_calls`（不只文本）
2. DeepSeek 翻译器：system=翻译指令，验证返回译文且非空
3. Anthropic 带工具一轮：`messages` + tools，验证 `stop_reason=tool_use`
4. Anthropic 翻译器：同上，验证非空译文
5. OpenAI 兼容 `/models` 枚举（DeepSeek/GLM/Ollama 可用时）

任一项失败 → 先看错误分类（`[密钥错误]` / `[网络问题]` / `[地址错误]` / `[模型不存在]`），再进 App 复现。

> 2026-08-08 实跑记录：DeepSeek（deepseek-v4-flash）与 GLM（glm-4.5）各 3 项（/models 发现、带工具一轮、翻译器）全过；
> 翻译器预算须 ≥1024 token（推理模型会先消耗思考链）；Anthropic 因 App 无凭据 SKIP，Ollama 因本地未启动 SKIP。

## UI 级检查清单（App 内）

### DeepSeek / Claude 带工具一轮

- [ ] Provider 页填入真实 Key → 状态点变「正常」（测试连接通过）
- [ ] 新建聊天，让 Agent「读取某个文件并总结」→ 应出现工具调用卡片（含参数预览）
- [ ] 工具完成后流式输出继续，无白屏/无「工具无结果」
- [ ] 深色/浅色主题下工具卡片与 `tool-*` 状态点可读

### 翻译器

- [ ] 触发翻译器（翻译一段中文→英文），输出为译文且无思考链混入正文
- [ ] 翻译期间状态条/Footer 正常

### 摘要模型选择

- [ ] 摘要入口可选择与聊天不同的 Model
- [ ] 选择后保存并重建 Agent，不弹 Provider 保存条（两域 dirty 不复位串扰）

### 思考强度入口

- [ ] 聊天面板 ModelSwitcher：OpenAI 兼容显示「深度思考」开关；Anthropic 显示 effort 下拉
- [ ] 修改后立即保存并重建 Agent；菜单不误关
- [ ] a11y：触发器 `aria-haspopup/aria-expanded`，子项 `menuitemradio/menuitem`，Esc 可关

### Provider 暂存流程（真凭据）

- [ ] 新增 Provider（catalog chip / 自定义）→ 保存 → 凭据落加密库
- [ ] 清除 Key → 保存 → 重启 App 后 Key 不复活（`"null"` 复活回归）
- [ ] 删除 Provider → 保存 → 凭据一并删除

## 判定

- API 预检 5/5 通过 + UI 清单全勾 → P3 关闭
- 任一失败：按错误分类修复，失败项重跑后再勾
