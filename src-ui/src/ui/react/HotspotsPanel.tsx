// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HotspotsPanel — React rewrite of hotspots.ts.
// Shows recurring L4 violation hotspots on the star graph.

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../bridge';
import { askAgent } from '../agent-visualizer';
import { shell } from '../app-shell';
import { getDockStarGraph } from '../dock-config';
import { useDockStore } from '../dock-store';
import { iconHtml } from '../icons';
import { basename } from './helpers';

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

// ── Component（P3：直接挂 DockPanel 树，Controller 包装已删）──
// 开合状态走 dock-store；starGraph 经 dock-config 注入槽读取（非 props）。
// 旧版 open 重挂载重新拉取 / close 卸载清高亮 — 用 effect 复现同等语义。

export function HotspotsPanel() {
  const open = useDockStore((s) => s.open.hotspots);
  const path = useDockStore((s) => s.projectPath);
  const closePanel = useDockStore((s) => s.closePanel);
  const [hotspots, setHotspots] = useState<HotspotItem[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedPath = useRef<string | null>(null);

  // 打开时拉取（每次打开都重新拉）；关闭时复位（对齐旧卸载行为）
  useEffect(() => {
    if (!open) {
      loadedPath.current = null;
      setHotspots([]);
      return;
    }
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
  }, [open, path]);

  // 图高亮联动（仅开启期间；关闭/列表变化时清理）
  useEffect(() => {
    const sg = getDockStarGraph();
    if (open && hotspots.length > 0) sg?.highlightHotspots(hotspots);
    return () => {
      sg?.clearHotspots();
    };
  }, [open, hotspots]);

  const handleItemClick = useCallback(
    (file: string) => {
      shell.navigateToFile(file);
      getDockStarGraph()?.highlightHotspots(hotspots);
    },
    [hotspots],
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
    <div id="hotspots-panel" className={open ? 'hs-open' : ''}>
      <div className="corner-brackets">
        <span className="cb-bottom left" />
        <span className="cb-bottom right" />
      </div>
      <div className="hs-header-row">
        <span className="hs-title">复发热点</span>
        <button className="tl-close" title="收起" onClick={() => closePanel('hotspots')}>
          &#x2715;
        </button>
      </div>
      <div className="hs-content">
        {loading ? (
          <div className="hs-empty">加载中…</div>
        ) : hotspots.length === 0 ? (
          <div className="hs-empty">暂无复发热点。项目运行一段时间后，同一文件多次触发 L4 警报时会出现在这里。</div>
        ) : (
          hotspots.map((hs) => {
            const fn = basename(hs.file);
            const sevClass = SEVERITY_CLASS[hs.last_details.level] || 'hs-sev-mid';
            const desc = hs.last_details.description
              ? hs.last_details.description.length > 60
                ? hs.last_details.description.slice(0, 60) + '…'
                : hs.last_details.description
              : '';
            const line = hs.last_details.line ? `:${hs.last_details.line}` : '';
            const lastTs = hs.recent_timestamps[0] ? fmtTime(hs.recent_timestamps[0]) : '';
            const countClass = hs.count >= 5 ? 'hs-count-critical' : hs.count >= 3 ? 'hs-count-warn' : '';

            return (
              <div key={hs.file} className="hs-item" onClick={() => handleItemClick(hs.file)}>
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
    </div>
  );
}
