# ADR 0002: Provider 的 `kind` 是协议（Protocol），不是厂商（Vendor）

`ProviderSettings.kind` / `ModelDescriptor.kind` 只有两个值（`anthropic` / `openai`），描述的是线上 API 方言——请求如何构造与解析——而不是品牌：DeepSeek 可以挂 Anthropic 兼容端点，GLM / Ollama 走 OpenAI 兼容。我们刻意不做「按厂商枚举」，因为在出现协议不兼容的新厂商之前，两种协议已覆盖全部真实需求；厂商身份由 Catalog 条目的 `vendor` 字段承载。

**Consequences**：存储字段名保持 `kind`（localStorage 遗留名，改键需带迁移），代码类型统一为 `Protocol`（`provider/types.ts`），UI 文案统一走 `settings/protocol.ts` 的 `PROTOCOL_LABELS`。若未来出现第三种协议，先扩展 `Protocol` 联合类型与标签映射，再谈数据迁移。
