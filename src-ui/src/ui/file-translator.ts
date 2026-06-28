// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// File Translator — LLM-powered code-to-human translation panel
// Integrated into FileViewer. Caches results in .hologram/translations/

import { invoke } from '../bridge';
import { loadSettings, getActiveProvider, type ProviderSettings } from '../settings';
import { createAnthropicProvider } from '../provider/anthropic';
import { createOpenAIProvider } from '../provider/openai';
import { ChunkType } from '../provider/types';
import { iconHtml } from './icons';
import type * as monaco from 'monaco-editor';
import './file-translator.css';

// ── Types ────────────────────────────────────────

type PanelMode = 'loading' | 'content' | 'error';
type AuditType = 'bug' | 'risk' | 'smell' | 'ok' | '';

interface TranslationLine {
  code: string;
  human: string;
  audit: string;
  audit_type: AuditType;
}

interface CacheData {
  file: string;
  hash: string;
  translated_at: string;
  model: string;
  language: string;
  line_count: number;
  lines: TranslationLine[];
}

interface TranslatorState {
  visible: boolean;
  mode: PanelMode;
  error: string | null;
  cacheHit: boolean;
  translatedAt: string | null;
  lines: TranslationLine[];
  fileName: string;
  filePath: string | null;
  lineCount: number;
  waitSeconds: number;
}

// ── System Prompt ────────────────────────────────

const SYSTEM_PROMPT = `你是一个代码翻译器。你的唯一任务是把源代码翻译成目标自然语言。

翻译规则：
1. 逐行对应翻译。每行代码必须有一行对应的翻译。
2. 翻译要解释代码的意图和逻辑，不要解释语法。
3. 对于空行或纯符号行，翻译可以为空字符串。
4. 用"人话"表达，不要让输出看起来像技术文档。

审计规则：
5. 逐行检查代码。只有在你确信有问题时才标注，不确定就不标。
6. 标注要写明"为什么这是问题"以及"可能导致的后果"。
7. 标注语言要和翻译语言一致（如中文翻译用中文审计）。
8. audit_type 只能是以下值之一："bug"、"risk"、"smell"、"ok"、""。
9. 一行代码最多标一个 audit_type。如果一行有多个问题，只标最严重的一个（bug > risk > smell）。
10. 如果一行代码写得特别好（正确使用锁、优雅的错误处理、清晰的命名等），标为 "ok" 并简要称赞。
11. 不要标注"这里也许可以优化"这类模糊建议。只有明确的问题才标。
12. 如果你发现一个模式在代码里重复出现，只在第一次出现时标注。

审计排除规则（以下情况不标注，audit_type 留空 ""）：
13. 空行、纯注释行、纯符号行 → 不标注
14. import / from / use / require 等导入语句 → 不标注（除非散落在文件中间明显组织混乱）
15. 装饰器 / 注解 → 不标注
16. 类定义和函数定义的签名行（如 def xxx():、class YYY:、function foo() {）
17. 纯 return / pass / break / continue 语句 → 不标注

审计必须检查的情况：
18. 任何包含逻辑判断的行（if / elif / else / switch / match）
19. 异常处理相关的行（try / except / catch / finally）
20. 数据操作的行（赋值、函数调用、循环）
21. 涉及线程/锁/并发的行
22. 涉及文件 I/O 的行
23. 涉及网络请求的行

返回格式：严格的 JSON，结构为：
{
  "lines": [
    {
      "code": "原始代码行",
      "human": "这行代码的人话翻译",
      "audit": "审计发现，无则为空字符串",
      "audit_type": "bug | risk | smell | ok | 空字符串"
    }
  ]
}`;

// ── Helpers ──────────────────────────────────────

async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function calcMaxTokens(lineCount: number, isSelection: boolean): number {
  // 全文翻译 32K（Anthropic 上限），选中翻译 8K。
  // 不按行数精确估算——多申的 token 不花钱，少了会被截断。
  return isSelection ? 8192 : 32768;
}

// ── FileTranslator ───────────────────────────────

export class FileTranslator {
  // DOM
  private container!: HTMLElement;
  private panel!: HTMLElement;
  private headerTitle!: HTMLElement;
  private headerMeta!: HTMLElement;
  private loadingArea!: HTMLElement;
  private loadingText!: HTMLElement;
  private loadingWait!: HTMLElement;
  private errorArea!: HTMLElement;
  private errorText!: HTMLElement;
  private columnsArea!: HTMLElement;
  private colBodies: HTMLElement[] = [];
  private divider!: HTMLElement;

  // Callback
  private onLayoutChange: () => void;

  // State
  private state: TranslatorState;
  private abortController: AbortController | null = null;
  private waitInterval: ReturnType<typeof setInterval> | null = null;
  private sessionCache: Map<string, TranslationLine[]> = new Map();
  private currentFilePath: string | null = null; // file being translated (for tab-close check)

  // Resize state
  private panelHeightRatio = 0.45;
  private colWidths = [1 / 3, 1 / 3, 1 / 3]; // fractions
  private draggingDivider = false;
  private draggingColResizer = -1;
  private dragStartY = 0;
  private dragStartH = 0;
  private dragStartX = 0;
  private dragStartWidths: number[] = [];
  private parentHeight = 500;

  // ── Constructor ──────────────────────────────

  constructor(
    parentEl: HTMLElement,
    onLayoutChange: () => void,
    private getEditor: () => monaco.editor.IStandaloneCodeEditor | null,
  ) {
    this.onLayoutChange = onLayoutChange;
    this.state = {
      visible: false,
      mode: 'loading',
      error: null,
      cacheHit: false,
      translatedAt: null,
      lines: [],
      fileName: '',
      filePath: null,
      lineCount: 0,
      waitSeconds: 0,
    };
    this.buildDOM(parentEl);
  }

  // ── DOM construction ─────────────────────────

  private buildDOM(parentEl: HTMLElement): void {
    // Divider (between editor and panel)
    this.divider = document.createElement('div');
    this.divider.className = 'ft-divider';
    this.divider.addEventListener('pointerdown', (e) => this.onDividerStart(e));

    // Panel
    this.panel = document.createElement('div');
    this.panel.className = 'ft-panel';

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'ft-header';

    this.headerTitle = document.createElement('span');
    this.headerTitle.className = 'ft-title';
    this.headerTitle.textContent = '🔮 翻译器';

    this.headerMeta = document.createElement('span');
    this.headerMeta.className = 'ft-meta';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ft-close-btn';
    closeBtn.innerHTML = iconHtml('close', 12);
    closeBtn.title = '关闭翻译面板';
    closeBtn.addEventListener('click', () => this.destroy());

    header.appendChild(this.headerTitle);
    header.appendChild(this.headerMeta);
    header.appendChild(closeBtn);

    // ── Loading area ──
    this.loadingArea = document.createElement('div');
    this.loadingArea.className = 'ft-loading';
    this.loadingArea.style.display = 'none';
    const loadIcon = document.createElement('div');
    loadIcon.className = 'ft-loading-icon';
    loadIcon.innerHTML = iconHtml('translate', 32);
    this.loadingText = document.createElement('div');
    this.loadingText.className = 'ft-loading-text';
    this.loadingWait = document.createElement('div');
    this.loadingWait.className = 'ft-loading-wait';
    this.loadingArea.appendChild(loadIcon);
    this.loadingArea.appendChild(this.loadingText);
    this.loadingArea.appendChild(this.loadingWait);

    // ── Error area ──
    this.errorArea = document.createElement('div');
    this.errorArea.className = 'ft-error';
    this.errorArea.style.display = 'none';
    const errIcon = document.createElement('div');
    errIcon.className = 'ft-error-icon';
    errIcon.textContent = '⚠️';
    this.errorText = document.createElement('div');
    this.errorText.className = 'ft-error-text';
    this.errorArea.appendChild(errIcon);
    this.errorArea.appendChild(this.errorText);

    // ── Three-column content area ──
    this.columnsArea = document.createElement('div');
    this.columnsArea.className = 'ft-columns';
    this.columnsArea.style.display = 'none';

    const colDefs = [
      { cls: 'ft-code-hdr', label: '📄 原始代码' },
      { cls: 'ft-human-hdr', label: '💬 人话视图' },
      { cls: 'ft-audit-hdr', label: '🔍 审计' },
    ];

    colDefs.forEach((def, i) => {
      const col = document.createElement('div');
      col.className = 'ft-col';
      col.style.flex = `${this.colWidths[i]}`;

      const colHdr = document.createElement('div');
      colHdr.className = `ft-col-header ${def.cls}`;
      colHdr.textContent = def.label;
      col.appendChild(colHdr);

      const colBody = document.createElement('div');
      colBody.className = 'ft-col-body';
      colBody.setAttribute('data-col', String(i));
      colBody.addEventListener('scroll', () => this.onColScroll(i));
      col.appendChild(colBody);
      this.colBodies.push(colBody);

      this.columnsArea.appendChild(col);

      // Resizer between columns (not after last)
      if (i < 2) {
        const resizer = document.createElement('div');
        resizer.className = 'ft-col-resizer';
        resizer.addEventListener('pointerdown', (e) => this.onColResizerStart(e, i));
        this.columnsArea.appendChild(resizer);
      }
    });

    // Assemble panel
    this.panel.appendChild(header);
    this.panel.appendChild(this.loadingArea);
    this.panel.appendChild(this.errorArea);
    this.panel.appendChild(this.columnsArea);

    // Insert into parent: divider + panel before the resize handle (fv-grip)
    const resizeHandle = parentEl.querySelector<HTMLElement>('.fv-grip');
    if (resizeHandle) {
      resizeHandle.before(this.divider, this.panel);
    } else {
      parentEl.appendChild(this.divider);
      parentEl.appendChild(this.panel);
    }
    this.container = this.panel;

    // Global pointer listeners for resize
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
  }

  // ── Public API ────────────────────────────────

  /** Full-file translation entry point. */
  async translateFile(filePath: string): Promise<void> {
    // Toggle: if panel open for the same file, close it
    if (this.state.visible && this.currentFilePath === filePath) {
      this.destroy();
      return;
    }

    // If panel open for a different file, abort old and start fresh
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.clearWaitInterval();

    const settings = loadSettings();
    const provider = getActiveProvider(settings);

    // 1. Check API Key
    if (!provider.apiKey) {
      this.show(filePath);
      this.renderError('请先在设置中配置 API Key');
      return;
    }

    // 2. Read file content from editor
    const editor = this.findMonacoEditor();
    if (!editor) {
      this.show(filePath);
      this.renderError('无法访问编辑器');
      return;
    }
    const model = editor.getModel();
    if (!model) {
      this.show(filePath);
      this.renderError('无法读取文件模型');
      return;
    }
    const content = model.getValue();
    if (!content.trim()) {
      this.show(filePath);
      this.renderError('文件为空，无需翻译');
      return;
    }

    const codeLines = content.split('\n');
    const lineCount = codeLines.length;
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

    // Show loading
    this.currentFilePath = filePath;
    this.state = {
      visible: true, mode: 'loading', error: null,
      cacheHit: false, translatedAt: null,
      lines: [], fileName, filePath, lineCount, waitSeconds: 0,
    };
    this.show(filePath);
    this.renderLoading(fileName, lineCount);

    // 3. Compute hash
    const hash = await hashContent(content);

    // 4. Check cache
    const cachePath = `.hologram/translations/${hash}.json`;
    try {
      const raw = await invoke<string>('read_file_content', { filePath: cachePath });
      const cached: CacheData = JSON.parse(raw);
      if (cached.lines && Array.isArray(cached.lines)) {
        const aligned = this.alignLines(cached.lines, codeLines);
        this.state = {
          visible: true, mode: 'content', error: null,
          cacheHit: true,
          translatedAt: cached.translated_at,
          lines: aligned, fileName, filePath, lineCount, waitSeconds: 0,
        };
        this.clearWaitInterval();
        this.renderContent(aligned, { cacheHit: true, translatedAt: cached.translated_at, fileName });
        return;
      }
      // Corrupt JSON → fall through to API
    } catch {
      // Cache miss → fall through to API
    }

    // 5. Call API
    this.startWaitInterval();
    try {
      const maxTokens = calcMaxTokens(lineCount, false);
      const language = settings.display.language === 'en' ? 'English' : '中文';
      const responseJson = await this.callApi(provider, content, codeLines, lineCount, language, maxTokens);

      // 6. Validate + align
      const aligned = this.alignLines(responseJson.lines, codeLines);

      // Write cache
      const cacheData: CacheData = {
        file: fileName,
        hash,
        translated_at: new Date().toISOString(),
        model: provider.model,
        language: settings.display.language,
        line_count: lineCount,
        lines: aligned,
      };
      try {
        await invoke('write_file_content', {
          filePath: cachePath,
          content: JSON.stringify(cacheData),
        });
      } catch (writeErr) {
        console.warn('翻译缓存写入失败:', writeErr);
      }

      // Update session cache
      this.sessionCache.set(filePath, aligned);

      this.state = {
        visible: true, mode: 'content', error: null,
        cacheHit: false,
        translatedAt: cacheData.translated_at,
        lines: aligned, fileName, filePath, lineCount, waitSeconds: 0,
      };
      this.clearWaitInterval();
      this.renderContent(aligned, { cacheHit: false, translatedAt: cacheData.translated_at, fileName });

    } catch (err: any) {
      this.clearWaitInterval();
      if (err.name === 'AbortError') {
        // Silently discarded — user closed panel or switched tabs
        return;
      }
      this.state = {
        ...this.state,
        mode: 'error', error: err.message || String(err),
      };
      this.renderError(err.message || String(err));
    }
  }

  /** Selection translation entry point. */
  async translateSelection(text: string, startLine: number, endLine: number): Promise<void> {
    // Abort any in-flight request
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.clearWaitInterval();

    const settings = loadSettings();
    const provider = getActiveProvider(settings);

    if (!provider.apiKey) {
      this.show(null);
      this.renderError('请先在设置中配置 API Key');
      return;
    }

    const codeLines = text.split('\n');
    const lineCount = codeLines.length;

    this.currentFilePath = null; // selection doesn't belong to a file
    this.state = {
      visible: true, mode: 'loading', error: null,
      cacheHit: false, translatedAt: null,
      lines: [], fileName: `选中 ${lineCount} 行翻译`, filePath: null, lineCount, waitSeconds: 0,
    };
    this.show(null);
    this.renderLoading(`选中 ${lineCount} 行翻译`, lineCount);

    this.startWaitInterval();
    try {
      const maxTokens = calcMaxTokens(lineCount, true);
      const language = settings.display.language === 'en' ? 'English' : '中文';
      const rangeNote = `\n代码行范围：第 ${startLine}-${endLine} 行（共 ${lineCount} 行）`;
      const responseJson = await this.callApi(provider, text, codeLines, lineCount, language, maxTokens, rangeNote);

      const aligned = this.alignLines(responseJson.lines, codeLines);

      // Store in session memory only
      const sessionKey = `selection:${startLine}:${endLine}:${Date.now()}`;
      this.sessionCache.set(sessionKey, aligned);

      this.state = {
        visible: true, mode: 'content', error: null,
        cacheHit: false,
        translatedAt: new Date().toISOString(),
        lines: aligned,
        fileName: `选中 ${lineCount} 行翻译`,
        filePath: null, lineCount, waitSeconds: 0,
      };
      this.clearWaitInterval();
      this.renderContent(aligned, { cacheHit: false, translatedAt: new Date().toISOString(), fileName: `选中 ${lineCount} 行翻译` });

    } catch (err: any) {
      this.clearWaitInterval();
      if (err.name === 'AbortError') return;
      this.state = { ...this.state, mode: 'error', error: err.message || String(err) };
      this.renderError(err.message || String(err));
    }
  }

  /** Hide panel, keep in-flight API request running. For tab switch. */
  detach(): void {
    if (!this.state.visible) return;
    this.state.visible = false;
    this.panel.classList.remove('ft-open');
    this.clearWaitInterval();
    // Do NOT abort — let the API finish and write cache
    this.currentFilePath = null;
    this.onLayoutChange();
  }

  /** Destroy panel, abort in-flight request, clean up. */
  destroy(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.clearWaitInterval();
    this.state.visible = false;
    this.panel.classList.remove('ft-open');
    this.currentFilePath = null;
    this.onLayoutChange();
  }

  /** Check if currently translating the given file path. */
  isTranslatingFile(filePath: string): boolean {
    return this.currentFilePath === filePath;
  }

  // ── Panel visibility ──────────────────────────

  private show(filePath: string | null): void {
    this.state.visible = true;
    this.panel.classList.add('ft-open');
    // Set initial height based on ratio
    const parentH = this.panel.parentElement?.clientHeight || 500;
    this.parentHeight = parentH;
    this.panel.style.height = `${Math.floor(parentH * this.panelHeightRatio)}px`;
    this.onLayoutChange();
  }

  // ── Rendering ─────────────────────────────────

  private renderLoading(fileName: string, lineCount: number): void {
    this.headerTitle.textContent = `🔮 翻译器 · ${fileName} · 正在翻译…`;
    this.headerMeta.textContent = '';
    this.loadingText.textContent = `正在翻译 ${lineCount} 行代码…`;
    this.loadingWait.textContent = '';
    this.loadingArea.style.display = '';
    this.errorArea.style.display = 'none';
    this.columnsArea.style.display = 'none';
    this.state.waitSeconds = 0;
  }

  private renderContent(
    lines: TranslationLine[],
    meta: { cacheHit: boolean; translatedAt: string; fileName: string },
  ): void {
    this.loadingArea.style.display = 'none';
    this.errorArea.style.display = 'none';
    this.columnsArea.style.display = '';

    const cacheLabel = meta.cacheHit ? `缓存命中 · ${relativeTime(meta.translatedAt)} 前` : '新翻译 · 刚刚';

    // Audit stats
    let bug = 0, risk = 0, smell = 0, ok = 0;
    for (const l of lines) {
      if (l.audit_type === 'bug') bug++;
      else if (l.audit_type === 'risk') risk++;
      else if (l.audit_type === 'smell') smell++;
      else if (l.audit_type === 'ok') ok++;
    }
    const issueParts: string[] = [];
    if (bug > 0) issueParts.push(`${bug} 致命`);
    if (risk > 0) issueParts.push(`${risk} 风险`);
    if (smell > 0) issueParts.push(`${smell} 坏味道`);
    const issueLabel = issueParts.length > 0 ? issueParts.join(' ') : '未发现问题 ✅';

    this.headerTitle.textContent = `🔮 翻译器 · ${meta.fileName}`;
    this.headerMeta.textContent = `${cacheLabel} · ${issueLabel}`;

    // Render columns
    const colDefs = [
      { body: this.colBodies[0], cls: 'ft-code-line', render: (l: TranslationLine, i: number) =>
          `<span class="ft-ln">${i + 1}</span><span class="ft-ct">${this.escHtml(l.code)}</span>` },
      { body: this.colBodies[1], cls: 'ft-human-line', render: (l: TranslationLine, _i: number) =>
          `<span class="ft-ct">${this.escHtml(l.human) || '<span style="opacity:0.3">—</span>'}</span>` },
      { body: this.colBodies[2], cls: 'ft-audit-line', render: (l: TranslationLine, _i: number) =>
          this.renderAuditCell(l) },
    ];

    colDefs.forEach((def) => {
      def.body.innerHTML = '';
      lines.forEach((l, i) => {
        const row = document.createElement('div');
        row.className = def.cls;
        row.setAttribute('data-line', String(i));
        row.addEventListener('mouseenter', () => this.highlightLine(i));
        row.addEventListener('mouseleave', () => this.unhighlightLine(i));
        row.innerHTML = def.render(l, i);
        def.body.appendChild(row);
      });
    });
  }

  private renderAuditCell(l: TranslationLine): string {
    if (!l.audit_type) {
      return '<span class="ft-audit-dash">—</span>';
    }
    const tagMap: Record<string, string> = {
      bug: '致命',
      risk: '风险',
      smell: '坏味道',
      ok: '正确',
    };
    const tagLabel = tagMap[l.audit_type] || l.audit_type;
    return `<span class="ft-audit-tag ft-${l.audit_type}">${tagLabel}</span><span class="ft-audit-text">${this.escHtml(l.audit)}</span>`;
  }

  private renderError(message: string): void {
    this.loadingArea.style.display = 'none';
    this.columnsArea.style.display = 'none'; // keep existing content hidden
    this.errorArea.style.display = '';
    this.errorText.textContent = message;
    const fileName = this.state.fileName || '文件';
    this.headerTitle.textContent = `🔮 翻译器 · ${fileName} · 翻译失败`;
    this.headerMeta.textContent = '';
  }

  // ── Line sync ─────────────────────────────────

  private highlightLine(i: number): void {
    for (const body of this.colBodies) {
      const rows = body.querySelectorAll<HTMLElement>(`[data-line="${i}"]`);
      rows.forEach((r) => r.classList.add('ft-highlight'));
    }
  }

  private unhighlightLine(i: number): void {
    for (const body of this.colBodies) {
      const rows = body.querySelectorAll<HTMLElement>(`[data-line="${i}"]`);
      rows.forEach((r) => r.classList.remove('ft-highlight'));
    }
  }

  private onColScroll(colIdx: number): void {
    const srcBody = this.colBodies[colIdx];
    const rowCls = ['.ft-code-line', '.ft-human-line', '.ft-audit-line'][colIdx];

    // Find the first fully visible line in the scrolled column
    const rows = srcBody.querySelectorAll<HTMLElement>(rowCls);
    let targetLine = 0;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const containerRect = srcBody.getBoundingClientRect();
      if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
        targetLine = parseInt(row.getAttribute('data-line') || '0', 10);
        break;
      }
      // Fallback: first partially visible
      if (rect.bottom > containerRect.top) {
        targetLine = parseInt(row.getAttribute('data-line') || '0', 10);
        break;
      }
    }

    // Sync all OTHER columns to the same line
    for (let i = 0; i < this.colBodies.length; i++) {
      if (i === colIdx) continue;
      const targetRow = this.colBodies[i].querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
      if (targetRow) {
        this.colBodies[i].scrollTop = targetRow.offsetTop - this.colBodies[i].offsetTop;
      }
    }
  }

  // ── API call ──────────────────────────────────

  private async callApi(
    provider: ProviderSettings,
    content: string,
    codeLines: string[],
    lineCount: number,
    language: string,
    maxTokens: number,
    extraNote?: string,
  ): Promise<{ lines: TranslationLine[] }> {
    // Create fresh AbortController for user cancellation (tab close / panel destroy)
    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const systemPrompt = `${SYSTEM_PROMPT}\n\n代码行数：${lineCount}\n目标语言：${language}${extraNote || ''}`;
    const userMessage = `代码内容：\n\`\`\`\n${content}\n\`\`\`\n\n请翻译并返回 JSON。`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userMessage },
    ];

    // Use the same proven provider infrastructure as chat/agent (streaming + retry + SSE)
    let rawText = '';
    if (provider.kind === 'anthropic') {
      const p = createAnthropicProvider({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        thinking: provider.thinking,
      });
      for await (const chunk of p.stream(signal, { messages, tools: [], temperature: 0, max_tokens: maxTokens })) {
        if (chunk.type === ChunkType.Text) rawText += chunk.text;
        else if (chunk.type === ChunkType.Error) throw chunk.err!;
      }
    } else {
      const p = createOpenAIProvider({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        disableThinking: true, // translation doesn't need reasoning — skip chain-of-thought
      });
      for await (const chunk of p.stream(signal, { messages, tools: [], temperature: 0, max_tokens: maxTokens })) {
        if (chunk.type === ChunkType.Text) rawText += chunk.text;
        else if (chunk.type === ChunkType.Error) throw chunk.err!;
      }
    }

    // Try to extract JSON from the response
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[1]);
        } catch {
          throw new Error(`模型返回格式异常，请重试\n\n${rawText.slice(0, 500)}`);
        }
      } else {
        throw new Error(`模型返回格式异常，请重试\n\n${rawText.slice(0, 500)}`);
      }
    }

    if (!parsed.lines || !Array.isArray(parsed.lines)) {
      throw new Error(`模型返回缺少 lines 数组，请重试\n\n${rawText.slice(0, 500)}`);
    }

    return parsed;
  }

  // ── Line alignment ────────────────────────────

  private alignLines(modelLines: TranslationLine[], codeLines: string[]): TranslationLine[] {
    const result: TranslationLine[] = [];
    for (let i = 0; i < codeLines.length; i++) {
      if (i < modelLines.length) {
        result.push({
          code: codeLines[i],
          human: modelLines[i].human || '',
          audit: modelLines[i].audit || '',
          audit_type: (modelLines[i].audit_type as AuditType) || '',
        });
      } else {
        // Model returned fewer lines — fill with empty
        result.push({
          code: codeLines[i],
          human: '',
          audit: '',
          audit_type: '',
        });
      }
    }
    // If model returned more, they're discarded (only iterate up to codeLines.length)
    return result;
  }

  // ── Wait interval ─────────────────────────────

  private startWaitInterval(): void {
    this.clearWaitInterval();
    this.waitInterval = setInterval(() => {
      this.state.waitSeconds += 3;
      if (this.state.visible && this.state.mode === 'loading') {
        this.loadingWait.textContent = `已等待 ${this.state.waitSeconds}s…`;
      }
      if (this.state.waitSeconds >= 60) {
        this.loadingWait.textContent = '已等待 60s…';
      }
    }, 3000);
  }

  private clearWaitInterval(): void {
    if (this.waitInterval) {
      clearInterval(this.waitInterval);
      this.waitInterval = null;
    }
  }

  // ── Monaco editor access ──────────────────────

  private findMonacoEditor(): monaco.editor.IStandaloneCodeEditor | null {
    return this.getEditor();
  }

  // ── Resize: panel ↔ editor divider ────────────

  private onDividerStart(e: PointerEvent): void {
    e.preventDefault();
    this.draggingDivider = true;
    this.dragStartY = e.clientY;
    this.dragStartH = parseInt(this.panel.style.height) || 200;
    this.divider.classList.add('ft-dragging');
    this.divider.setPointerCapture(e.pointerId);
  }

  private onColResizerStart(e: PointerEvent, colIdx: number): void {
    e.preventDefault();
    e.stopPropagation();
    this.draggingColResizer = colIdx;
    this.dragStartX = e.clientX;
    this.dragStartWidths = [...this.colWidths];
    const resizer = this.columnsArea.querySelectorAll('.ft-col-resizer')[colIdx] as HTMLElement;
    if (resizer) resizer.classList.add('ft-resizing');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.draggingDivider) {
      const dy = this.dragStartY - e.clientY; // drag up = increase panel
      const parentH = this.panel.parentElement?.clientHeight || this.parentHeight;
      const newH = Math.max(60, Math.min(parentH * 0.8, this.dragStartH + dy));
      this.panel.style.height = `${newH}px`;
      this.panelHeightRatio = newH / Math.max(1, parentH);
      this.onLayoutChange();
    }
    if (this.draggingColResizer >= 0) {
      const dx = e.clientX - this.dragStartX;
      const columnsEl = this.columnsArea;
      const totalW = columnsEl.clientWidth;
      if (totalW === 0) return;
      const dFrac = dx / totalW;
      const i = this.draggingColResizer;
      const leftMin = 0.12;
      const rightMin = 0.12;
      let newLeft = this.dragStartWidths[i] + dFrac;
      let newRight = this.dragStartWidths[i + 1] - dFrac;
      if (newLeft < leftMin) { newLeft = leftMin; newRight = 1 - leftMin - this.colWidths[2]; }
      if (newRight < rightMin) { newRight = rightMin; newLeft = 1 - rightMin - this.colWidths[0]; }
      // Recalculate — keep it simple: just two adjacent cols
      const remaining = 1 - newLeft - newRight;
      // Distribute remaining to the third column
      this.colWidths = [0, 0, 0];
      this.colWidths[i] = newLeft;
      this.colWidths[i + 1] = newRight;
      const thirdIdx = 3 - i - (i + 1); // 0+1=1→2, 1+2=3→0
      this.colWidths[thirdIdx] = Math.max(0.1, remaining);

      // Normalize
      const sum = this.colWidths.reduce((a, b) => a + b, 0);
      this.colWidths = this.colWidths.map((w) => w / sum);

      // Apply
      const cols = this.columnsArea.querySelectorAll<HTMLElement>('.ft-col');
      cols.forEach((col, j) => {
        col.style.flex = String(this.colWidths[j]);
      });
    }
  }

  private onPointerUp(): void {
    if (this.draggingDivider) {
      this.draggingDivider = false;
      this.divider.classList.remove('ft-dragging');
    }
    if (this.draggingColResizer >= 0) {
      const resizer = this.columnsArea.querySelectorAll('.ft-col-resizer')[this.draggingColResizer] as HTMLElement;
      if (resizer) resizer.classList.remove('ft-resizing');
      this.draggingColResizer = -1;
    }
  }

  // ── Util ──────────────────────────────────────

  private escHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
