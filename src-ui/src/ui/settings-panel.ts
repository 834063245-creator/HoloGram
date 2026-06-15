// Settings Panel — 设置模态面板
// Provider | Agent | 显示 三个标签页
// 读写 settings.ts 的 localStorage，保存后触发 Agent 重新初始化

import { loadSettings, saveSettings, updateProvider } from '../settings';
import type { AppSettings, AgentSettings } from '../settings';
import { setLang } from '../i18n';
import type { Lang } from '../i18n';
import { iconHtml } from './icons';
import { bus } from './events';

const PANEL_ID = 'settings-panel';

type Tab = 'provider' | 'agent' | 'display';

export class SettingsPanel {
  private overlay!: HTMLElement;
  private panel!: HTMLElement;
  private openState = false;
  private dirty = false;
  private activeTab: Tab = 'provider';
  private originalSettings: AppSettings;
  private workingSettings: AppSettings;
  private onSave: (() => void) | null = null;

  private static instance: SettingsPanel | null = null;

  static get(): SettingsPanel {
    if (!SettingsPanel.instance) {
      SettingsPanel.instance = new SettingsPanel();
    }
    return SettingsPanel.instance;
  }

  constructor() {
    this.originalSettings = loadSettings();
    this.workingSettings = JSON.parse(JSON.stringify(this.originalSettings));
    this.buildDOM();
  }

  // ── Public API ──

  setOnSave(fn: () => void): void {
    this.onSave = fn;
  }

  isOpen(): boolean {
    return this.openState;
  }

  open(): void {
    // Re-read from localStorage in case something else changed
    this.originalSettings = loadSettings();
    this.workingSettings = JSON.parse(JSON.stringify(this.originalSettings));
    this.openState = true;
    this.activeTab = 'provider';
    this.render();
    this.overlay.classList.add('sp-open');
    this.panel.classList.add('sp-open');
    bus.emit('panel:toggle');
  }

  close(): void {
    if (this.dirty && !confirm('有未保存的修改，确定关闭？')) return;
    this.openState = false;
    this.overlay.classList.remove('sp-open');
    this.panel.classList.remove('sp-open');
  }

  toggle(): void {
    this.openState ? this.close() : this.open();
  }

  // ── Build DOM ──

  private buildDOM(): void {
    // Overlay — click to close
    this.overlay = document.createElement('div');
    this.overlay.id = `${PANEL_ID}-overlay`;
    this.overlay.addEventListener('click', () => this.close());

    // Panel
    this.panel = document.createElement('div');
    this.panel.id = PANEL_ID;

    document.body.appendChild(this.overlay);
    document.body.appendChild(this.panel);
  }

  // ── Render ──

  private render(): void {
    const s = this.workingSettings;
    const active = s.providers.find((p) => p.name === s.activeProvider) || s.providers[0];

    this.panel.innerHTML = `
      <div class="sp-header">
        <span class="sp-title">${iconHtml('settings', 13)} 设置</span>
        <button class="sp-close-btn">${iconHtml('close', 14)}</button>
      </div>

      <!-- Tabs -->
      <div class="sp-tabs">
        <button class="sp-tab ${this.activeTab === 'provider' ? 'active' : ''}" data-tab="provider">
          ${iconHtml('agent', 11)} Provider
        </button>
        <button class="sp-tab ${this.activeTab === 'agent' ? 'active' : ''}" data-tab="agent">
          ${iconHtml('code', 11)} Agent
        </button>
        <button class="sp-tab ${this.activeTab === 'display' ? 'active' : ''}" data-tab="display">
          ${iconHtml('mode-standard', 11)} 显示
        </button>
      </div>

      <!-- Content -->
      <div class="sp-content">
        ${this.renderProviderTab(active)}
        ${this.renderAgentTab(s.agent)}
        ${this.renderDisplayTab(s.display.defaultViewMode, s.display.language)}
      </div>

      <!-- Footer -->
      <div class="sp-footer">
        <button class="sp-btn sp-btn-cancel">取消</button>
        <button class="sp-btn sp-btn-save">${iconHtml('save', 11)} 保存</button>
      </div>`;

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Wire events
    this.dirty = false;
    this.wireEvents();
  }

  // ── Tab renderers ──

  private renderProviderTab(active: { name: string; kind: string; apiKey: string; model: string; baseUrl: string; thinking?: string }): string {
    const s = this.workingSettings;
    const isAnthropic = active.kind === 'anthropic';

    let providerOpts = '';
    for (const p of s.providers) {
      const sel = p.name === s.activeProvider ? 'selected' : '';
      providerOpts += `<option value="${p.name}" ${sel}>${p.name} (${p.kind})</option>`;
    }

    return `
      <div class="sp-tab-content" data-tab="provider" style="${this.activeTab === 'provider' ? '' : 'display:none'}">
        <div class="sp-section">
          <div class="sp-section-title">当前 Provider</div>
          <div class="sp-field">
            <label class="sp-label">Provider</label>
            <select class="sp-select" data-field="activeProvider">${providerOpts}</select>
          </div>
        </div>

        <div class="sp-section">
          <div class="sp-section-title">连接配置</div>
          <div class="sp-field">
            <label class="sp-label">API Key</label>
            <div class="sp-key-row">
              <input type="password" class="sp-input sp-key-input" data-field="apiKey"
                     value="${escapeAttr(active.apiKey)}"
                     placeholder="sk-…">
              <button class="sp-key-toggle" title="显示/隐藏">${iconHtml('search', 12)}</button>
            </div>
          </div>
          <div class="sp-field">
            <label class="sp-label">模型</label>
            <input type="text" class="sp-input" data-field="model"
                   value="${escapeAttr(active.model)}"
                   placeholder="deepseek-chat">
          </div>
          <div class="sp-field">
            <label class="sp-label">Base URL</label>
            <input type="text" class="sp-input" data-field="baseUrl"
                   value="${escapeAttr(active.baseUrl)}"
                   placeholder="https://api.deepseek.com/v1">
          </div>
          ${isAnthropic ? `
          <div class="sp-field">
            <label class="sp-label">Extended Thinking</label>
            <input type="text" class="sp-input" data-field="thinking"
                   value="${escapeAttr(active.thinking || '')}"
                   placeholder="留空关闭, 例如: 8k">
          </div>` : ''}
        </div>
        <div class="sp-hint">
          ${isAnthropic
            ? 'Anthropic: 从 <a href="https://console.anthropic.com/" target="_blank">console.anthropic.com</a> 获取 Key'
            : 'DeepSeek: 从 <a href="https://platform.deepseek.com/" target="_blank">platform.deepseek.com</a> 获取 Key'}
        </div>
      </div>`;
  }

  private renderAgentTab(agent: AgentSettings): string {
    const tempPct = Math.round(((agent.temperature || 0.7) / 2) * 100);
    return `
      <div class="sp-tab-content" data-tab="agent" style="${this.activeTab === 'agent' ? '' : 'display:none'}">
        <div class="sp-section">
          <div class="sp-section-title">模型参数</div>
          <div class="sp-field">
            <label class="sp-label">Temperature <span class="sp-val">${(agent.temperature || 0.7).toFixed(1)}</span></label>
            <div class="sp-slider-row">
              <span class="sp-slider-end">0</span>
              <input type="range" class="sp-range" data-field="temperature"
                     min="0" max="2" step="0.1" value="${agent.temperature || 0.7}"
                     style="--pct:${tempPct}%">
              <span class="sp-slider-end">2</span>
            </div>
          </div>
          <div class="sp-field">
            <label class="sp-label">最大工具轮次</label>
            <input type="number" class="sp-input sp-input-num" data-field="maxSteps"
                   value="${agent.maxSteps || 10}" min="1" max="50">
          </div>
          <div class="sp-field">
            <label class="sp-label">上下文窗口（0=不限制）</label>
            <input type="number" class="sp-input sp-input-num" data-field="contextWindow"
                   value="${agent.contextWindow || 0}" min="0" step="1000"
                   placeholder="0 = 不限制">
          </div>
        </div>
        <div class="sp-hint">
          高 Temperature → 更有创意但可能胡说。小窗口 → 旧消息会被压缩。
        </div>
      </div>`;
  }

  private renderDisplayTab(viewMode: string, language: string): string {
    const modes: Array<{ id: string; label: string; desc: string }> = [
      { id: 'files', label: '文件视图', desc: '文件级聚合（大项目防崩）' },
      { id: 'standard', label: '标准星图', desc: '完整依赖图 + 社区星系' },
      { id: 'full', label: '观赏模式', desc: '全量渲染，所有边可见' },
    ];
    let opts = '';
    for (const m of modes) {
      const checked = m.id === viewMode ? 'checked' : '';
      opts += `<label class="sp-radio">
        <input type="radio" name="viewMode" value="${m.id}" ${checked}>
        <span class="sp-radio-label">${m.label}</span>
        <span class="sp-radio-desc">${m.desc}</span>
      </label>`;
    }

    const langOpts = [
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
    ];
    let langRadios = '';
    for (const l of langOpts) {
      const checked = l.id === language ? 'checked' : '';
      langRadios += `<label class="sp-radio">
        <input type="radio" name="language" value="${l.id}" ${checked}>
        <span class="sp-radio-label">${l.label}</span>
      </label>`;
    }

    return `
      <div class="sp-tab-content" data-tab="display" style="${this.activeTab === 'display' ? '' : 'display:none'}">
        <div class="sp-section">
          <div class="sp-section-title">默认视角</div>
          <div class="sp-radio-group">${opts}</div>
        </div>
        <div class="sp-section">
          <div class="sp-section-title">语言 / Language</div>
          <div class="sp-radio-group">${langRadios}</div>
        </div>
        <div class="sp-hint">
          图例、聚焦横幅、工具栏提示的语言。其他界面不受影响。
        </div>
      </div>`;
  }

  // ── Events ──

  private wireEvents(): void {
    // Mark dirty on any input change
    this.panel.querySelectorAll('input, select, textarea').forEach((el) => {
      el.addEventListener('input', () => { this.dirty = true; });
      el.addEventListener('change', () => { this.dirty = true; });
    });

    // Tab switching
    this.panel.querySelectorAll('.sp-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const t = (tab as HTMLElement).dataset['tab'] as Tab;
        this.switchTab(t);
      });
    });

    // Close button
    this.panel.querySelector('.sp-close-btn')?.addEventListener('click', () => this.close());
    this.panel.querySelector('.sp-btn-cancel')?.addEventListener('click', () => this.close());

    // Save button
    this.panel.querySelector('.sp-btn-save')?.addEventListener('click', () => this.doSave());

    // Provider selector
    const sel = this.panel.querySelector('[data-field="activeProvider"]') as HTMLSelectElement;
    if (sel) {
      sel.addEventListener('change', () => {
        this.workingSettings.activeProvider = sel.value;
        this.render(); // re-render to show correct provider fields
      });
    }

    // Key visibility toggle
    this.panel.querySelector('.sp-key-toggle')?.addEventListener('click', () => {
      const input = this.panel.querySelector('.sp-key-input') as HTMLInputElement;
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    });

    // Temperature range slider
    const range = this.panel.querySelector('.sp-range') as HTMLInputElement;
    if (range) {
      range.addEventListener('input', () => {
        const val = parseFloat(range.value);
        const pct = Math.round((val / 2) * 100);
        range.style.setProperty('--pct', `${pct}%`);
        const label = range.closest('.sp-field')?.querySelector('.sp-val') as HTMLElement;
        if (label) label.textContent = val.toFixed(1);
      });
    }
  }

  private switchTab(tab: Tab): void {
    this.activeTab = tab;
    // Update tab buttons
    this.panel.querySelectorAll('.sp-tab').forEach((t) => {
      t.classList.toggle('active', (t as HTMLElement).dataset['tab'] === tab);
    });
    // Show/hide tab content
    this.panel.querySelectorAll('.sp-tab-content').forEach((c) => {
      const el = c as HTMLElement;
      el.style.display = el.dataset['tab'] === tab ? '' : 'none';
    });
  }

  // ── Save ──

  private doSave(): void {
    const s = this.workingSettings;
    const active = s.providers.find((p) => p.name === s.activeProvider);
    if (!active) return;

    // Read form values for current provider
    const apiKeyEl = this.panel.querySelector('[data-field="apiKey"]') as HTMLInputElement;
    const modelEl = this.panel.querySelector('[data-field="model"]') as HTMLInputElement;
    const baseUrlEl = this.panel.querySelector('[data-field="baseUrl"]') as HTMLInputElement;
    const thinkingEl = this.panel.querySelector('[data-field="thinking"]') as HTMLInputElement;

    if (apiKeyEl) active.apiKey = apiKeyEl.value.trim();
    if (modelEl) active.model = modelEl.value.trim();
    if (baseUrlEl) active.baseUrl = baseUrlEl.value.trim();
    if (thinkingEl) active.thinking = thinkingEl.value.trim();

    // Update provider in settings
    s.providers = s.providers.map((p) =>
      p.name === active.name ? { ...active } : p,
    );

    // Read Agent form values
    const tempEl = this.panel.querySelector('[data-field="temperature"]') as HTMLInputElement;
    const stepsEl = this.panel.querySelector('[data-field="maxSteps"]') as HTMLInputElement;
    const ctxWinEl = this.panel.querySelector('[data-field="contextWindow"]') as HTMLInputElement;

    if (tempEl) s.agent.temperature = parseFloat(tempEl.value) || 0.7;
    if (stepsEl) s.agent.maxSteps = parseInt(stepsEl.value) || 10;
    if (ctxWinEl) s.agent.contextWindow = parseInt(ctxWinEl.value) || 0;

    // Read display form values
    const viewModeEl = this.panel.querySelector('input[name="viewMode"]:checked') as HTMLInputElement;
    if (viewModeEl) {
      s.display.defaultViewMode = viewModeEl.value as 'standard' | 'full' | 'files';
    }
    const langEl = this.panel.querySelector('input[name="language"]:checked') as HTMLInputElement;
    if (langEl) {
      s.display.language = langEl.value as Lang;
    }

    // Save to localStorage
    saveSettings(s);
    setLang(s.display.language);
    bus.emit('lang:changed', { lang: s.display.language });
    this.originalSettings = JSON.parse(JSON.stringify(s));
    this.dirty = false;

    // Flash save button
    const btn = this.panel.querySelector('.sp-btn-save') as HTMLElement;
    if (btn) {
      btn.innerHTML = `${iconHtml('check-circle', 11)} 已保存`;
      btn.classList.add('sp-btn-ok');
      setTimeout(() => {
        btn.innerHTML = `${iconHtml('save', 11)} 保存`;
        btn.classList.remove('sp-btn-ok');
      }, 1500);
    }

    // Trigger Agent re-init
    if (this.onSave) this.onSave();
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
