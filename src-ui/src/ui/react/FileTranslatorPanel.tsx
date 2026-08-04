// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// FileTranslatorPanel — file-translator.ts 的 React 重写。
// 基于 LLM 的代码翻译（代码转人话），三列视图。
// 集成到 FileViewer 中。结果缓存在 .hologram/translations/ 目录。

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../bridge';
import { createProvider } from '../../provider';
import { ChunkType } from '../../provider/types';
import { getActiveProvider, loadSettings, restoreSecrets, type ProviderSettings } from '../../settings';
import { iconHtml } from '../icons';
import { escapeAttr } from './helpers';
import '../file-translator.css';

// ── 类型 ──

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

// ── 辅助函数 ──

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

function calcMaxTokens(_lineCount: number, isSelection: boolean): number {
  return isSelection ? 8192 : 32768;
}

function alignLines(modelLines: TranslationLine[], codeLines: string[]): TranslationLine[] {
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
      result.push({ code: codeLines[i], human: '', audit: '', audit_type: '' });
    }
  }
  return result;
}

// ── 系统提示词 ──

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
16. 类定义和函数定义的签名行
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

// ── 组件 ──

export const FileTranslatorApp: React.FC<{
  filePath: string | null;
  onClose: () => void;
  onLayoutChange: () => void;
  getEditorContent: () => string | null;
}> = ({ filePath, onClose, onLayoutChange, getEditorContent }) => {
  // 状态
  const [mode, setMode] = useState<'loading' | 'content' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [lines, setLines] = useState<TranslationLine[]>([]);
  const [cacheHit, setCacheHit] = useState(false);
  const [translatedAt, setTranslatedAt] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [lineCount, setLineCount] = useState(0);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [issueStats, setIssueStats] = useState<{ bug: number; risk: number; smell: number; ok: number }>({
    bug: 0,
    risk: 0,
    smell: 0,
    ok: 0,
  });

  // 引用
  const panelRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const colBodiesRef = useRef<(HTMLDivElement | null)[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const waitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const panelHeightRatio = useRef(0.45);
  const colWidths = useRef([1 / 3, 1 / 3, 1 / 3]);

  // 缩放状态
  const [panelHeight, setPanelHeight] = useState(200);

  // ── 悬停高亮 ──

  const highlightLine = useCallback((i: number) => {
    colBodiesRef.current.forEach((body) => {
      body?.querySelectorAll<HTMLElement>(`[data-line="${i}"]`).forEach((r) => r.classList.add('ft-highlight'));
    });
  }, []);

  const unhighlightLine = useCallback((i: number) => {
    colBodiesRef.current.forEach((body) => {
      body?.querySelectorAll<HTMLElement>(`[data-line="${i}"]`).forEach((r) => r.classList.remove('ft-highlight'));
    });
  }, []);

  // ── 同步滚动 ──

  const onColScroll = useCallback((colIdx: number) => {
    const srcBody = colBodiesRef.current[colIdx];
    if (!srcBody) return;
    const rowCls = ['.ft-code-line', '.ft-human-line', '.ft-audit-line'][colIdx];
    const rows = srcBody.querySelectorAll<HTMLElement>(rowCls);
    let targetLine = 0;
    const containerRect = srcBody.getBoundingClientRect();
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
        targetLine = parseInt(row.getAttribute('data-line') || '0', 10);
        break;
      }
      if (rect.bottom > containerRect.top) {
        targetLine = parseInt(row.getAttribute('data-line') || '0', 10);
        break;
      }
    }
    for (let i = 0; i < colBodiesRef.current.length; i++) {
      if (i === colIdx) continue;
      const body = colBodiesRef.current[i];
      if (!body) continue;
      const targetRow = body.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
      if (targetRow) body.scrollTop = targetRow.offsetTop - body.offsetTop;
    }
  }, []);

  // ── 渲染后为列体绑定事件监听器 ──

  const wireColumnListeners = useCallback(() => {
    colBodiesRef.current.forEach((body, i) => {
      if (!body) return;
      body.onscroll = () => onColScroll(i);
      body.querySelectorAll<HTMLElement>('[data-line]').forEach((row) => {
        const lineNum = parseInt(row.getAttribute('data-line') || '0', 10);
        row.onmouseenter = () => highlightLine(lineNum);
        row.onmouseleave = () => unhighlightLine(lineNum);
      });
    });
  }, [onColScroll, highlightLine, unhighlightLine]);

  // ── 将列渲染为 HTML ──

  const renderColumnsHtml = useCallback((l: TranslationLine[]) => {
    const codeHtml = l
      .map(
        (ln, i) =>
          `<div class="ft-code-line" data-line="${i}"><span class="ft-ln">${i + 1}</span><span class="ft-ct">${escapeAttr(ln.code)}</span></div>`,
      )
      .join('');
    const humanHtml = l
      .map(
        (ln, i) =>
          `<div class="ft-human-line" data-line="${i}"><span class="ft-ct">${escapeAttr(ln.human) || '<span style="opacity:0.3">—</span>'}</span></div>`,
      )
      .join('');
    const auditHtml = l
      .map((ln, i) => {
        if (!ln.audit_type)
          return `<div class="ft-audit-line" data-line="${i}"><span class="ft-audit-dash">—</span></div>`;
        const tagMap: Record<string, string> = { bug: '致命', risk: '风险', smell: '坏味道', ok: '正确' };
        const tagLabel = tagMap[ln.audit_type] || ln.audit_type;
        return `<div class="ft-audit-line" data-line="${i}"><span class="ft-audit-tag ft-${ln.audit_type}">${tagLabel}</span><span class="ft-audit-text">${escapeAttr(ln.audit)}</span></div>`;
      })
      .join('');
    return { codeHtml, humanHtml, auditHtml };
  }, []);

  // ── LLM API 调用 ──

  const callApi = useCallback(
    async (
      provider: ProviderSettings,
      content: string,
      _codeLines: string[],
      lineCount_: number,
      language: string,
      maxTokens: number,
      extraNote?: string,
    ): Promise<{ lines: TranslationLine[] }> => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      const systemPrompt = `${SYSTEM_PROMPT}\n\n代码行数：${lineCount_}\n目标语言：${language}${extraNote || ''}`;
      const userMessage = `代码内容：\n\`\`\`\n${content}\n\`\`\`\n\n请翻译并返回 JSON。`;
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userMessage },
      ];

      let rawText = '';
      const p = createProvider(provider, { disableThinking: true });
      for await (const chunk of p.stream(signal, { messages, tools: [], temperature: 0, max_tokens: maxTokens })) {
        if (chunk.type === ChunkType.Text) rawText += chunk.text;
        else if (chunk.type === ChunkType.Error) throw chunk.err!;
      }

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
    },
    [],
  );

  // ── 主翻译流程 ──

  const startTranslation = useCallback(
    async (fp: string) => {
      const settings = await restoreSecrets(loadSettings());
      const provider = getActiveProvider(settings);

      if (!provider.apiKey) {
        setMode('error');
        setErrorMsg('请先在设置中配置 API Key');
        return;
      }

      const content = getEditorContent();
      if (!content) {
        setMode('error');
        setErrorMsg('无法读取文件内容');
        return;
      }
      if (!content.trim()) {
        setMode('error');
        setErrorMsg('文件为空，无需翻译');
        return;
      }

      const codeLines = content.split('\n');
      const lc = codeLines.length;
      const fn = fp.replace(/\\/g, '/').split('/').pop() || fp;

      setMode('loading');
      setFileName(fn);
      setLineCount(lc);
      setErrorMsg('');
      setLines([]);
      setWaitSeconds(0);

      // 启动等待计时器
      if (waitTimerRef.current) clearInterval(waitTimerRef.current);
      waitTimerRef.current = setInterval(() => {
        setWaitSeconds((w) => w + 3);
      }, 3000);

      try {
        // 缓存检查
        const hash = await hashContent(content);
        const cachePath = `.hologram/translations/${hash}.json`;
        try {
          const raw = await rpc<string>('read_file_content', { filePath: cachePath });
          const cached: CacheData = JSON.parse(raw);
          if (cached.lines && Array.isArray(cached.lines)) {
            const aligned = alignLines(cached.lines, codeLines);
            setLines(aligned);
            setCacheHit(true);
            setTranslatedAt(cached.translated_at);
            setMode('content');
            if (waitTimerRef.current) {
              clearInterval(waitTimerRef.current);
              waitTimerRef.current = null;
            }
            computeStats(aligned);
            return;
          }
        } catch {
          /* 缓存未命中 */
        }

        // API 调用
        const maxTokens = calcMaxTokens(lc, false);
        const language = settings.display.language === 'en' ? 'English' : '中文';
        const response = await callApi(provider, content, codeLines, lc, language, maxTokens);
        const aligned = alignLines(response.lines, codeLines);

        // 写入缓存
        const cacheData: CacheData = {
          file: fn,
          hash,
          translated_at: new Date().toISOString(),
          model: provider.model,
          language: settings.display.language,
          line_count: lc,
          lines: aligned,
        };
        try {
          await rpc('write_file_content', { filePath: cachePath, content: JSON.stringify(cacheData) });
        } catch {
          /* 忽略 */
        }

        setLines(aligned);
        setCacheHit(false);
        setTranslatedAt(null);
        setMode('content');
        computeStats(aligned);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setMode('error');
        setErrorMsg(e?.message || '翻译失败');
      } finally {
        if (waitTimerRef.current) {
          clearInterval(waitTimerRef.current);
          waitTimerRef.current = null;
        }
      }
    },
    [getEditorContent, callApi, computeStats],
  );

  function computeStats(ls: TranslationLine[]) {
    let bug = 0,
      risk = 0,
      smell = 0,
      ok = 0;
    for (const l of ls) {
      if (l.audit_type === 'bug') bug++;
      else if (l.audit_type === 'risk') risk++;
      else if (l.audit_type === 'smell') smell++;
      else if (l.audit_type === 'ok') ok++;
    }
    setIssueStats({ bug, risk, smell, ok });
  }

  // filePath 变化时触发
  useEffect(() => {
    if (filePath) startTranslation(filePath);
    return () => {
      if (waitTimerRef.current) clearInterval(waitTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [filePath, startTranslation]);

  // 内容渲染后绑定列监听器
  useEffect(() => {
    if (mode === 'content') {
      // 使用 rAF 确保 DOM 已绘制
      requestAnimationFrame(() => wireColumnListeners());
    }
  }, [mode, wireColumnListeners]);

  // ── 分隔条拖拽 ──

  const onDividerStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = panelHeight;
      dividerRef.current?.classList.add('ft-dragging');
      dividerRef.current?.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dy = startY - ev.clientY;
        const parentH = panelRef.current?.parentElement?.clientHeight || 500;
        const newH = Math.max(60, Math.min(parentH * 0.8, startH + dy));
        setPanelHeight(newH);
        panelHeightRatio.current = newH / Math.max(1, parentH);
        onLayoutChange();
      };
      const onUp = () => {
        dividerRef.current?.classList.remove('ft-dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [panelHeight, onLayoutChange],
  );

  // ── 列宽调整 ──

  const onColResizerStart = useCallback((e: React.PointerEvent, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidths = [...colWidths.current];
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const columnsEl = panelRef.current?.querySelector('.ft-columns') as HTMLElement;
      if (!columnsEl) return;
      const totalW = columnsEl.clientWidth;
      if (totalW === 0) return;
      const dFrac = (ev.clientX - startX) / totalW;
      const leftMin = 0.12,
        rightMin = 0.12;
      let newLeft = startWidths[colIdx] + dFrac;
      let newRight = startWidths[colIdx + 1] - dFrac;
      if (newLeft < leftMin) {
        newLeft = leftMin;
        newRight = 1 - leftMin - colWidths.current[2];
      }
      if (newRight < rightMin) {
        newRight = rightMin;
        newLeft = 1 - rightMin - colWidths.current[0];
      }
      const thirdIdx = 3 - colIdx - (colIdx + 1);
      colWidths.current[colIdx] = newLeft;
      colWidths.current[colIdx + 1] = newRight;
      colWidths.current[thirdIdx] = Math.max(0.1, 1 - newLeft - newRight);
      const sum = colWidths.current.reduce((a, b) => a + b, 0);
      colWidths.current = colWidths.current.map((w) => w / sum);
      columnsEl.querySelectorAll<HTMLElement>('.ft-col').forEach((col, j) => {
        col.style.flex = String(colWidths.current[j]);
      });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []);

  // ── 计算头部文本 ──

  const cacheLabel = cacheHit && translatedAt ? `缓存命中 · ${relativeTime(translatedAt)} 前` : '新翻译 · 刚刚';
  const issueParts: string[] = [];
  if (issueStats.bug > 0) issueParts.push(`${issueStats.bug} 致命`);
  if (issueStats.risk > 0) issueParts.push(`${issueStats.risk} 风险`);
  if (issueStats.smell > 0) issueParts.push(`${issueStats.smell} 坏味道`);
  const issueLabel = issueParts.length > 0 ? issueParts.join(' ') : '未发现问题 ✅';

  const headerTitle =
    mode === 'error'
      ? `🔮 翻译器 · ${fileName} · 翻译失败`
      : mode === 'loading'
        ? `🔮 翻译器 · ${fileName} · 正在翻译…`
        : `🔮 翻译器 · ${fileName}`;

  const { codeHtml, humanHtml, auditHtml } =
    mode === 'content' ? renderColumnsHtml(lines) : { codeHtml: '', humanHtml: '', auditHtml: '' };

  return (
    <>
      {/* 分隔条 */}
      <div ref={dividerRef} className="ft-divider" onPointerDown={onDividerStart} />

      {/* 面板 */}
      <div ref={panelRef} className="ft-panel ft-open" style={{ height: panelHeight }}>
        {/* 头部 */}
        <div className="ft-header">
          <span className="ft-title">{headerTitle}</span>
          <span className="ft-meta">{mode === 'content' ? `${cacheLabel} · ${issueLabel}` : ''}</span>
          <button
            className="ft-close-btn"
            title="关闭翻译面板"
            onClick={onClose}
            dangerouslySetInnerHTML={{ __html: iconHtml('close', 12) }}
          />
        </div>

        {/* 加载中 */}
        {mode === 'loading' && (
          <div className="ft-loading">
            <div className="ft-loading-icon" dangerouslySetInnerHTML={{ __html: iconHtml('translate', 32) }} />
            <div className="ft-loading-text">正在翻译 {lineCount} 行代码…</div>
            <div className="ft-loading-wait">{waitSeconds > 0 ? `已等待 ${Math.min(waitSeconds, 60)}s…` : ''}</div>
          </div>
        )}

        {/* 错误 */}
        {mode === 'error' && (
          <div className="ft-error">
            <div className="ft-error-icon">⚠️</div>
            <div className="ft-error-text">{errorMsg}</div>
          </div>
        )}

        {/* 三列内容 */}
        {mode === 'content' && (
          <div className="ft-columns">
            <div className="ft-col" style={{ flex: colWidths.current[0] }}>
              <div className="ft-col-header ft-code-hdr">📄 原始代码</div>
              <div
                className="ft-col-body"
                data-col="0"
                ref={(el) => {
                  colBodiesRef.current[0] = el;
                }}
                dangerouslySetInnerHTML={{ __html: codeHtml }}
              />
            </div>
            <div className="ft-col-resizer" onPointerDown={(e) => onColResizerStart(e, 0)} />
            <div className="ft-col" style={{ flex: colWidths.current[1] }}>
              <div className="ft-col-header ft-human-hdr">💬 人话视图</div>
              <div
                className="ft-col-body"
                data-col="1"
                ref={(el) => {
                  colBodiesRef.current[1] = el;
                }}
                dangerouslySetInnerHTML={{ __html: humanHtml }}
              />
            </div>
            <div className="ft-col-resizer" onPointerDown={(e) => onColResizerStart(e, 1)} />
            <div className="ft-col" style={{ flex: colWidths.current[2] }}>
              <div className="ft-col-header ft-audit-hdr">🔍 审计</div>
              <div
                className="ft-col-body"
                data-col="2"
                ref={(el) => {
                  colBodiesRef.current[2] = el;
                }}
                dangerouslySetInnerHTML={{ __html: auditHtml }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
};
