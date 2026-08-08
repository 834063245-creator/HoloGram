# ADR 0001: Provider 身份三合一（ProviderId = 配置身份 = 系统凭据键 = 动态模型合并键）

Provider 的身份复用同一个值（`ProviderSettings.name` / `ProviderId`）：它同时是 localStorage 中的配置标识、系统加密凭据（Windows DPAPI）的存取键，以及运行时动态模型合并的缓存键。我们选择「单一身份」而不是「配置 id / 凭据键 / 缓存键各一个独立 id」，因为这三处本来就必须一一对应——凭据属于该 Provider，动态模型也按该 Provider 拉取；拆分只会引入映射表和同步 bug，没有任何独立的可变化轴。

**Consequences**：改名 Provider 必须同时迁移三处（localStorage、凭据库、动态模型缓存），因此 `name` 创建后不可修改；代码层面用 branded type `ProviderId` 钉死语义，禁止任意字符串冒充。若未来出现「凭据与配置生命周期不同步」的真实需求，再拆分为独立 id。
