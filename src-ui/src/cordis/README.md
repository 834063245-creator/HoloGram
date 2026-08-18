# src/cordis — Cordis 内核（vendored）

> cordis-migration 工程的内核落点。工程主文档：`docs/plans/cordis-migration/`。

## 文件构成

| 文件 | 性质 |
|---|---|
| `context/events/fiber/index/logger/reflect/registry/service/utils.ts` | **vendor**：DSH `vendor/cordis` 原样拷贝 |
| `cosmokit.ts` | **vendor 子集**：仅收内核实际 import 的成员，函数体逐字拷贝 |
| `standard-schema.ts` | **vendor**：`@standard-schema/spec@1.1.0` 的 `dist/index.d.ts` 拷贝 |
| `boot.ts` | **HoloGram 自有**：根 Context 引导（initCordisKernel / getCordisRoot） |
| `LICENSE` | 上游 cordis 的 MIT 许可证原文 |

## 溯源（provenance）

- 内核 9 文件拷贝自 DeepSeek Harness（DSH）的 `vendor/cordis`（上游：Shigma 的
  cordis，MIT）。拷贝时做了**机械重写**（不改语义）：
  1. 相对 import 剥除 `.ts` 扩展名（本项目 tsconfig 未开 allowImportingTsExtensions）；
  2. `@deepseek-ai/cosmokit` → `./cosmokit`（本地子集）；
  3. `@standard-schema/spec` → `./standard-schema`（本地类型拷贝）。
- `cosmokit.ts`：上游完整实现含 Node Buffer 分支（Binary/base64/hex），webview
  不需要，未纳入。仅收：`defineProperty` / `isNullable` / `hyphenate`（值）+
  `Dict` / `Awaitable` / `Promisify`（类型）。
- `standard-schema.ts`：唯一改动是末行 `export` → `export type`（适配
  isolatedModules）。

## 版本基线

- cordis：`@deepseek-ai/cordis` 4.0.1（DSH vendor 快照）
- cosmokit：`@deepseek-ai/cosmokit` 1.8.2（DSH vendor 快照）
- @standard-schema/spec：1.1.0

## 工程纪律

- **禁止就地改内核逻辑**。升级 = 从上游重新拷贝 + 重跑同样的机械重写 + 全量门禁
  （build / vitest / biome）。
- biome 对 vendor 文件整体关闭 formatter / linter / assist（见 biome.json
  overrides 的显式文件清单）——frozen 拷贝保持上游原样，升级时好 diff。
- HoloGram 侧的适配代码一律写在 `boot.ts` 或各消费方，不进 vendor 文件。
