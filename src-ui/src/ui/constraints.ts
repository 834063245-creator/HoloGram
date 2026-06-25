// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Constraints Panel — 约束配置 UI
// 编辑 hologram.constraints.yaml 的图形界面

import { invoke } from '../bridge';
import { iconHtml } from './icons';
import { askAgent } from './agent-visualizer';
import { bus } from './events';
import { shell } from './app-shell';

interface ConstraintsData {
  routing: Record<string, boolean>;
  thresholds: Record<string, number>;
  allowlist: { modules: string[]; files: string[] };
  denylist: { keywords: string[] };
}

export class ConstraintsPanel {
  private panel!: HTMLElement;
  private content!: HTMLElement;
  private openState = false;
  private data: ConstraintsData | null = null;
  private dirty = false;
  private rawYaml = '';
  private path: string | null = null;

  private static instance: ConstraintsPanel | null = null;

  static get(): ConstraintsPanel {
    if (!ConstraintsPanel.instance) {
      ConstraintsPanel.instance = new ConstraintsPanel();
    }
    return ConstraintsPanel.instance;
  }

  constructor() {
    this.buildDOM();
  }

  private buildDOM(): void {
    this.panel = document.createElement('div');
    this.panel.id = 'constraints-panel';
    Object.assign(this.panel.style, {
      position: 'absolute',
      top: '36px',
      right: '0',
      bottom: '28px',
      width: '340px',
      maxWidth: '90vw',
      background: 'var(--panel-bg, rgba(6, 12, 24, 0.97))',
      backdropFilter: 'var(--blur, blur(14px))',
      WebkitBackdropFilter: 'var(--blur, blur(14px))',
      borderLeft: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.5))',
      zIndex: '16',
      display: 'flex',
      flexDirection: 'column',
      // transform + transition handled by CSS #constraints-panel
    });

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 12px', borderBottom: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.4))',
      flexShrink: '0',
    });

    const title = document.createElement('span');
    title.innerHTML = `${iconHtml('constraints', 12)} 约束配置`;
    Object.assign(title.style, {
      fontSize: '13px', fontWeight: '600', color: 'var(--signal, #7eb8ff)', letterSpacing: '0.5px',
    });

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = iconHtml('close', 14);
    Object.assign(closeBtn.style, {
      width: '24px', height: '24px', padding: '0',
      background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
      cursor: 'pointer', fontSize: '14px', borderRadius: '4px',
      transition: 'color var(--snap, 0.12s)',
    });
    closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = 'var(--starlight-dim, #c9d1d9)');
    closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = 'var(--text-muted, #4a5568)');
    closeBtn.addEventListener('click', () => this.close());

    // "Ask Agent" button
    const askBtn = document.createElement('button');
    askBtn.innerHTML = iconHtml('agent', 12);
    askBtn.title = '问 Agent 关于当前约束配置';
    Object.assign(askBtn.style, {
      width: '24px', height: '24px', padding: '0',
      background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
      cursor: 'pointer', fontSize: '14px', borderRadius: '4px',
      transition: 'color var(--snap, 0.12s)',
      marginRight: '4px',
    });
    askBtn.addEventListener('mouseenter', () => askBtn.style.color = 'var(--signal, #7eb8ff)');
    askBtn.addEventListener('mouseleave', () => askBtn.style.color = 'var(--text-muted, #4a5568)');
    askBtn.addEventListener('click', () => {
      const routingSummary = this.data?.routing
        ? Object.entries(this.data.routing).filter(([, v]) => v).map(([k]) => k).join(', ')
        : '未知';
      askAgent(`解释当前项目的约束配置。启用的路由: ${routingSummary}。这些约束规则的作用是什么？有没有可以优化的地方？`);
    });

    header.appendChild(title);
    header.appendChild(askBtn);
    header.appendChild(closeBtn);

    // Content
    this.content = document.createElement('div');
    Object.assign(this.content.style, {
      flex: '1', overflow: 'auto', padding: '12px',
    });

    this.panel.appendChild(header);
    this.panel.appendChild(this.content);
    document.body.appendChild(this.panel);
  }

  // ── Public API ──

  async load(projectPath: string): Promise<void> {
    if (this.dirty && this.path !== projectPath) {
      if (!confirm('约束配置有未保存的修改，切换项目将丢失修改。确定继续？')) return;
    }
    this.path = projectPath;
    this.dirty = false;
    try {
      this.rawYaml = await invoke<string>('read_constraints', { projectPath: projectPath });
      this.data = this.parseYamlSimple(this.rawYaml);
      this.renderForm();
    } catch (err) {
      console.error('Failed to load constraints:', err);
      this.content.innerHTML = `<div style="color:#e05555;font-size:12px;padding:12px;">加载约束配置失败</div>`;
    }
  }

  toggle(): void {
    if (this.openState) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    this.openState = true;
    this.panel.classList.add('cs-open');
    shell.notifyPanelChanged();
  }

  close(): void {
    this.openState = false;
    this.panel.classList.remove('cs-open');
    shell.notifyPanelChanged();
  }

  isOpen(): boolean { return this.openState; }

  // ── Simple YAML parser (enough for the constraints file structure) ──

  private parseYamlSimple(yaml: string): ConstraintsData {
    const result: ConstraintsData = {
      routing: {},
      thresholds: {},
      allowlist: { modules: [], files: [] },
      denylist: { keywords: [] },
    };

    let section = '';
    let subSection = '';
    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Top-level sections
      if (trimmed === 'routing:') { section = 'routing'; continue; }
      if (trimmed === 'thresholds:') { section = 'thresholds'; continue; }
      if (trimmed === 'allowlist:') { section = 'allowlist'; continue; }
      if (trimmed === 'denylist:') { section = 'denylist'; continue; }

      if (section === 'routing') {
        const m = trimmed.match(/^(\w+):\s*(true|false)/);
        if (m) result.routing[m[1]] = m[2] === 'true';
      } else if (section === 'thresholds') {
        const m = trimmed.match(/^(\w+):\s*(\d+)/);
        if (m) result.thresholds[m[1]] = parseInt(m[2]);
      } else if (section === 'allowlist') {
        if (trimmed === 'modules:') { subSection = 'modules'; continue; }
        if (trimmed === 'files:') { subSection = 'files'; continue; }
        const m = trimmed.match(/^-\s*"([^"]+)"/);
        if (m && subSection === 'modules') result.allowlist.modules.push(m[1]);
        if (m && subSection === 'files') result.allowlist.files.push(m[1]);
      } else if (section === 'denylist') {
        if (trimmed === 'keywords:') { subSection = 'keywords'; continue; }
        const m = trimmed.match(/^-\s*"([^"]+)"/);
        if (m) result.denylist.keywords.push(m[1]);
      }
    }

    return result;
  }

  // ── Form Render ──

  private renderForm(): void {
    if (!this.data) return;

    let html = '';

    // ── Routing ──
    html += '<div class="cs-section"><div class="cs-section-title">🔀 路由开关</div>';
    const routingLabels: Record<string, string> = {
      l5_irreversible: 'L5 不可逆破坏（永远路由）',
      l4_silent: 'L4 静默破坏',
      l3_delayed: 'L3 延迟破坏',
      l2_blast: 'L2 波及破坏',
      l1_visible: 'L1 可见破坏',
    };
    for (const [key, label] of Object.entries(routingLabels)) {
      const checked = this.data.routing[key] ? 'checked' : '';
      const disabled = key === 'l5_irreversible' ? 'disabled' : '';
      html += `<label class="cs-toggle">
        <span class="cs-toggle-label">${label}</span>
        <input type="checkbox" data-routing="${key}" ${checked} ${disabled}>
        <span class="cs-toggle-slider"></span>
      </label>`;
    }
    html += '</div>';

    // ── Thresholds ──
    html += '<div class="cs-section"><div class="cs-section-title">📏 阈值</div>';
    const thresholdLabels: Record<string, string> = {
      blast_radius_max: '波及节点上限',
      cross_community_tolerance: '跨社区边容忍',
      api_signature_tolerance: 'API 签名变更容忍',
      l4_penetration_tolerance: 'L4 封装穿透容忍',
      l4_threshold_change_tolerance: '数值阈值变更容忍',
    };
    for (const [key, label] of Object.entries(thresholdLabels)) {
      const val = this.data.thresholds[key] ?? 0;
      html += `<div class="cs-field">
        <label class="cs-field-label">${label}</label>
        <input type="number" class="cs-field-input" data-threshold="${key}" value="${val}" min="0" max="1000">
      </div>`;
    }
    html += '</div>';

    // ── Allowlist ──
    html += `<div class="cs-section"><div class="cs-section-title">${iconHtml('check-circle', 10)} 白名单</div>`;
    html += '<div class="cs-sub-title">模块（L4 穿透不触发路由）</div>';
    html += '<div class="cs-tag-list" data-list="allow-modules">';
    for (const m of this.data.allowlist.modules) {
      html += `<span class="cs-tag">${escapeHtml(m)} <button class="cs-tag-rm" data-value="${escapeHtml(m)}">${iconHtml('close', 8)}</button></span>`;
    }
    html += '</div>';
    html += `<div class="cs-add-row"><input class="cs-add-input" data-add="allow-modules" placeholder="添加模块…"><button class="cs-add-btn" data-add="allow-modules">${iconHtml('plus', 10)}</button></div>`;

    html += '<div class="cs-sub-title">文件（不触发 L3 延迟路由）</div>';
    html += '<div class="cs-tag-list" data-list="allow-files">';
    for (const f of this.data.allowlist.files) {
      html += `<span class="cs-tag">${escapeHtml(f)} <button class="cs-tag-rm" data-value="${escapeHtml(f)}">${iconHtml('close', 8)}</button></span>`;
    }
    html += '</div>';
    html += `<div class="cs-add-row"><input class="cs-add-input" data-add="allow-files" placeholder="添加文件模式…"><button class="cs-add-btn" data-add="allow-files">${iconHtml('plus', 10)}</button></div>`;
    html += '</div>';

    // ── Denylist ──
    html += `<div class="cs-section"><div class="cs-section-title">${iconHtml('block', 10)} 黑名单关键词</div>`;
    html += '<div class="cs-tag-list" data-list="deny-keywords">';
    for (const kw of this.data.denylist.keywords) {
      html += `<span class="cs-tag">${escapeHtml(kw)} <button class="cs-tag-rm" data-value="${escapeHtml(kw)}">${iconHtml('close', 8)}</button></span>`;
    }
    html += '</div>';
    html += `<div class="cs-add-row"><input class="cs-add-input" data-add="deny-keywords" placeholder="添加关键词…"><button class="cs-add-btn" data-add="deny-keywords">${iconHtml('plus', 10)}</button></div>`;
    html += '</div>';

    // ── Actions ──
    html += '<div class="cs-actions">';
    html += `<button class="cs-btn cs-btn-save">${iconHtml('save', 10)} 保存</button>`;
    html += `<button class="cs-btn cs-btn-reset">${iconHtml('reset', 10)} 重置</button>`;
    html += '</div>';

    this.content.innerHTML = html;
    this.wireFormEvents();
  }

  private wireFormEvents(): void {
    // Toggle changes
    this.content.querySelectorAll('input[data-routing]').forEach(el => {
      el.addEventListener('change', () => this.markDirty());
    });
    this.content.querySelectorAll('input[data-threshold]').forEach(el => {
      el.addEventListener('change', () => this.markDirty());
    });

    // Remove tags
    this.content.querySelectorAll('.cs-tag-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        const value = (btn as HTMLElement).dataset['value']!;
        const listEl = btn.closest('.cs-tag-list') as HTMLElement;
        const listKey = listEl.dataset['list']!;
        // Remove from data
        const entry = this.getListEntry(listKey);
        if (entry) {
          const idx = entry.indexOf(value);
          if (idx >= 0) { entry.splice(idx, 1); this.markDirty(); this.renderForm(); }
        }
      });
    });

    // Add tags
    this.content.querySelectorAll('.cs-add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = (btn as HTMLElement).dataset['add']!;
        const input = this.content.querySelector(`input[data-add="${key}"]`) as HTMLInputElement;
        const val = input.value.trim();
        if (!val) return;
        const entry = this.getListEntry(key);
        if (entry && !entry.includes(val)) {
          entry.push(val);
          input.value = '';
          this.markDirty();
          this.renderForm();
        }
      });
    });

    // Save
    this.content.querySelector('.cs-btn-save')?.addEventListener('click', () => this.save());
    // Reset
    this.content.querySelector('.cs-btn-reset')?.addEventListener('click', () => {
      this.dirty = false;
      this.renderForm();
    });
  }

  private getListEntry(key: string): string[] | null {
    if (!this.data) return null;
    switch (key) {
      case 'allow-modules': return this.data.allowlist.modules;
      case 'allow-files': return this.data.allowlist.files;
      case 'deny-keywords': return this.data.denylist.keywords;
      default: return null;
    }
  }

  private markDirty(): void {
    this.dirty = true;
    // Read current form state into data
    this.readFormIntoData();
  }

  private readFormIntoData(): void {
    if (!this.data) return;
    // Routing
    this.content.querySelectorAll('input[data-routing]').forEach(el => {
      const input = el as HTMLInputElement;
      const key = input.dataset['routing']!;
      this.data!.routing[key] = input.checked;
    });
    // Thresholds
    this.content.querySelectorAll('input[data-threshold]').forEach(el => {
      const input = el as HTMLInputElement;
      const key = input.dataset['threshold']!;
      let val = parseInt(input.value, 10);
      if (isNaN(val) || val < 0) val = 0;
      if (val > 10000) val = 10000;
      this.data!.thresholds[key] = val;
    });
  }

  private saving = false;

  private async save(): Promise<void> {
    if (!this.path || !this.data || this.saving) return;
    this.saving = true;
    this.readFormIntoData();
    const yaml = this.dataToYaml(this.data);
    try {
      await invoke('write_constraints', { projectPath: this.path, content: yaml });
      this.rawYaml = yaml;
      this.dirty = false;
      // Flash save button green
      const btn = this.content.querySelector('.cs-btn-save') as HTMLElement;
      if (btn) {
        btn.innerHTML = `${iconHtml('check-circle', 11)} 已保存`;
        btn.style.color = 'var(--pass, #55aa55)';
        setTimeout(() => {
          btn.innerHTML = `${iconHtml('save', 11)} 保存`;
          btn.style.color = '';
        }, 1500);
      }
    } catch (err) {
      console.error('Failed to save constraints:', err);
      // Flash red to indicate failure
      const btn = this.content.querySelector('.cs-btn-save') as HTMLElement;
      if (btn) {
        btn.style.color = 'var(--error, #e05555)';
        setTimeout(() => { btn.style.color = ''; }, 1500);
      }
    } finally {
      this.saving = false;
    }
  }

  private dataToYaml(data: ConstraintsData): string {
    let yaml = '# 全息仓约束配置\n# 修改此文件来定制你的项目的破坏性变更阈值\n\nconstraints:\n';
    yaml += '  routing:\n';
    for (const [k, v] of Object.entries(data.routing)) {
      yaml += `    ${k}: ${v ? 'true' : 'false'}\n`;
    }
    yaml += '\n  thresholds:\n';
    for (const [k, v] of Object.entries(data.thresholds)) {
      yaml += `    ${k}: ${v}\n`;
    }
    yaml += '\n  allowlist:\n    modules:\n';
    for (const m of data.allowlist.modules) {
      yaml += `      - "${m}"\n`;
    }
    yaml += '    files:\n';
    for (const f of data.allowlist.files) {
      yaml += `      - "${f}"\n`;
    }
    yaml += '\n  denylist:\n    keywords:\n';
    for (const kw of data.denylist.keywords) {
      yaml += `      - "${kw}"\n`;
    }
    return yaml;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
