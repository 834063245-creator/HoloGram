// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Minimal i18n — zh/en toggle for new UI elements
// Does NOT cover the full app — only legend, focus banner, color/scale labels.

import { create } from 'zustand';

const TRANS: Record<string, { zh: string; en: string }> = {
  'legend.title': { zh: '图例', en: 'LEGEND' },
  'legend.node': { zh: '节点', en: 'NODE' },
  'legend.edge': { zh: '连线', en: 'EDGE' },
  'legend.symbol': { zh: '代码实体', en: 'Code' },
  'legend.medium': { zh: '存储介质', en: 'Storage' },
  'legend.temporal': { zh: '时序', en: 'Temporal' },
  'legend.structure': { zh: '结构', en: 'Structure' },
  'legend.inherits': { zh: '继承', en: 'Inherits' },
  'legend.dataRead': { zh: '数据读', en: 'Data Read' },
  'legend.dataWrite': { zh: '数据写', en: 'Data Write' },
  'legend.shareTemporal': { zh: '共享/时序', en: 'Share/Temporal' },
  'legend.symbol.desc': {
    zh: '符号 · 函数 · 方法 · 类 · 模块 · 接口 · 变量 · 常量',
    en: 'Symbol · Function · Method · Class · Module · Interface · Variable · Constant',
  },
  'legend.medium.desc': { zh: '文件 · 数据库 · 缓存 · 消息队列', en: 'File · Database · Cache · Message Queue' },
  'legend.temporal.desc': { zh: '线程 · 定时器 · 触发器', en: 'Thread · Timer · Trigger' },
  'legend.structure.desc': { zh: '调用 · 导入 · 定义', en: 'Calls · Imports · Defines' },
  'legend.inherits.desc': { zh: '类继承 · 接口实现', en: 'Class Inheritance · Interface Implementation' },
  'legend.dataRead.desc': { zh: '读取变量 · 数据库 · 文件', en: 'Read Variable · Database · File' },
  'legend.dataWrite.desc': { zh: '写入变量 · 数据库 · 文件', en: 'Write Variable · Database · File' },
  'legend.shareTemporal.desc': {
    zh: '共享资源 · 触发 · 等待 · 顺序执行',
    en: 'Shared Resource · Trigger · Await · Sequence',
  },
  'legend.function': { zh: '函数', en: 'Function' },
  'legend.method': { zh: '方法', en: 'Method' },
  'legend.class': { zh: '类', en: 'Class' },
  'legend.module': { zh: '模块', en: 'Module' },
  'legend.interface': { zh: '接口', en: 'Interface' },
  'legend.file': { zh: '文件', en: 'File' },
  'legend.variable': { zh: '变量', en: 'Variable' },
  'legend.constant': { zh: '常量', en: 'Constant' },
  'legend.calls': { zh: '调用', en: 'Calls' },
  'legend.imports': { zh: '导入', en: 'Imports' },
  'legend.defines': { zh: '定义', en: 'Defines' },
  'legend.shares': { zh: '共享', en: 'Share' },
  'legend.triggers': { zh: '触发', en: 'Trigger' },
  'legend.awaits': { zh: '等待', en: 'Await' },
  'legend.reads': { zh: '读取', en: 'Reads' },
  'legend.writes': { zh: '写入', en: 'Writes' },
  'legend.usage': { zh: '引用', en: 'Usage' },
  'legend.throws': { zh: '异常', en: 'Throws' },
  'legend.sequences': { zh: '顺序', en: 'Sequence' },
  'legend.function.desc': { zh: '独立函数 · 顶层函数', en: 'Standalone function · top-level function' },
  'legend.method.desc': { zh: '类内方法 · 实例/静态方法', en: 'Class method · instance/static method' },
  'legend.class.desc': { zh: '类声明', en: 'Class declaration' },
  'legend.module.desc': { zh: '模块 · 命名空间', en: 'Module · namespace' },
  'legend.interface.desc': { zh: '接口 · 抽象类型', en: 'Interface · abstract type' },
  'legend.file.desc': { zh: '源文件 · 文件模块', en: 'Source file · file module' },
  'legend.variable.desc': { zh: '可变变量', en: 'Mutable variable' },
  'legend.constant.desc': { zh: '不可变常量', en: 'Immutable constant' },
  'legend.calls.desc': { zh: '函数/方法调用', en: 'Function/method call' },
  'legend.imports.desc': { zh: '模块导入', en: 'Module import' },
  'legend.defines.desc': { zh: '定义关系 · 包含', en: 'Defines · contains' },
  'legend.shares.desc': { zh: '共享资源 · 共享变量', en: 'Shared resource · shared variable' },
  'legend.triggers.desc': { zh: '事件触发', en: 'Event trigger' },
  'legend.awaits.desc': { zh: '异步等待', en: 'Async await' },
  'legend.sequences.desc': { zh: '顺序执行约束', en: 'Sequence ordering' },
  'legend.reads.desc': { zh: '读取变量/文件/数据库', en: 'Read variable/file/database' },
  'legend.writes.desc': { zh: '写入变量/文件/数据库', en: 'Write variable/file/database' },
  'legend.usage.desc': { zh: '符号引用 · 使用关系', en: 'Symbol reference · usage relation' },
  'legend.throws.desc': { zh: '异常抛出 · 错误传播', en: 'Exception throw · error propagation' },

  'focus.title': { zh: '聚焦', en: 'Focus' },
  'focus.nodes': { zh: '节点', en: 'nodes' },
  'focus.exit': { zh: 'Esc 退出', en: 'Esc to exit' },
};

export type Lang = 'zh' | 'en';

// lang 单一事实源 — zustand store（P1a：替代 bus 'lang:changed' 事件；
// 见 docs/plans/ui-react-island-retirement-plan.md）。SettingsPanel 保存后
// setLang 写入即生效；graph 订阅 store 重建图例/聚焦横幅。
export const useLangStore = create<{ lang: Lang }>(() => ({ lang: 'zh' }));

export function getLang(): Lang {
  return useLangStore.getState().lang;
}

export function setLang(lang: Lang): void {
  useLangStore.setState({ lang });
}

export function t(key: string): string {
  const entry = TRANS[key];
  if (!entry) return key;
  return entry[useLangStore.getState().lang] || entry.en || key;
}
