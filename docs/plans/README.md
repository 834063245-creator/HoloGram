# docs/plans — 计划与现状入口（人类优先）

> 这一页回答三个问题：**现在在哪 / 还剩什么没做 / 想深入去哪读**。
> 时间轴与施工史在 [`HISTORY.md`](HISTORY.md)；**已竣工的计划全文在 `docs/archive/`**——本页只活在办项 + 一句指针。
> 状态词：In progress（干着）/ Proposed·Draft（立项未开工）/ 搁置（等条件）。
> 维护纪律：**竣工即归档**（CONVENTIONS §4）——`npm run doc-check` 的 archive 查已上牙：plans/ 下挂竣工横幅 = 门禁红。

## 一句话现状（2026-09-26）

**兰台（Lantai）= 纸壳（注疏案卷工作台）为唯一主界面的桌面 Agent 软件**；HoloGram 图谱引擎是随包配套的
独立进程（应用内默认关），不再是应用内的主叙事。**九月的建设高峰（内核能力口收口 / 插件 bundle 退役 / 组合层
S0-S7 / 图谱退役 / 会话存盘换轨 / 文档面 P0-P3）已过，当前在办以「真机体感验收」为最大宗**——下表真机欠账
多为 09-17～09-21 代码已落地、门禁全绿、只差实机勾销的项。**2026-09-26 两件大事**：① **插件化欠账程序收官**
（账② 物理归家清零：红区 0 产物 / 0 文件 / 0 行，纯壳集 21 → 0；批 0~10 + §4 各项全落，见
[`plugin-extraction-inventory.md`](plugin-extraction-inventory.md)）；② **随包图谱引擎端到端真机四条全通**
（重建 exe，含批 10 把接线搬进产物后的复跑）。此外四条活跃线：paper-shell R5 打磨环 · 画布支
Stage-6（UI/UX 专项）· 文档面重构 P4（索引收尾）· 卷号治理 A+B（09-21 开工）。已竣工线的权威叙事全在
[`docs/archive/`](../archive/README.md)（组合架构 S0-S7、平台化 Phase 0-6、引擎插件化、bundle 退役、内核
能力口收口…）；**跨文档数字一律看 [`docs/facts.generated.md`](../facts.generated.md)，本页不复述**。

## 活跃线（在办）

| 线 | 文档 | 状态 | 一句话 |
|---|---|---|---|
| **文档面重构** | [`doc-surface-refactor-plan.md`](doc-surface-refactor-plan.md) | **P0-P3 已落；P4 在推**（P3 补批 = 11 件竣工件归档；P4a ADR/cookbook/research 三索引已落，docs/README 唯一入口重写进行中） | 四层形态 + 批序 + 豁免账见施工单；门禁 `npm run doc-check`，真源 `scripts/doc-facts.cjs` |
| **paper-shell（R5 打磨环）** | [`paper-shell/README.md`](paper-shell/README.md) | **收尾中** | 剩余工作逐项清单 = [`r5-polish-backlog.md`](paper-shell/r5-polish-backlog.md)（最常看）；视觉决定账本 [`taste-ledger.md`](paper-shell/taste-ledger.md)；管线史 [`HISTORY.md`](paper-shell/HISTORY.md)；走查 [`walkthrough.md`](paper-shell/walkthrough.md)；表面覆盖地图 [`v2-surface-inventory.md`](paper-shell/v2-surface-inventory.md)；访谈 [`interviews/R1-2026-08-20.md`](paper-shell/interviews/R1-2026-08-20.md) |
| **画布空间模型** | [`canvas-space/canvas-space-model-notes.md`](canvas-space/canvas-space-model-notes.md) | **Stage-6 进行中**（UI/UX 专项） | 一纸多卷 / 有界流区 / 宿主模型 / 三层导航；阶段件与返工清单见笔记「展开」段；provider+创作坞联合体检 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) |
| LSP 舰队共享化 | [`lsp-fleet-daemon-plan.md`](lsp-fleet-daemon-plan.md) | 开工（2026-09-09） | 每根目录一套 LSP（hologram-lspd）——16GB 机器内存耗尽的**结构性根治**（当日已落三闸止血） |

## 待执行但已立项（按成本排）

| 项 | 成本 | 说明 |
|---|---|---|
| **pretext 排版引擎** | P1-P5 全竣工 + P4c 远景三档；**余 P2a 对齐 A\|B 环待实机拍板** | 从高度计算器升级为纸面排版引擎（lift 遮罩 / rich-inline 精确测量 / 来文变宽纸条 / 缩远墨迹 LOD 与小地图真墨）——[`pretext-typography-plan.md`](pretext-typography-plan.md) |
| **日志可观测性（失败可见 P0）** | 批 0–2 **已落地**（`06fadbe2` + 本批）；余批 3/4 + **真机验收** | 消灭「失败默认无痕」：事件门面 `agent/obs.ts`（唯一脱敏审查点）+ 用户可见失败唯一漏斗 + 五条接缝（boot / config.load / cred / llm / turn.failed）插桩——规格 [`../design/log-observability-spec.md`](../design/log-observability-spec.md)，计划与事故取证 [`log-observability-plan.md`](log-observability-plan.md)（触发 = 2026-09-27 用户报本地模型调不动，其 log 对该故障的可答信息 0 条） |
| **插件化欠账（总账）** | ✅ **已完成（2026-09-26；2026-09-24 立账）** | 「还有多少没拆」的唯一真值 = [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md)：账①通道迁移 ✅ 全清 / **账② 物理归家 ✅ 清零**（红区 0 产物 / 0 文件 / 0 行；纯壳集 21 → 0）/ 账③ 逐项判定完毕（判内核平台/共享面者已入名册 `shared` 与白名单）；§0.1 的「30 产物源码进 bundle」守卫同批落。**用户裁定六项排期全落**（真机验收 → 9h-5 → 9c-4 → §4-6 → 9f → 批 10 + §4-9 → §4 自裁项收尾）；三色实测见总账 §5，批次表 §6 |
| **嵌入缓存持久化** | 中（`hologram-vector` 单文件 + 单测；不动引擎契约面） | `VECTOR_CACHE` 是进程内 static ⇒ 跨重启命中率 0（实测 2%，全量重建 13.7 分钟/22k 节点）。裁定 = 落 `<data_dir>/vectors.embed.cache`（内容哈希键，头带 backend/dim，不匹配整份丢弃），只写本轮向量故天然有界（~34MB）——[`embedding-cache-persistence-design.md`](embedding-cache-persistence-design.md) |
| **LSP 舰队孤儿回收（Windows）** | 中（`engine` 加 windows-sys + 一个 job 守卫；**第 0 步是复现不是改码**） | Windows 侧没有 die-with-parent（unix 有 PDEATHSIG）⇒ 硬杀/断链时舰队残留（实测 r-a 孤儿跨日存活）。裁定 = Job Object `KILL_ON_JOB_CLOSE`，句柄持在**拉舰队的那个进程**（lspd 仍要独立于引擎）；不做按名字清理——[`lsp-fleet-orphan-reaping-design.md`](lsp-fleet-orphan-reaping-design.md) |
| **v11 分析引擎** | 草案挂起（用户拍板挂起） | 动态边 + 查询预算 + 降噪分级三篇合一——[`v11-analysis-engine-master-plan.md`](v11-analysis-engine-master-plan.md)；D 篇原件 [`docs/archive/kernel-tooling-line/dynamic-edge-detection-plan.md`](../archive/kernel-tooling-line/dynamic-edge-detection-plan.md)（superseded，以主文档为准） |
| **会话存盘换轨（DSH 参照）** | 未定 | 参照 DSH 的会话持久化审计与移植——[`session-persistence-dsh-port-plan.md`](session-persistence-dsh-port-plan.md) |
| **钉住与纸条改造** | 未定 | 钉住/纸条 UX 重构 + UI 换装——[`pin-strip-rework-plan.md`](pin-strip-rework-plan.md) |
| **Skills 与 MCP 生产级改造** | 余文档收口 + 真机验收 | Commit 1-6 已落地——[`skills-mcp-production-plan.md`](skills-mcp-production-plan.md) |
| **卷首字节稳定性（前缀缓存）** | 中（动段表 + 基线重录双轨） | 记忆库坐卷首第 ~2.5k token ⇒ 每次「重启 + 记忆变动」整卷重算（实测 34.7 万 token 全价、命中率 99%→0.6%）；「把记忆段挪到卷首末尾」已验算**无效**（只省 2.8%）——[`prompt-prefix-stability-plan.md`](prompt-prefix-stability-plan.md) |
| agent-plugin **P4** 插件化全集 | 持续 | **D9 换轨：不等 DSH、自研为主**；存量拆解全清，剩 C12 dsh-compat 合法挂起 + 新能力走通道——[`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) |

## 等外部条件（挂着不动）

| 项 | 等什么 |
|---|---|
| agent-plugin **C12 dsh-compat** | P4 全清后的唯一合法挂起：DSH peer 出非 workspace 版本即启动（外部信号依赖；p4a 调研已备好契约地图，见 [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md)） |
| v4-pro-minimal AB 实验 | Linux 环境（Windows 不可用）；**且旧 harness 已删**（2026-09-16 `77ad6fe7` 后续一笔——`src-ui/tests/ab/` + `scripts/ab-test/` 是图谱时代化石，重跑需先重写 harness）——[`v4-pro-minimal-ab-test-plan.md`](v4-pro-minimal-ab-test-plan.md) |
| repo 改名 GitHub 侧执行 | 用户操作；**2026-09-22 已在现名下发布 v1.0.0** ⇒ 原先「改名前不打发布包」的约束随之作废（改名与否不再卡发版，纯 GitHub 设置面动作） |

## 真机验证欠账（代码完成、未实跑——**本表是唯一在办真值**）

| 项 | 欠什么 |
|---|---|
| ~~V5 拆除后的 Tauri 真机~~ | **大部分已跑（2026-08-22 自主段）**：真机启动 + 纸壳渲染截图取证 ✓；窗口控制 IPC 最大化/还原往返 ✓；冷启动缓存过期→重分析全链路 ✓；优雅关闭 lifecycle 全清 ✓。未覆盖：权限卡桥需真实 agent 写动作触发（需 provider 配置），留给带 API key 的会话 |
| ~~shell 捆绑 bash（P0-P5）~~ | **已实跑（2026-08-22）**：os_sandbox:: 17/17 绿；init_bundled 开发态兑底路径修正一处布局雷；src-ui tsc 绿 → [`docs/archive/kernel-tooling-line/shell-stability-bundled-bash-plan.md`](../archive/kernel-tooling-line/shell-stability-bundled-bash-plan.md) §4 |
| ~~browser CDP E2E-1/2/3/4/5~~ | **已实跑（2026-08-22）**：`cargo test cdp::` 35/35 全绿，含 E2E-5 多账号 cookie 隔离（上会话偶发失败本轮未复现） |
| session-ledger 真机三项 | 代码判据已测试钉死，真机未跑（需带 API key 会话）：① 重启工作集恢复；② 后台卷落盘；③ 续开查重——见 [`../archive/session-ledger-plan.md`](../archive/session-ledger-plan.md) §7（⚠️ ①已被 session-unify Q-B 取代：重启不自动摊开） |
| ~~workspace-flip 批 3 边界~~ | **作废（2026-09-09）**——「预热期内创建的会话缺 graph 工具」随图谱功能全量退役消失（兰台已零引擎内置接线） |
| ~~**分层重构真机验收四项**~~ | **图谱相关项作废（2026-09-09）**：①② 的「图查询」验收点随图谱退役消失；~~③ 跨工作区续开~~ / ~~④ Ungrouped 会话~~ 随归属反转作废——见 [`../archive/layering-rework-plan.md`](../archive/layering-rework-plan.md) §4.6 |
| **画布 Stage-3 实机待验** | 代码已落地（2026-08-25，门禁全绿）：① 书脊手感（左键定位轻动画 / 拖动落位幽灵+吸附 / hover 小卡合卷）；② 侧边栏折叠与状态点/相对时间/行操作；③ 生命周期闭环（新建→落位→展开→收起→删除）；④ 未摊开卷行点击展开补飞 + 视角自由拖拽——见 [`canvas-space/stage-3.md`](canvas-space/stage-3.md) |
| **画布 Stage-4 返工清单（P0-P4）** | 代码面已修（2026-08-26），待实机勾销：P0-1 全放确认+关窗崩溃 / ~~P1-1 自动选中三道闸~~（**拔源勾销 2026-09-10**——浏览跟随随拍板整体退役）/ P1-2 聚焦落点手感 / P3-1 非全屏布局——见 [`canvas-space/stage-4-rework-checklist.md`](canvas-space/stage-4-rework-checklist.md) |
| **创作坞+提供方联合体检验收七项** | 方案甲 + 全批修复已落地（2026-08-26 三 commit，门禁全绿）：① 卷间会话级模型/思考隔离；② 未改卷跟全局/改过卷不跟；③ 重启后各卷配置保留；④ 模型下拉列全+无 Key 标注；⑤ 测试连接后取消不落暂存；⑥ ↑↓ 历史+焦点回归；⑦ 后台卷运行态指示——见 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) |
| **stream-rhythm 真机验收五项** | 代码五批全落地（2026-09-03，门禁全绿），待实机：① 长回合读起来是几个工作单元 + 换气；② Error 处明显转折（前置放空）且 Retry 紧贴；③ 流式活尾重排不引起视口上方跳动；④ 折叠组展开后判别量可见 + 「✓ 阶段完成」锚位置正确；⑤ 旧卷回放渲染正常、滚动不退——另带 **D1 间距三档（32/64/96）、D2 阶段细线形态与刀5 新词汇终审**——见 [`docs/archive/render-paper-line/stream-rhythm-plan.md`](../archive/render-paper-line/stream-rhythm-plan.md) §5 |
| **内核能力口收口 R3+R4 真机四项** | 代码十一插件全退役 + 十一能力口在产（2026-09-05）：① browser 全链路（含 sensitive 二次 Ask 与 audit）；② desktop 全链路（不抢焦点 / input lease 串行 / INVARIANTS #13 链路不变）；③ shell 粘性 cwd + bg 三件；④ 编辑（edit_file diff 快照与权限 Ask）——~~约束读写~~（**作废 2026-09-09**：constraints_cap 随图谱整口删除）——owner：用户 |
| **多模态图片线真机验收六项** | 代码 B1-B5 全落地（2026-09-09，门禁全绿）：① vision 模型贴截图 → 模型描述内容；② 非 vision 模型入口隐藏 + 强行含图不炸；③ 三入口齐验（粘贴/拖放/夹选）；④ 重启后缩略仍显示；⑤ 多图大图预算降级；⑥ 远端图回渲染 + 非白名单降级 alt——见 [`../archive/multimodal-image-plan.md`](../archive/multimodal-image-plan.md) §5——owner：用户 |
| ~~**随包图谱引擎端到端**~~ | ✅ **已实跑（2026-09-25 / 2026-09-26 各一轮，重建 exe）四条全通**：开关可用 + 探测读到引擎；进工作区回执「N 个引擎工具在册」；引擎进程挂 `lantai.exe` 下（一进程一根）；离开工作区引擎真停、lantai 存活。批 10 把接线搬进 `plugins/builtin/bundled-engine/` 后又复跑一轮。证据 = [`../archive/plugin-extraction/workspace-activation-channel-design.md`](../archive/plugin-extraction/workspace-activation-channel-design.md) §7 + 账本 §6.5；回归 `tests/bundled-engine-assembly.test.ts`。 |
| **创作坞浮动化手感** | 代码已落地（2026-09-17，门禁全绿，见 [`../design/lantai-design-spec.md`](../design/lantai-design-spec.md) §9.2）；jsdom 测不到的手感欠四项：① 按住坞书眉行拖动是否跟手（拖动期 PaperPanel 每帧重渲，真机帧率未测）；② 磁吸四锚位（左右缘 / 版心中轴 / 底带 / 最底缘）的吸附距离 24px 是否顺手；③ **双击坞头复位**在 WebView2 真触发（刻意没 `preventDefault` pointerdown，正为它让路）；④ 坞拖离底带后让位件（目次带映射区 / 小地图默认位 / 递牒卡 / 插件 dock）的视觉是否合意——owner：用户 |
| **顶部浮件（标题栏拆除）手感** | 代码已落地（2026-09-17，门禁全绿，见 [`../design/lantai-design-spec.md`](../design/lantai-design-spec.md) §14）；jsdom 测不到的手感欠四项：① **上缘边缘滚动**在真机是否终于顺手（指针甩到屏顶即滚）；② 浮件落位/宽度（右上、右距 120=目次带宽 104+16、宽约 470）在正文之上是否碍眼、是否压到你想看的内容；③ 浮件本体那段 x 区间**不滚**（它是「别的面」）能否接受——不爽可改「背后照滚」（`.pp-chrome` 进 `HOVER_ALLOW_DOCKS`）；④ 窗口拖动只剩浮件抓手（`画布` 二字 + 件间空白）是否够用——owner：用户 |
| **斜杠命令面重做** | 代码已落地（2026-09-19，门禁全绿；契约 v42，见 [`docs/archive/kernel-tooling-line/command-surface-rework-plan.md`](../archive/kernel-tooling-line/command-surface-rework-plan.md)）——待用户体感确认四件：① `/` 面板里 `/settings` `/paper` `/sidebar` `/dock` 是否都在、点了是否生效；② `/trail` 与图分析族（`/fragile` `/cycle` `/impact` `/path`）不再出现；③ 既有命令（`/new` `/compact` `/export` `/memory`）与带参命令（`/remember 事实` · `/goal resume`）照常；④ Ctrl+K 面板里会话内建命令与 `/` 面板一致——owner：用户 |
| **案卷侧栏载入体感** | 代码已落地（2026-09-18 侧栏载入批两批，门禁全绿；病灶与实测见 [`../landmine-map.md`](../landmine-map.md) S6/S8）——待用户体感确认四件：① 开侧栏是否不再「半天出不来」（清点 = 目录枚举 + 一份小 JSON，与历史卷数/体量无关；升级后**首次**开侧栏会补建卷目录，2.5 s 内阻塞 + 之后渐进填入，此后永不再补）；② 流式回话期间整机是否不再发滞；③ 清单读取真失败时是否如实显示错误而不是「本工作区暂无案卷」；④ 几百卷历史下侧栏是否仍即时（若仍慢，请报当时卷数与目录大小）——owner：用户 |
| **出处引导手感** | 代码已落地（2026-09-18，门禁全绿，六条验收见 [`docs/archive/render-paper-line/pin-provenance-plan.md`](../archive/render-paper-line/pin-provenance-plan.md) §6）——待用户体感确认六件：① 页边注第三行常显卷名是否够读、是否碍眼；② hover 引线的朱砂发丝在真纸上是否合意（不合意可换 `--ink-4` 石墨档）；③ **洞不在屏内时** hover 引线是否真的指得对路；④ 点行溯源飞行后「洞点名一拍」是否够醒目；⑤ 「未摊开 / 已删」两态的文案与不可点手感；⑥ 重启后卷名回读是否正常——owner：用户 |
| **会话树「枝」手感（P4-① / P4-③）** | 代码已落地（2026-09-19，门禁全绿，见 [`docs/archive/session-line/session-tree-plan.md`](../archive/session-line/session-tree-plan.md) §5/§12.7/§12.8）——待用户体感确认五件：① 块 hover 出现的「枝」握把位置（块底间距带右端）是否顺手、是否与「改/重发/抄」那一行打架；② 拖出引线的跟手与朱点（落点即所见）是否合意；③ 松手落位（落哪算哪；与既有流区重叠时推最近空位）是否符合预期；④ 一轮里插入内部来文（goal / inbox）后点回复块「立枝」，枝是否含**整轮**（此前只到插入之前）；⑤ **重启后**摊开的父子卷引线是否在片刻内自己出现（冷启动后台水合句柄——见 §12.11）——owner：用户 |
| **退出确认（关窗拦截）** | 代码已落地（2026-09-19，门禁全绿；决定记录见 [`paper-shell/taste-ledger.md`](paper-shell/taste-ledger.md) 末条）——待用户体感确认四件：① 有会话在跑时点 ✕ / Alt+F4 / 任务栏关窗**是否弹出确认**（空闲时应当不弹、直接退）；② 点「留在工作区」后窗口是否留着且能继续干活（下次点 ✕ 重新问）；③ 点「退出并终止本轮」是否正常落盘后退出（不卡死、不白屏）；④ 弹层是否盖得住纸壳与命令面板。**须重建 exe**（壳域改动）——owner：用户 |
| **目次带加宽（缘滚跑道）手感** | 代码已落地（2026-09-19 加宽批 + 同日甲案，门禁全绿；病灶与几何见 [§13](../design/lantai-design-spec.md)）——待用户体感确认三件：① 带体 104px（识别层满宽 + 控制列 64 + 缘滚跑道 40）是否碍眼/压正文；② **读带/拖带时视口是否不再自己跑**；③ 贴屏最右是否照旧起滚，且**不弹 hover 卡、点击不跳视口**（跑道惰性）。④ 甲案观感：**界栏线已于 2026-09-21 摘除**（用户「我从来也没拍板过界栏线」——归因更正见 [taste-ledger](paper-shell/taste-ledger.md) 同日条；识别层铺满保留、仍待验收）。**须重建 exe**（插件 CSS 进壳 bundle；此后 CSS 微调走三步热更，边界见 [dev-workflow](../dev-workflow.md)）——owner：用户 |
| **左缘边缘滚动（书脊列压带）手感** | 代码已落地（2026-09-22 左缘批，门禁全绿；病灶与判据见 [§12.1 契约 9](../design/lantai-design-spec.md)）——待用户体感确认两件：① **贴死屏左是否起滚**（最左 6px 内距带：指针甩到屏左即被屏缘钉住；已实机探针验过 Δ=+909/+1164）；② 起滚区**只有那条内距带 + 书缝 + 末脊之下空白**——脊块/题签/小卡/按钮一律不滚（它们是瞄准面），这个宽度（6px）是否够用、是否要改成「给列加一条 36px 左跑道」（脊块整条右推、列 72 → 108px 的可见改动，见 [taste-ledger](paper-shell/taste-ledger.md) 同日条「弃 ②」）。**产物热更即可**（插件产物 `paper-shell`，无需重建 exe）——owner：用户 |
| **匣脚引线（多会话卷的激活态）手感** | 代码已落地（2026-09-22 批；2026-09-24 **纯指示化 + 归因更正**——「可点溯源」系 agent 自记，用户否认后受墨带/点击/焦点态整批摘除，见 [taste-ledger](paper-shell/taste-ledger.md) 同日条；设计见 [§9.3](../design/lantai-design-spec.md)）——待体感确认六件：① 常显线是否够读、碍眼；② .55 墨阶（**无 hover 档**）；③ 切卷「旧线撤 + 新线淡入 + 朱笔划界」是否读得出换绑；④ 坞拖走时线随坞拉长好不好看；⑤ 活卷在屏外时线指得对不对路（原「点线飞过去」判据已废，改由目次带/跳键走卷核对）；⑥ 纸脚落点是否合意（下个候选＝纸的左缘下端）。**产物热更即见行为变化**；本次踩到删 CSS 的边界（彻底干净须重建 exe）——owner：用户 |
| **L3 回复链路活性（运行看门狗）** | landmine L3 **已拆**（2026-09-20，门禁全绿；契约 v44，见 [`../landmine-map.md`](../landmine-map.md) L3）——运行看门狗（无进展硬截止 + 遗弃语义）+ 停止走同一竞速真解旋；**真机复现证据欠**：临时把阈值压到 60s（`setRunWatchdogThresholds`）+ 假 provider／拔网线实跑，取 `ui.log` 两条 `log.warn('agent', …)`（`no_progress_ms`／`last_pulse`），确认「无进展 → 硬截止作废 → 落墓碑 → 可重发」在真机成立——owner：开发侧（阈值注入 + 假 provider，不待用户） |
| **役册（后台工作监视面）手感** | 代码已落地（2026-09-22，门禁全绿；设计与边界见 [§9.4](../design/lantai-design-spec.md)，数据面取证见 [`../landmine-map.md`](../landmine-map.md) L5）——待用户体感确认五件：① 设置行行尾多一枚「役 N」是否显得挤（**役内墨外**，墨仍收最右）；② 册页在坞上方弹出（300px 宽 / 封高 `min(70vh,520px)`）是否合意、三段排序与条数够不够；③ 三秒一轮对账在真机有无可感开销（**恒跑**，空转轮不重渲）；④ 逐条「停」是否真能停掉后台命令（`bash_kill` 用户路径）+ 停完立刻落「已了」是否读得懂；⑤ 子代理条目**只读**（无逐条停）能否接受。2026-10-07 修**读数不随任务起停自更**（对账改恒跑 + 役点呼吸收编 `pp-ink-live`）：动 `compose-dock` 产物与壳 bundle（`PaperPanel.css`）⇒ 重建 exe 后复核 ①③——owner：用户 |
| **provider「刷新目录」CORS 修复** | landmine N1 **已拆**（2026-09-23，门禁全绿：`cargo test` 494 + 1，协议级回归先证红后转绿；见 [`../landmine-map.md`](../landmine-map.md) 第十三批）——上游自带的 `access-control-*` 不再透传（此前成品响应带两条 ACAO，浏览器按 CORS 规范拒收整条响应 ⇒ 凡经代理的调用全废，配了自定义请求头的行 100% 失败）。**须重建 exe**（壳域改动，前端未动）：重建后验收 = 设置 → Provider → opencode 行点「刷新目录」应出目录（此前必报「模型目录获取失败（网络错误或端点无响应）」）；顺带可核对 `commandcodegoat` 行走的是代理而不是静默直连兜底。**已用替身代理在真机页面带真实凭据预验**（2026-09-23：opencode 33 / commandcodegoat 80 个模型，上游皆 200），余 = 重建后点按钮的确认——owner：用户 |
| **图版架（资产收纳面）手感** | 代码已落地（2026-09-23，B1-B3；施工单 §8 施工回执，原计划头部「待施工」已订正）——待用户体感确认 §6 九条：① 架位（坞下一条、正文一字不遮）；② 匣拖最底时架不被屏缘切；③ 匣拖离时架跟随、让位带与其他家具不抖；④ 点签条飞到流内那块并展开；⑤ 拖签条到纸上成钉、签条随即离架且递补无残影；⑥ 钉住张着 + 拔钉回架原位；⑦ 全钉出时整条退场；⑧ 流内图版卡默认一行签条、钉住默认张着；⑨ 空卷时整条不出现（坞位与让位带逐像素同今日）。真源 [`docs/archive/render-paper-line/asset-rack-plan.md`](../archive/render-paper-line/asset-rack-plan.md) §6——owner：用户 |
| **卷号治理 A+B 真机一次** | 代码已落（2026-09-21 拍板；A 显示收口已退号、B 发号账 `_issue.json` 在码）——待你真机跑一次：**删高位卷 → 重启 → 起卷**，确认新卷号**不复用**已删号。真源 [`docs/archive/session-line/volume-number-governance-plan.md`](../archive/session-line/volume-number-governance-plan.md) §7——owner：用户 |
| **随包 LSP 守护（打包补件）** | 新加（2026-10-08）：`tauri.conf.json` 的 `bundle.resources` 补 `hologram-lspd.exe` 映射（引擎按**同目录**查找 lspd：`lsp_manager.rs` 的 `current_exe().parent().join(...)`；此前正式包缺该件 ⇒ 生产里只能回退 local pool）。**未验证**（本机应用在跑，建不了生产包）：**重建 exe 后验收** = 安装目录出现 `hologram-lspd.exe`，且进工作区后舰队真起（不是 local pool 回退）。真源 `docs/archive/kernel-tooling-line/lsp-fleet-daemon-plan.md` §7——owner：用户 |
| **并发会话（多卷同跑）真机五项** | 代码全落（Phase 1-5 拆单槽 + Phase 6 测试面：`tests/concurrent-sessions.test.ts` 226 行 10 用例 + `chat-stream-session-leak.test.ts` 改新 ctx 形状；全量 vitest 绿）——待你真机确认五项：① 两卷同时流式输出、消息**零串卷**；② A 卷在跑时 B 卷**可直接发起新轮次**（不再报「有后台任务运行中」）；③ **两卷同时 ask_user**，各答各的、无 Agent 死等；④ A 后台卷请求写权限时**卡挂 A 的 exec**（卡面带卷徽标）、**停 B 不杀 A 的卡**；⑤ **状态栏只反映活跃卷**（后台卷运行态由创作坞既有指示承担）。真源 [`docs/archive/session-line/concurrent-sessions-plan.md`](../archive/session-line/concurrent-sessions-plan.md) §3——owner：用户 |

| **卷重建丢卡根治（session-rebuild-recovery）** | 代码已落地（2026-10-08，门禁全绿：vitest 416 文件 / 4429 用例 + build + biome 0/0；见 [`../archive/session-line/session-rebuild-recovery-plan.md`](../archive/session-line/session-rebuild-recovery-plan.md)）——待用户体感确认两件：① 打开 51 号卷：3 张表格卡 + 1 张拟策卡恢复出现（拟策只读态）；② 「开卷 → 不操作 → 关」循环后重开：卡片仍在（快照已对齐，不再判陈旧）——owner：用户 |

## 已完成并归档（点名即可，详情勿读）

**2026-10-08 归档大扫（第二批 · 23 份）**：把「代码已完成、只欠真机验收（或已作废）」的**过程文档**整批移出 `docs/plans/`——
**会话线 4**（[`session-line/`](../archive/session-line/README.md)）· **渲染纸面线 8**（[`render-paper-line/`](../archive/render-paper-line/README.md)）·
**内核工具平台线 11**（[`kernel-tooling-line/`](../archive/kernel-tooling-line/README.md)）。判据 = **「过程文档是否还活着」，不是「验收跑没跑完」**
（CONVENTIONS §4：「待实机 / 验收 / 欠账」不算在办标记）——**真机欠账一行未删，全在本页欠账表**。
补（同日）：**纸壳交互承接**（8/8 全销账、守护断链集 = 空）与**卷号治理 A+B**（代码已落、余真机一次）按同判据归入 `render-paper-line/` / `session-line/`。同日早些时候已归档 8 份插件化欠账施工单（[`plugin-extraction/`](../archive/plugin-extraction/README.md)）。
**同日追加（2026-10-08 深夜）**：会话线 `session-line/` +1——[`session-rebuild-recovery-plan.md`](../archive/session-line/session-rebuild-recovery-plan.md)（卷重建丢卡根治：资产/拟策块自工具回执恢复 + 开卷落盘断循环；案卷 51 真机取证立案，当日施工当日归档）。

**2026-09-16 P3 归档批**（全文在 [`docs/archive/`](../archive/README.md)，索引见 [`../archive/README.md`](../archive/README.md)）：
组合架构 S0-S6 全树（[`composition-architecture/`](../archive/composition-architecture/README.md)——S6 设计件
[`S6-per-agent-composition.md`](../archive/composition-architecture/designs/S6-per-agent-composition.md)、施工史
[`../archive/composition-architecture/HISTORY.md`](../archive/composition-architecture/HISTORY.md)）·
平台化 Phase 0-6（[`agent-platformization-plan.md`](../archive/agent-platformization-plan.md)）·
插件 bundle 退役（[`plugin-bundle-retirement-plan.md`](../archive/plugin-bundle-retirement-plan.md)）·
内置插件名册单一真源（[`builtin-plugin-roster-single-source.md`](../archive/builtin-plugin-roster-single-source.md)）·
前端浮层/a11y 修复（[`frontend-overlay-a11y-plan.md`](../archive/frontend-overlay-a11y-plan.md)）·
内核插件运行时 Phase 2 交接窗（[`handoff-p2-window.md`](../archive/handoff-p2-window.md)）。

**2026-09-16 P3b 归档批**（补批：`archive` 查只看头部 15 行横幅，这批「竣工但没写横幅」的件漏网——逐条取证后归档；
各件顶部已加归档横幅 + 现状指针；施工史见 [`HISTORY.md`](HISTORY.md)）：
[`engine-plugin-extraction.md`](../archive/engine-plugin-extraction.md)（引擎插件化 Phase 0-5）·
[`layering-rework-plan.md`](../archive/layering-rework-plan.md)（分层重构 L1-L4 + L5b crate 化）·
[`first-party-hot-reload-plan.md`](../archive/first-party-hot-reload-plan.md)（第一方热更）·
[`agent-asset-blocks.md`](../archive/agent-asset-blocks.md)（资产块协议 + 渲染跟上批）·
[`multimodal-image-plan.md`](../archive/multimodal-image-plan.md)（多模态图片链 B1-B5；**真机六项欠账仍在办**，见上表）·
[`browser-cdp-suite-review-round2.md`](../archive/browser-cdp-suite-review-round2.md)（CDP 二轮评审；E2E-1..5 已实跑结清）·
[`session-persistence-seam-wiring-plan.md`](../archive/session-persistence-seam-wiring-plan.md)（会话持久化 seam 接线；头注「待施工」已过期）·
[`paper-shell/paper-panel-split-plan.md`](../archive/paper-shell/paper-panel-split-plan.md)（PaperPanel 机械拆解；真机一项待跑）·
[`tool-ergonomics-notes.md`](../archive/tool-ergonomics-notes.md) +
[`tool-ergonomics/design-1-context-waist.md`](../archive/tool-ergonomics/design-1-context-waist.md) +
[`tool-ergonomics/design-2-session-focus.md`](../archive/tool-ergonomics/design-2-session-focus.md)（工具层人体工学 T-1/T-2）。

**更早**（按线点名，施工史在 [`HISTORY.md`](HISTORY.md)）：workspace-flip · 总线归零 + ui/ 拆分 · 岛层退休 ·
cordis-migration · agent-core-convergence（baseline 冻结维护态）· 雷区地图 P0/P1 全拆 · V5 旧前端拆除 ·
session-ledger L0-L3 · workspace-ownership-root-cure（实机验收通过）。

**注意两个活的例外**：`docs/landmine-map.md`（技术债清单，P2 残留与根治级在册）与 convergence 的 baseline
change request 流程（[`../archive/agent-core-convergence/baseline-change-request.md`](../archive/agent-core-convergence/baseline-change-request.md)）
——虽在归档目录，仍是活流程入口。

**内核插件线（已拆除，但决策与能力口仍是现状）**：决策真源
[`kernel-plugin-architecture-decision.md`](kernel-plugin-architecture-decision.md)（v3：TS 策略建议层 + Rust
能力口强制层）及其衍生执行蓝本（R1 [`kernel-permission-strategy-layer-r1.md`](kernel-permission-strategy-layer-r1.md) ·
R2 [`kernel-capability-r2-search-pilot.md`](kernel-capability-r2-search-pilot.md) ·
C3 [`kernel-capability-c3-design.md`](kernel-capability-c3-design.md) ·
D4 [`kernel-capability-d4-handle-design.md`](kernel-capability-d4-handle-design.md)）；
已作废的运行时线记录留 [`docs/archive/kernel-tooling-line/kernel-plugin-runtime-plan.md`](../archive/kernel-tooling-line/kernel-plugin-runtime-plan.md) 与
[`docs/archive/kernel-tooling-line/kernel-plugin-runtime-phase2-design.md`](../archive/kernel-tooling-line/kernel-plugin-runtime-phase2-design.md)。

## 编号对照（防绕晕）

| 编号 | 含义 | 归属 |
|---|---|---|
| R1、R2 | 纸的视觉/交互访谈 | paper-shell |
| R3 | 纸的退役访谈——**作废**（V5 提前拆除，无对象） | — |
| R5 | 打磨环（A 转录段✅ / B 审美段✅ / C 产品化段✅）；另：agent-plugin 的风险编号 R5（Worker CSP spike，已毕）同名不同物 | paper-shell / agent-plugin |
| P1-P4 | agent-plugin 阶段（P1 工具文档✅ / P2 执行原语✅ / P3 cordis 收口✅ / P4 插件化全集·自研为主） | agent-plugin |
| V0-V5 | 纸的管线阶段（全部完成，V5=拆除旧前端） | paper-shell |
| C1-C14 | r5-polish-backlog 产品化项编号 | paper-shell |
| S0-S6 | 组合层阶段——**全段竣工并归档**（S7 真面板并排 ⏸ 搁置，随线归档） | [`../archive/composition-architecture/`](../archive/composition-architecture/README.md) |
| P0-P4（文档面） | 文档面重构批次（P0 立尺 / P1 注入层 / P2 现状层 / P3 归档 / P4 索引） | [`doc-surface-refactor-plan.md`](doc-surface-refactor-plan.md) |
| W1/D-W1-x、D9 | workspace-flip 访谈/设计件（已归档） | — |

> **S7 搁置件的取回方式**：真面板并排（多 core / 多面板）**重启该批时从归档取回并重新立项**——
> 施工单在 [`../archive/composition-architecture/work-orders/WO-S7-multi-core-panels.md`](../archive/composition-architecture/work-orders/WO-S7-multi-core-panels.md)
> （搁置裁定与四道拦路石见其 §0.5/§0.6；当时结论：preset 对本批零依赖，本批也买不到组合隔离）。
