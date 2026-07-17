// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HotspotsPanel — React rewrite of hotspots.ts.
// Shows recurring L4 violation hotspots on the star graph.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../bridge';
import { askAgent } from '../agent-visualizer';
import { shell } from '../app-shell';
import type { StarGraph } from '../graph';
import { iconHtml } from '../icons';

interface HotspotItem {
  file: string;
  count: number;
  last_details: {
    description: string;
    level: number;
    line: number;
    timestamp: string;
  };
  recent_timestamps: string[];
}

interface HotspotsData {
  hotspots: HotspotItem[];
  total_check_events: number;
  days: number;
  min_count: number;
}

const SEVERITY_CLASS: Record<number, string> = {
  2: 'hs-sev-low',
  3: 'hs-sev-mid',
  4: 'hs-sev-high',
  5: 'hs-sev-critical',
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso.slice(0, 16);
  }
}

// ── Component ──

const HotspotsPanelApp: React.FC<{
  path: string | null;
  starGraph: StarGraph | null;
  onClose: () => void;
}> = ({ path, starGraph, onClose }) => {
  const [hotspots, setHotspots] = useState<HotspotItem[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedPath = useRef<string | null>(null);

  // Auto-refresh when path changes
  useEffect(() => {
    if (!path || path === loadedPath.current) return;
    loadedPath.current = path;
    setLoading(true);
    rpc<string>('hologram_hotspots', { days: 30, min_count: 2 })
      .then((json) => {
        const data = JSON.parse(json) as HotspotsData;
        setHotspots(data.hotspots || []);
      })
      .catch((err) => {
        console.error('Hotspots refresh failed:', err);
      })
      .finally(() => setLoading(false));
  }, [path]);

  // Highlight on graph when hotspots change
  useEffect(() => {
    if (hotspots.length > 0) {
      starGraph?.highlightHotspots(hotspots);
    }
    return () => {
      starGraph?.clearHotspots();
    };
  }, [hotspots, starGraph]);

  const handleItemClick = useCallback(
    (file: string) => {
      shell.navigateToFile(file);
      starGraph?.highlightHotspots(hotspots);
    },
    [hotspots, starGraph],
  );

  const handleAskAgent = useCallback(
    (e: React.MouseEvent, file: string) => {
      e.stopPropagation();
      const hs = hotspots.find((h) => h.file === file);
      if (!hs) return;
      const context = [
        `复发热点: ${basename(file)}`,
        `复发次数: ${hs.count}× L4 封装穿透`,
        hs.last_details.description ? `最近描述: ${hs.last_details.description}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      askAgent(`分析这个复发热点: ${context}`);
    },
    [hotspots],
  );

  return (
    <>
      <div className="corner-brackets">
        <span className="cb-bottom left" />
        <span className="cb-bottom right" />
      </div>
      <div className="hs-header-row">
        <span className="hs-title">复发热点</span>
        <button className="tl-close" title="收起" onClick={onClose}>
          &#x2715;
        </button>
      </div>
      <div className="hs-content">
        {loading ? (
          <div className="hs-empty">加载中…</div>
        ) : hotspots.length === 0 ? (
          <div className="hs-empty">
            暂无复发热点。项目运行一段时间后，同一文件多次触发 L4 警报时会出现在这里。
          </div>
        ) : (
          hotspots.map((hs) => {
            const fn = basename(hs.file);
            const sevClass = SEVERITY_CLASS[hs.last_details.level] || 'hs-sev-mid';
            const desc = hs.last_details.description
              ? hs.last_details.description.length > 60
                ? hs.last_details.description.slice(0, 60) + '\u2026'
                : hs.last_details.description
              : '';
            const line = hs.last_details.line ? `:${hs.last_details.line}` : '';
            const lastTs = hs.recent_timestamps[0] ? fmtTime(hs.recent_timestamps[0]) : '';
            const countClass = hs.count >= 5 ? 'hs-count-critical' : hs.count >= 3 ? 'hs-count-warn' : '';

            return (
              <div
                key={hs.file}
                className="hs-item"
                onClick={() => handleItemClick(hs.file)}
              >
                <div className="hs-file-row">
                  <span className={`hs-count ${countClass}`}>{hs.count}×</span>
                  <span className="hs-file">{fn}</span>
                  <span className="hs-line">{line}</span>
                </div>
                {desc && <div className={`hs-desc ${sevClass}`}>{desc}</div>}
                {lastTs && <div className="hs-time">最近: {lastTs}</div>}
                <button
                  className="hs-ask-btn"
                  title="问 Agent 关于这个热点"
                  dangerouslySetInnerHTML={{ __html: iconHtml('agent', 10) }}
                  onClick={(e) => handleAskAgent(e, hs.file)}
                />
              </div>
            );
          })
        )}
      </div>
    </>
  );
};

// ── Controller ──

export class HotspotsPanelController {
  private _open = false;
  private _starGraph: StarGraph | null = null;
  private _path: string | null = null;
  private _container: HTMLDivElement;
  private _panel: HTMLDivElement;
  private _root: import('react-dom/client').Root | null = null;

  constructor(container: HTMLElement) {
    this._container = document.createElement('div');
    this._container.style.display = 'none';
    container.appendChild(this._container);

    this._panel = document.createElement('div');
    this._panel.id = 'hotspots-panel';
    this._container.appendChild(this._panel);
  }

  setGraph(sg: StarGraph): void {
    this._starGraph = sg;
  }

  setProjectPath(path: string | null): void {
    this._path = path;
    if (this._open) this._render();
  }

  // ── Public API ──

  toggle(): void {
    this._open ? this.close() : this.open();
  }

  open(): void {
    if (this._open) return;
    this._open = true;
    this._container.style.display = '';
    this._panel.classList.add('hs-open');
    this._render();
    import('../app-shell').then(({ shell }) => shell.notifyPanelChanged());
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this._panel.classList.remove('hs-open');
    // Delay hiding container so CSS transition can finish
    setTimeout(() => {
      if (!this._open) this._container.style.display = 'none';
    }, 200);
    this._starGraph?.clearHotspots();
    if (this._root) {
      this._root.unmount();
      this._root = null;
    }
  }

  isOpen(): boolean {
    return this._open;
  }

  getHotspots(): HotspotItem[] {
    // State lives in the React tree; controller doesn't own it.
    // Callers should use this for read-only inspection only.
    return [];
  }

  destroy(): void {
    if (this._root) this._root.unmount();
    this._container.remove();
  }

  // ── Internal ──

  private async _render(): Promise<void> {
    const { createRoot } = await import('react-dom/client');
    if (!this._root) this._root = createRoot(this._panel);
    this._root.render(
      React.createElement(HotspotsPanelApp, {
        key: Date.now(),
        path: this._path,
        starGraph: this._starGraph,
        onClose: () => this.close(),
      }),
    );
  }
}
