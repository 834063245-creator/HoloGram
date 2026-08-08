# HoloGram

HoloGram 是深空代码拓扑观测站：把代码库解析成可对话的依赖星图，并通过 AI 代理辅助分析。本词汇表是应用级统一语言，当前先锁定「模型接入」这一簇；其他簇随概念澄清逐步加入。

## Language

### 模型接入（Provider 域）

**Provider**:
Agent 可用来与模型对话的接入点，由端点、凭据与默认模型构成。代码标识符统一用 Provider；界面中文展示词为「信号源」。
_Avoid_: 信号源（代码标识符）、服务商、backend

**ProviderId**:
Provider 的身份标识，唯一且不可变；同时是系统凭据键与动态模型合并键（三合一）。它是身份，不是显示名。
_Avoid_: name（当身份使用时）、providerName、字符串

**Vendor**:
提供模型 API 的品牌或组织（如 DeepSeek、Anthropic、GLM）。一个 Provider 通常指向一个 Vendor，但 Vendor 是品牌，不是接入配置。
_Avoid_: provider、服务商、公司

**Protocol**:
模型 API 的线上方言：Anthropic Messages 或 OpenAI 兼容。决定请求如何构造与解析；与 Vendor 正交（同一 Vendor 可提供不同 Protocol 的端点）。
_Avoid_: kind、API 类型、厂商协议

**Model**:
Vendor 提供的具体模型，有唯一标识与能力元数据（上下文窗口、成本、是否支持推理）。
_Avoid_: 模型名、model id、LLM

**ModelId**:
标识具体模型的字符串（如 deepseek-v4-pro）。它是 Model 的身份，不是 Model 本身。
_Avoid_: model、模型名

**ThinkingPolicy**:
用户对「模型作答前推理多少」的配置。按 Protocol 分为 Anthropic 的 effort 等级与 OpenAI 兼容的深度思考开关；区别于模型能力（是否支持推理）与响应中的思维链内容。
_Avoid_: thinking、深度思考、reasoning（作设置名）

**ConnectionProbe**:
对 Provider 的一次最小连通性验证，产生结果：成功/失败、耗时、时间与消息。它是检查动作及其结果，不是 Provider 配置。
_Avoid_: 测试连接结果、lastTest、testStatus

**Credential**:
与 Provider 关联的 API Key。只存在于系统加密存储，本地持久化中永不明文。
_Avoid_: key、apiKey、密钥

**Catalog**:
内置模型注册表：静态目录条目与运行时从 Vendor 拉取的动态条目合并而成。
_Avoid_: 模型列表、registry
