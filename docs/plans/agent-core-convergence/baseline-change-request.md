# Baseline 变更申请 — phase-0/create-agent.wiring.txt（行尾归一 + 提取器修复）

> ⚠️ 状态：**已批准并执行完毕**（2026-08-16）——用户在对话中批准（"那就整"）。
> 本文件同时是后续申请的模板：既有快照漂移时，按本格式重写此文件（对象/理由/
> 证据/拟议内容/落地步骤），停工等用户审批。
> 前例：Phase 4 申请（freeze `45f328a2`）原文见 git 历史。

> 申请日期：2026-08-16 · 申请人：Kimi Code CLI（状态注入缓存生命周期修复期间发现）

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/create-agent.wiring.txt`：
  dispose 段第 23-24 行 `- handle ` → `- handle`（去掉尾空格），仅此 2 行。
- `src-ui/tests/convergence/helpers/wiring.ts`：提取器读取 runtime.ts 时归一
  `\r\n` → `\n`（1 处，见 §2）。
- **模型可见表面零变化**：同一次 record 其余全部快照逐字节一致（git diff
  仅本文件 2 行）。

## 2. 为什么必须变

提取器（wiring.ts `extractWiringFromSource`）对 `_disposeAgent` 语句做
`st.getText(sf).split('\n')[0].replace(/\s+/g, ' ')`。对跨行语句
（`handle\n._getAgent()...`），CRLF 源码的首行末尾带 `\r`，被 `\s+→' '`
压成**尾空格**写进快照——快照内容随工作区行尾漂移：

- Phase 4 freeze（`45f328a2`）在 CRLF 工作区（Windows + `core.autocrlf=true`）
  录制，尾空格 artifact 被冻进 baseline；
- LF 工作区（编辑器/biome 落盘未重归一化）下提取结果无尾空格 → 比对必挂；
- 单行语句文本内部不含换行符，天然免疫——所以只有 2 行漂移。

**该测试在纯 HEAD 上就失败**（与任何未提交改动无关），且 CI 不跑 src-ui
vitest（ci.yml 前端只有 build），漂移长期未暴露。

## 3. 证据

- 纯 HEAD runtime.ts（LF）跑 phase-0：1 failed（wiring 第 23 行 `handle ` vs `handle`）；
- 同一份 HEAD 内容转 CRLF 再跑：**9 passed 全绿**——结果是行尾的纯函数；
- 修复提取器后 `npm run record:convergence`：`git diff` 仅 create-agent.wiring.txt
  2 行尾空格删除，其余 6 个 baseline 文件零变化。

## 4. 拟议变更（record 已生成的内容）

```text
  - handle        （原：`- handle ` 带尾空格 ×2 行）
```

提取器修复（wiring.ts）：

```ts
return extractWiringFromSource(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), methodNames);
```

修复后快照对 LF/CRLF 工作区均确定，同类漂移不会复发。

## 5. 落地步骤（已执行）

1. 提取器归一修复（wiring.ts）+ 本文件重写 —— 随实现改动提交；
2. `npm run record:convergence` 重录 baseline（diff 仅 2 行）；
3. `npm run verify:convergence` + 全量 vitest 复跑全绿；
4. CRLF 鲁棒性验证：runtime.ts 转 CRLF 后 gate check 仍全绿（确定性证明）。

## 6. 遗留观察（不在本次范围）

- `gate.mjs` T0 与各 phase spec 的静态断言也用 `readFileSync` 读源码做子串/正则
  匹配（gate.mjs:34/52/80/95、specs/phase-{1,3,4,5,6}）。子串匹配对行尾不敏感，
  目前两种行尾下均绿，未动；若未来引入跨行 `\n` 字面量断言需同样归一。
- 根治可选项：`.gitattributes` 给 `*.ts` 钉 `text eol=lf`——全仓级影响，需单独评估，
  本次不动。
