// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import type { Tool, ToolExecutor } from '../tool';

// ═══════════════════════════════════════════════════════

interface HologToolDef {
  name: string;
  desc: string;
  params?: Record<string, unknown>;
  required?: string[];
  write?: boolean;
}

const pp = (props: Record<string, unknown>) => ({ type: 'object', properties: props });

const HOLOG_TOOLS: HologToolDef[] = [
  {
    name: 'explore_deps',
    desc: '【首选】统一聚合查询：Flow + Blast Radius + Relationships + Source + Alerts。支持自然语言，不确定用什么工具时先调这个。',
    params: pp({
      query: { type: 'string', description: '自然语言查询（如 "DataRequest validate task"）' },
      symbols: { type: 'array', items: { type: 'string' }, description: '显式符号名列表（与 query 二选一）' },
      includeSource: { type: 'boolean', description: '是否返回源码（默认 true）' },
    }),
  },
  {
    name: 'analyze_project',
    desc: '重新分析项目目录，生成完整依赖图。',
    params: pp({ path: { type: 'string', description: '项目根目录' } }),
    required: ['path'],
    write: true,
  },
  {
    name: 'get_neighbors',
    desc: '获取节点的直接邻居（1-hop 子图）——谁依赖它、它依赖谁。',
    params: pp({
      nodeId: { type: 'string', description: '节点 ID 或名称' },
      depth: { type: 'integer', description: '深度（默认 1）' },
    }),
    required: ['nodeId'],
  },
  {
    name: 'trace_impact',
    desc: '变更波及分析：从节点出发 BFS 追踪所有下游依赖者，返回完整影响树。改代码前必调。',
    params: pp({
      nodeId: { type: 'string', description: '源节点 ID' },
      maxDepth: { type: 'integer', description: '最大深度（0=不限制）' },
    }),
    required: ['nodeId'],
  },
  {
    name: 'find_dep_path',
    desc: '查找两个节点之间的所有依赖路径，逐跳展示边类型。',
    params: pp({
      from: { type: 'string', description: '源节点 ID' },
      to: { type: 'string', description: '目标节点 ID' },
    }),
    required: ['from', 'to'],
  },
  {
    name: 'symbol_history',
    desc: '获取节点的决策历史——哪些过去的决策涉及此节点。在 workspace.ts 中 alias 到 inspect_symbol。',
    params: pp({ nodeId: { type: 'string', description: '节点 ID' } }),
    required: ['nodeId'],
  },
  {
    name: 'get_community',
    desc: '获取节点的社区归属——它属于哪个社区、父社区、兄弟节点。用 "这个模块属于哪个组？" 时调此工具。',
    params: pp({ nodeId: { type: 'string', description: '节点 ID 或名称' } }),
    required: ['nodeId'],
  },
  {
    name: 'async_edges',
    desc: '列出所有时序边——异步调用、触发器、计划任务。用于查异步依赖和时序耦合。',
    params: pp({
      filter: {
        type: 'string',
        enum: ['all', 'triggers', 'awaits', 'sequences'],
        description: '边类型过滤（默认 all）',
      },
      limit: { type: 'integer', description: '最大返回条数（默认 100）' },
    }),
  },
  {
    name: 'fragile_modules',
    desc: '结构耦合排行榜：按出/入度和耦合深度排序，分数越高 = 核心枢纽。L3/L4 数据流和时序耦合用 trace_dataflow 或 async_edges 查询。',
    params: pp({ limit: { type: 'integer', description: '返回前 N 个脆弱模块（默认 5）' } }),
  },
  {
    name: 'detect_cycles',
    desc: '检测依赖图中的数据流循环。filter: all（全部）/ data（持久数据依赖）/ llm（LLM 涉及）。',
    params: pp({ mode: { type: 'string', enum: ['all', 'data', 'llm'], description: '过滤模式（默认 all）' } }),
  },
  {
    name: 'thread_conflicts',
    desc: '线程 × 资源冲突矩阵——检测多写者共享变量和并发访问模式。',
    params: pp({ nodeId: { type: 'string', description: '可选节点 ID，省略返回全局矩阵' } }),
  },
  {
    name: 'coupling_report',
    desc: '单模块耦合深度分布（L1-L4）：L1=导入, L2=调用/继承, L3=数据共享, L4=时序/异步。',
    params: pp({ module: { type: 'string', description: '模块文件名或路径' } }),
    required: ['module'],
  },
  {
    name: 'project_timeline',
    desc: '查询因果审计时间线——分析运行、提交、违规等事件的按时间排序日志。',
    params: pp({
      limit: { type: 'integer', description: '最大返回条数（默认 100）' },
      since: { type: 'string', description: 'ISO 时间戳过滤（可选）' },
    }),
  },
  {
    name: 'arch_blindspots',
    desc: '架构边界检查：循环依赖检测。L4 时序违规走数据流引擎（trace_dataflow/async_edges）。filter: all / L4 / thread / cycle。',
    params: pp({
      filter: { type: 'string', enum: ['all', 'L4', 'thread', 'cycle'], description: '边界类型过滤（默认 all）' },
    }),
  },
  {
    name: 'search_symbols',
    desc: '模糊搜索节点名或 ID（FTS5 全文搜索）。找函数/类/模块但不知道确切名字时的第一步。',
    params: pp({
      query: { type: 'string', description: '部分名称或 ID' },
      limit: { type: 'integer', description: '最大结果数（默认 20）' },
    }),
    required: ['query'],
  },
  { name: 'explore_deps', desc: '同 explore_deps。', params: pp({}) }, // duplicate entry — kept for backward compat with old test scripts
  { name: 'graph_summary', desc: '依赖图高层概览：节点/边数、语言分布、密度指标、顶层架构一览。', params: pp({}) },
  {
    name: 'cluster_report',
    desc: '社区/聚类结构报告——按规模排序，展示自然形成的模块群。查单个节点的社区归属用 get_community。',
    params: pp({
      minSize: { type: 'integer', description: '最小社区规模（默认 3）' },
      maxNodes: { type: 'integer', description: '每个社区最大展示节点数（默认 20）' },
    }),
  },
  {
    name: 'graph_diff',
    desc: '对比当前依赖图与基线快照——展示新增/删除/修改的节点和边。',
    params: pp({ beforePath: { type: 'string', description: '基线图 JSON 文件路径' } }),
    required: ['beforePath'],
  },
  {
    name: 'preflight_check',
    desc: '改前预检（V3）：输入要改的文件列表，评估波及范围、风险等级、共享变量影响、时序边信号。改代码前先跑——"这个改动安全吗？"',
    params: pp({ path: { type: 'array', items: { type: 'string' }, description: '要改的文件路径列表' } }),
    required: ['path'],
  },
  {
    name: 'validate_project',
    desc: '完整约束校验（V3）：重新分析 + 基线对比 + 所有结构约束检查。用户说"全面检查"或"跑一遍约束"时用。',
    params: pp({ path: { type: 'string', description: '项目根目录' } }),
    required: ['path'],
    write: true,
  },
  {
    name: 'project_health',
    desc: '项目健康快照：密度分数（0-100）+ 趋势 + 改动最多文件 + 最互联模块。"项目最近怎么样？"或"最近的趋势怎么样？"时用。',
    params: pp({
      path: { type: 'string', description: '项目根目录' },
      days: { type: 'integer', description: '回溯天数（默认 30）' },
    }),
    required: ['path'],
  },
  {
    name: 'rename_symbol',
    desc: '安全重命名依赖图中的符号。先用 dryRun=true 预览，确认后再 dryRun=false 执行。',
    params: pp({
      oldName: { type: 'string', description: '当前符号名' },
      newName: { type: 'string', description: '新符号名' },
      dryRun: { type: 'boolean', description: '仅预览不修改（默认 true）' },
      nodeId: { type: 'string', description: '有同名歧义时指定节点 ID' },
    }),
    required: ['oldName', 'newName'],
    write: true,
  },
  {
    name: 'engine_status',
    desc: '引擎状态和内存统计——加载阶段、节点/边数、存储类型、启动耗时。Agent 确认图是否就绪时用。',
    params: pp({}),
  },
  {
    name: 'check_boundaries',
    desc: '架构边界规则检查——自定义 source/target 文件匹配 + 边类型，扫描越界依赖。模块隔离验证："A 有没有偷 import B 的内部文件？"',
    params: pp({
      rules: {
        type: 'array',
        description:
          '规则对象数组 [{name, source, target, edge_kinds?, message?}]。source/target 支持 glob 或正则。edge_kinds 默认 ["imports"]。',
      },
      source: { type: 'string', description: '快捷模式：单条规则的 source pattern' },
      target: { type: 'string', description: '快捷模式：单条规则的 target pattern' },
      edge_kinds: { type: 'array', items: { type: 'string' }, description: '边类型过滤，默认 ["imports"]' },
    }),
  },
  {
    name: 'inspect_symbol',
    desc: '单节点完整信息——身份（name/kind/degree）+ 社区归属 + 全部出入边按类型分组。search_symbols 命中后深挖具体符号。',
    params: pp({ nodeId: { type: 'string', description: '节点 ID 或名称' } }),
    required: ['nodeId'],
  },
  {
    name: 'find_unused',
    desc: '潜在死代码探测——零入度节点（无人引用的函数/类/文件），按出度降序排列。删代码前先跑。',
    params: pp({
      limit: { type: 'integer', description: '最大结果数（默认 20）' },
      kindFilter: { type: 'string', description: '逗号分隔的节点类型（默认 "function,class,file"）' },
    }),
  },
  {
    name: 'trace_dataflow',
    desc: '逐函数变量读写 + 跨函数共享状态 + 异步触发 + 调用序列。"X 在哪被写？""谁读了 Y？""哪些函数共享 Z？"',
    params: pp({ files: { type: 'array', items: { type: 'string' }, description: '要分析的文件路径列表' } }),
    required: ['files'],
  },
  // ── LSP 引擎（4 个）──
  { name: 'resolve_call', desc: 'LSP 调用解析：给定调用表达式，返回所有可能的目标定义（多态解析）。' },
  { name: 'infer_type', desc: 'LSP 类型解析：推断表达式类型，返回类型名和定义模块。' },
  { name: 'find_implementations', desc: 'LSP 查找接口/抽象类的所有实现，返回完整继承树。' },
  { name: 'find_references', desc: 'LSP 查找符号的所有引用位置，返回文件列表和引用计数。' },
];

export function createHologramTestTools(exec: ToolExecutor): Tool[] {
  return HOLOG_TOOLS.map((d) => ({
    name: () => d.name,
    description: () => d.desc,
    parameters: () => d.params || { type: 'object', properties: {} },
    readOnly: () => !d.write,
    execute: (args: Record<string, unknown>) => exec(d.name, args),
  }));
}
