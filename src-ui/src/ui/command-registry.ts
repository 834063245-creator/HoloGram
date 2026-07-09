// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Command Registry — 统一斜杠命令注册表
// 替代 chat.ts 中三处硬编码：HTML 模板、点击分发、路由匹配。
// Skills 在渲染时通过 provider 动态注入，无需修改注册表。

// ── Types ──

export interface CommandDef {
  id: string;
  /** 显示名称（中文） */
  label: string;
  /** 副标题 / 描述 */
  description?: string;
  /** 分组: '会话' | '记忆' | '分析' | '技能' | '文件' */
  group: string;
  /** 快捷路径，如 '/memory'。用于输入匹配和提示 */
  shortcut: string;
  /** 执行动作 */
  action: CommandAction;
}

export type CommandAction =
  | { type: 'send'; text: string; displayLabel: string }
  | { type: 'local'; handler: () => void }
  | { type: 'fill'; text: string }
  | { type: 'skill'; skillName: string };

/** 技能动态提供者 — chat.ts 注入 */
export type SkillProvider = () => Array<{ name: string; description?: string }>;

// ── Registry ──

export class CommandRegistry {
  private static _instance: CommandRegistry;
  private _commands: CommandDef[] = [];
  private _skillProvider: SkillProvider | null = null;

  static get instance(): CommandRegistry {
    if (!this._instance) this._instance = new CommandRegistry();
    return this._instance;
  }

  register(cmd: CommandDef): void { this._commands.push(cmd); }

  registerAll(cmds: CommandDef[]): void { this._commands.push(...cmds); }

  setSkillProvider(provider: SkillProvider): void { this._skillProvider = provider; }

  /** 获取所有命令，包括动态技能 */
  getAll(): CommandDef[] {
    const cmds = [...this._commands];
    // 动态注入技能命令
    if (this._skillProvider) {
      for (const s of this._skillProvider()) {
        cmds.push({
          id: `skill:${s.name}`,
          label: s.name,
          description: s.description || `执行技能 ${s.name}`,
          group: '技能',
          shortcut: `/${s.name}`,
          action: { type: 'skill', skillName: s.name },
        });
      }
    }
    return cmds;
  }

  /** 按 shortcut 精确查找 */
  findByShortcut(shortcut: string): CommandDef | undefined {
    return this.getAll().find(c => c.shortcut === shortcut);
  }

  /** 模糊搜索：匹配 shortcut、label、description */
  filter(query: string): CommandDef[] {
    const q = query.toLowerCase().replace(/^\//, '');
    if (!q) return this.getAll();
    return this.getAll().filter(c => {
      const shortcut = c.shortcut.toLowerCase().replace(/^\//, '');
      return (
        shortcut.includes(q) ||
        c.label.toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q)
      );
    });
  }

  /** 渲染命令项 HTML — no icons, just label + description + shortcut */
  renderItem(cmd: CommandDef, query?: string): string {
    const highlight = (text: string) => {
      if (!query) return text;
      const q = query.toLowerCase().replace(/^\//, '');
      if (!q) return text;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx < 0) return text;
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + q.length);
      const after = text.slice(idx + q.length);
      return `${before}<mark class="sp-match">${match}</mark>${after}`;
    };

    const label = highlight(cmd.label);
    const desc = cmd.description ? `<span class="sp-desc">${highlight(cmd.description)}</span>` : '';
    const shortcut = cmd.shortcut ? `<span class="sp-key">${cmd.shortcut}</span>` : '';

    return `
      <button class="sp-item" data-cmd-id="${cmd.id}" data-shortcut="${cmd.shortcut}">
        <span class="sp-label">${label}</span>
        ${desc}
        ${shortcut}
      </button>`;
  }

  /** 渲染整个分组面板 */
  renderPanel(cmds: CommandDef[], query?: string): string {
    const groups = new Map<string, CommandDef[]>();
    for (const cmd of cmds) {
      const g = groups.get(cmd.group) || [];
      g.push(cmd);
      groups.set(cmd.group, g);
    }

    let html = '';
    for (const [group, items] of groups) {
      html += `<div class="sp-group">`;
      html += `<div class="sp-group-title">${group}</div>`;
      for (const item of items) {
        html += this.renderItem(item, query);
      }
      html += `</div>`;
    }
    return html;
  }
}

// ── Default commands ──

export const DEFAULT_COMMANDS: CommandDef[] = [
  // ── 会话 ──
  {
    id: 'new',
    label: '重置当前会话',
    description: '清空对话历史，保留项目上下文',
    group: '会话',
    shortcut: '/new',
    action: { type: 'local', handler: () => {} },
  },
  {
    id: 'compact',
    label: '压缩上下文',
    description: '压缩对话历史以节省 token',
    group: '会话',
    shortcut: '/compact',
    action: { type: 'local', handler: () => {} },
  },
  {
    id: 'compact-stats',
    label: '压缩统计',
    description: '查看上下文压缩的运行数据',
    group: '会话',
    shortcut: '/compact-stats',
    action: { type: 'send', text: '查看上下文压缩的运行状态和数据（使用 hologram_compaction_stats）', displayLabel: '/compact-stats' },
  },
  {
    id: 'export',
    label: '导出对话',
    description: '导出当前会话为 Markdown',
    group: '会话',
    shortcut: '/export',
    action: { type: 'local', handler: () => {} },
  },
  {
    id: 'trail',
    label: '显示探索轨迹',
    description: '切换依赖探索轨迹的可视化',
    group: '会话',
    shortcut: '/trail',
    action: { type: 'local', handler: () => {} },
  },
  // ── 记忆 ──
  {
    id: 'memory',
    label: '查看记忆',
    description: '列出所有已保存的记忆',
    group: '记忆',
    shortcut: '/memory',
    action: { type: 'send', text: '列出所有已保存的记忆（使用 hologram_memory_list）', displayLabel: '/memory' },
  },
  {
    id: 'remember',
    label: '记住一件事',
    description: '保存一条事实到记忆库',
    group: '记忆',
    shortcut: '/remember',
    action: { type: 'fill', text: '/remember ' },
  },
  // ── 分析 ──
  {
    id: 'fragile',
    label: '查找脆弱模块',
    description: '哪些模块耦合最深？',
    group: '分析',
    shortcut: '/fragile',
    action: { type: 'send', text: '哪些模块最脆弱？按耦合深度排名分析。', displayLabel: '/fragile' },
  },
  {
    id: 'cycle',
    label: '检查循环依赖',
    description: '查找所有循环依赖环',
    group: '分析',
    shortcut: '/cycle',
    action: { type: 'send', text: '检查循环依赖，分析每个环的风险和修复建议。', displayLabel: '/cycle' },
  },
  {
    id: 'impact',
    label: '影响分析',
    description: '分析最近改动的影响范围',
    group: '分析',
    shortcut: '/impact',
    action: { type: 'send', text: '分析最近改动的影响范围。', displayLabel: '/impact' },
  },
  {
    id: 'path',
    label: '依赖路径查询',
    description: '查询两个模块之间的依赖路径',
    group: '分析',
    shortcut: '/path',
    action: { type: 'fill', text: '追踪从 ' },
  },
  // ── 目标 ──
  {
    id: 'goal',
    label: '自主目标',
    description: 'Agent 自主循环直到完成目标',
    group: '会话',
    shortcut: '/goal',
    action: { type: 'fill', text: '/goal ' },
  },
];
