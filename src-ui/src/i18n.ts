// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Minimal i18n — zh/en toggle for new UI elements
// Does NOT cover the full app — only legend, focus banner, color/scale labels.

const TRANS: Record<string, { zh: string; en: string }> = {
  'legend.node':   { zh: '节点', en: 'NODE' },
  'legend.edge':   { zh: '连线', en: 'EDGE' },
  'legend.symbol':   { zh: '代码实体', en: 'Code' },
  'legend.medium':   { zh: '存储介质', en: 'Storage' },
  'legend.temporal': { zh: '时序', en: 'Temporal' },
  'legend.structure':  { zh: '结构', en: 'Structure' },
  'legend.inherits':   { zh: '继承', en: 'Inherits' },
  'legend.dataRead':   { zh: '数据读', en: 'Data Read' },
  'legend.dataWrite':  { zh: '数据写', en: 'Data Write' },
  'legend.shareTemporal': { zh: '共享/时序', en: 'Share/Temporal' },
  'legend.symbol.desc':    { zh: '符号 · 函数 · 方法 · 类 · 模块 · 接口 · 变量 · 常量', en: 'Symbol · Function · Method · Class · Module · Interface · Variable · Constant' },
  'legend.medium.desc':    { zh: '文件 · 数据库 · 缓存 · 消息队列', en: 'File · Database · Cache · Message Queue' },
  'legend.temporal.desc':  { zh: '线程 · 定时器 · 触发器', en: 'Thread · Timer · Trigger' },
  'legend.structure.desc': { zh: '调用 · 导入 · 定义', en: 'Calls · Imports · Defines' },
  'legend.inherits.desc':  { zh: '类继承 · 接口实现', en: 'Class Inheritance · Interface Implementation' },
  'legend.dataRead.desc':  { zh: '读取变量 · 数据库 · 文件', en: 'Read Variable · Database · File' },
  'legend.dataWrite.desc': { zh: '写入变量 · 数据库 · 文件', en: 'Write Variable · Database · File' },
  'legend.shareTemporal.desc': { zh: '共享资源 · 触发 · 等待 · 顺序执行', en: 'Shared Resource · Trigger · Await · Sequence' },
  'legend.function':  { zh: '函数', en: 'Function' },
  'legend.method':    { zh: '方法', en: 'Method' },
  'legend.class':     { zh: '类', en: 'Class' },
  'legend.module':    { zh: '模块', en: 'Module' },
  'legend.interface': { zh: '接口', en: 'Interface' },
  'legend.variable':  { zh: '变量', en: 'Variable' },
  'legend.constant':  { zh: '常量', en: 'Constant' },
  'legend.calls':     { zh: '调用', en: 'Calls' },
  'legend.imports':   { zh: '导入', en: 'Imports' },
  'legend.defines':   { zh: '定义', en: 'Defines' },
  'legend.shares':    { zh: '共享', en: 'Share' },
  'legend.triggers':  { zh: '触发', en: 'Trigger' },
  'legend.awaits':    { zh: '等待', en: 'Await' },
  'legend.sequences': { zh: '顺序', en: 'Sequence' },
  'legend.function.desc':  { zh: '独立函数 · 顶层函数', en: 'Standalone function · top-level function' },
  'legend.method.desc':    { zh: '类内方法 · 实例/静态方法', en: 'Class method · instance/static method' },
  'legend.class.desc':     { zh: '类声明', en: 'Class declaration' },
  'legend.module.desc':    { zh: '模块 · 命名空间', en: 'Module · namespace' },
  'legend.interface.desc': { zh: '接口 · 抽象类型', en: 'Interface · abstract type' },
  'legend.variable.desc':  { zh: '可变变量', en: 'Mutable variable' },
  'legend.constant.desc':  { zh: '不可变常量', en: 'Immutable constant' },
  'legend.calls.desc':     { zh: '函数/方法调用', en: 'Function/method call' },
  'legend.imports.desc':   { zh: '模块导入', en: 'Module import' },
  'legend.defines.desc':   { zh: '定义关系 · 包含', en: 'Defines · contains' },
  'legend.shares.desc':    { zh: '共享资源 · 共享变量', en: 'Shared resource · shared variable' },
  'legend.triggers.desc':  { zh: '事件触发', en: 'Event trigger' },
  'legend.awaits.desc':    { zh: '异步等待', en: 'Async await' },
  'legend.sequences.desc': { zh: '顺序执行约束', en: 'Sequence ordering' },

  'focus.title':  { zh: '聚焦', en: 'Focus' },
  'focus.nodes':  { zh: '节点', en: 'nodes' },
  'focus.exit':   { zh: 'Esc 退出', en: 'Esc to exit' },

  'color.type':      { zh: '按类型', en: 'By Type' },
  'color.community': { zh: '按社区', en: 'By Community' },
  'color.coupling':  { zh: '按耦合', en: 'By Coupling' },
  'color.tooltip':   { zh: '着色', en: 'Color' },

  'scale.degree':   { zh: '按度', en: 'By Degree' },
  'scale.coupling': { zh: '按耦合风险', en: 'By Coupling Risk' },
  'scale.tooltip':  { zh: '缩放', en: 'Scale' },
};

export type Lang = 'zh' | 'en';

let _lang: Lang = 'zh';

export function getLang(): Lang { return _lang; }

export function setLang(lang: Lang): void { _lang = lang; }

export function t(key: string): string {
  const entry = TRANS[key];
  if (!entry) return key;
  return entry[_lang] || entry.en || key;
}
