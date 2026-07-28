// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ConstraintsPanel — React rewrite of constraints.ts.
// Edit hologram.constraints.yaml with a GUI form.

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../bridge';
import { askAgent } from '../agent-visualizer';
import { useDockStore } from '../dock-store';
import { iconHtml } from '../icons';

interface ConstraintsData {
  routing: Record<string, boolean>;
  thresholds: Record<string, number>;
  allowlist: { modules: string[]; files: string[] };
  denylist: { keywords: string[] };
}

// ── YAML helpers (pure functions) ──

function parseYamlSimple(yaml: string): ConstraintsData {
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

    if (trimmed === 'routing:') {
      section = 'routing';
      continue;
    }
    if (trimmed === 'thresholds:') {
      section = 'thresholds';
      continue;
    }
    if (trimmed === 'allowlist:') {
      section = 'allowlist';
      continue;
    }
    if (trimmed === 'denylist:') {
      section = 'denylist';
      continue;
    }

    if (section === 'routing') {
      const m = trimmed.match(/^(\w+):\s*(true|false)/);
      if (m) result.routing[m[1]] = m[2] === 'true';
    } else if (section === 'thresholds') {
      const m = trimmed.match(/^(\w+):\s*(\d+)/);
      if (m) result.thresholds[m[1]] = parseInt(m[2], 10);
    } else if (section === 'allowlist') {
      if (trimmed === 'modules:') {
        subSection = 'modules';
        continue;
      }
      if (trimmed === 'files:') {
        subSection = 'files';
        continue;
      }
      const m = trimmed.match(/^-\s*"([^"]+)"/);
      if (m && subSection === 'modules') result.allowlist.modules.push(m[1]);
      if (m && subSection === 'files') result.allowlist.files.push(m[1]);
    } else if (section === 'denylist') {
      if (trimmed === 'keywords:') {
        subSection = 'keywords';
        continue;
      }
      const m = trimmed.match(/^-\s*"([^"]+)"/);
      if (m) result.denylist.keywords.push(m[1]);
    }
  }

  return result;
}

function dataToYaml(data: ConstraintsData): string {
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

const ROUTING_LABELS: Record<string, string> = {
  l5_irreversible: 'L5 不可逆破坏（永远路由）',
  l4_silent: 'L4 静默破坏',
  l3_delayed: 'L3 延迟破坏',
  l2_blast: 'L2 波及破坏',
  l1_visible: 'L1 可见破坏',
};

const THRESHOLD_LABELS: Record<string, string> = {
  blast_radius_max: '波及节点上限',
  cross_community_tolerance: '跨社区边容忍',
  api_signature_tolerance: 'API 签名变更容忍',
  l4_penetration_tolerance: 'L4 封装穿透容忍',
  l4_threshold_change_tolerance: '数值阈值变更容忍',
};

// ── Component ──

const ConstraintsPanelApp: React.FC<{
  projectPath: string | null;
  visible: boolean;
  onClose: () => void;
}> = ({ projectPath, visible, onClose }) => {
  const [data, setData] = useState<ConstraintsData | null>(null);
  const [rawYaml, setRawYaml] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<'ok' | 'err' | ''>('');
  const [error, setError] = useState('');
  const [addValues, setAddValues] = useState<Record<string, string>>({});
  const loadedPath = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load constraints when path changes（旧版每次 open 都重挂载重载 — 关闭即令缓存失效复现之）
  useEffect(() => {
    if (!visible) {
      loadedPath.current = null;
      return;
    }
    if (!projectPath || projectPath === loadedPath.current) return;
    loadedPath.current = projectPath;
    setError('');
    setDirty(false);
    rpc<string>('read_constraints', { projectPath })
      .then((yaml) => {
        setRawYaml(yaml);
        setData(parseYamlSimple(yaml));
      })
      .catch((err) => {
        console.error('Failed to load constraints:', err);
        setError('加载约束配置失败');
      });
  }, [visible, projectPath]);

  const markDirty = useCallback(() => setDirty(true), []);

  // ── Handlers ──

  const handleRoutingToggle = useCallback(
    (key: string) => {
      setData((prev) => {
        if (!prev) return prev;
        return { ...prev, routing: { ...prev.routing, [key]: !prev.routing[key] } };
      });
      markDirty();
    },
    [markDirty],
  );

  const handleThresholdChange = useCallback(
    (key: string, value: number) => {
      setData((prev) => {
        if (!prev) return prev;
        return { ...prev, thresholds: { ...prev.thresholds, [key]: value } };
      });
      markDirty();
    },
    [markDirty],
  );

  const handleAddItem = useCallback(
    (listKey: string) => {
      const val = (addValues[listKey] || '').trim();
      if (!val || !data) return;
      setData((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev);
        const entry = getListEntry(next, listKey);
        if (entry && !entry.includes(val)) {
          entry.push(val);
        }
        return next;
      });
      setAddValues((prev) => ({ ...prev, [listKey]: '' }));
      markDirty();
    },
    [addValues, data, markDirty],
  );

  const handleRemoveItem = useCallback(
    (listKey: string, value: string) => {
      setData((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev);
        const entry = getListEntry(next, listKey);
        if (entry) {
          const idx = entry.indexOf(value);
          if (idx >= 0) entry.splice(idx, 1);
        }
        return next;
      });
      markDirty();
    },
    [markDirty],
  );

  const handleSave = useCallback(async () => {
    if (!projectPath || !data || saving) return;
    setSaving(true);
    const yaml = dataToYaml(data);
    try {
      await rpc('write_constraints', { projectPath, content: yaml });
      setRawYaml(yaml);
      setDirty(false);
      setSaveFeedback('ok');
    } catch (err) {
      console.error('Failed to save constraints:', err);
      setSaveFeedback('err');
    } finally {
      setSaving(false);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveFeedback(''), 1500);
    }
  }, [projectPath, data, saving]);

  const handleReset = useCallback(() => {
    if (rawYaml) {
      setData(parseYamlSimple(rawYaml));
      setDirty(false);
    }
  }, [rawYaml]);

  const handleAskAgent = useCallback(() => {
    const routingSummary = data?.routing
      ? Object.entries(data.routing)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ')
      : '未知';
    askAgent(`解释当前项目的约束配置。启用的路由: ${routingSummary}。这些约束规则的作用是什么？有没有可以优化的地方？`);
  }, [data]);

  const handleClose = useCallback(() => {
    if (dirty && !confirm('约束配置有未保存的修改，确定关闭？')) return;
    onClose();
  }, [dirty, onClose]);

  // ── Render helpers ──

  const renderTagList = (listKey: string, items: string[], placeholder: string) => (
    <div>
      <div className="cs-tag-list">
        {items.map((item) => (
          <span key={item} className="cs-tag">
            {item}
            <button
              className="cs-tag-rm"
              onClick={() => handleRemoveItem(listKey, item)}
              dangerouslySetInnerHTML={{ __html: iconHtml('close', 8) }}
            />
          </span>
        ))}
      </div>
      <div className="cs-add-row">
        <input
          className="cs-add-input"
          placeholder={placeholder}
          value={addValues[listKey] || ''}
          onChange={(e) => setAddValues((prev) => ({ ...prev, [listKey]: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && handleAddItem(listKey)}
        />
        <button
          className="cs-add-btn"
          onClick={() => handleAddItem(listKey)}
          dangerouslySetInnerHTML={{ __html: iconHtml('plus', 10) }}
        />
      </div>
    </div>
  );

  // ── Error / Loading ──

  if (error) {
    return <div style={{ color: '#e05555', fontSize: 'calc(12px * var(--font-scale))', padding: 12 }}>{error}</div>;
  }

  if (!data) {
    return (
      <div style={{ color: 'var(--obs-text-2)', fontSize: 'calc(12px * var(--font-scale))', padding: 12 }}>加载中…</div>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="cs-header">
        <span
          className="cs-header-title"
          dangerouslySetInnerHTML={{ __html: `${iconHtml('constraints', 12)} <span class="zh">约束</span>CONSTRAINTS` }}
        />
        <div className="cs-header-actions">
          <button
            className="cs-ask-btn"
            title="问 Agent 关于当前约束配置"
            onClick={handleAskAgent}
            dangerouslySetInnerHTML={{ __html: iconHtml('agent', 12) }}
          />
          <button
            className="cs-close-btn"
            onClick={handleClose}
            dangerouslySetInnerHTML={{ __html: iconHtml('close', 14) }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="cs-content-wrap">
        {/* ── Routing ── */}
        <div className="cs-section">
          <div
            className="cs-section-title"
            dangerouslySetInnerHTML={{ __html: `${iconHtml('route', 10)} 路由开关` }}
          />
          {Object.entries(ROUTING_LABELS).map(([key, label]) => (
            <label key={key} className="cs-toggle">
              <span className="cs-toggle-label">{label}</span>
              <input
                type="checkbox"
                checked={data.routing[key] || false}
                disabled={key === 'l5_irreversible'}
                onChange={() => handleRoutingToggle(key)}
              />
              <span className="cs-toggle-slider" />
            </label>
          ))}
        </div>

        {/* ── Thresholds ── */}
        <div className="cs-section">
          <div
            className="cs-section-title"
            dangerouslySetInnerHTML={{ __html: `${iconHtml('threshold', 10)} 阈值` }}
          />
          {Object.entries(THRESHOLD_LABELS).map(([key, label]) => (
            <div key={key} className="cs-field">
              <label className="cs-field-label">{label}</label>
              <input
                type="number"
                className="cs-field-input"
                value={data.thresholds[key] ?? 0}
                min={0}
                max={1000}
                onChange={(e) => {
                  let val = parseInt(e.target.value, 10);
                  if (Number.isNaN(val) || val < 0) val = 0;
                  if (val > 10000) val = 10000;
                  handleThresholdChange(key, val);
                }}
              />
            </div>
          ))}
        </div>

        {/* ── Allowlist ── */}
        <div className="cs-section">
          <div
            className="cs-section-title"
            dangerouslySetInnerHTML={{ __html: `${iconHtml('check-circle', 10)} 白名单` }}
          />
          <div className="cs-sub-title">模块（L4 穿透不触发路由）</div>
          {renderTagList('allow-modules', data.allowlist.modules, '添加模块…')}
          <div className="cs-sub-title">文件（不触发 L3 延迟路由）</div>
          {renderTagList('allow-files', data.allowlist.files, '添加文件模式…')}
        </div>

        {/* ── Denylist ── */}
        <div className="cs-section">
          <div
            className="cs-section-title"
            dangerouslySetInnerHTML={{ __html: `${iconHtml('block', 10)} 黑名单关键词` }}
          />
          {renderTagList('deny-keywords', data.denylist.keywords, '添加关键词…')}
        </div>

        {/* ── Actions ── */}
        <div className="cs-actions">
          <button
            className="cs-btn cs-btn-save"
            style={
              saveFeedback === 'ok'
                ? { color: 'var(--obs-pass, #55aa55)' }
                : saveFeedback === 'err'
                  ? { color: 'var(--error, #e05555)' }
                  : {}
            }
            onClick={handleSave}
            disabled={saving}
            dangerouslySetInnerHTML={{
              __html: saveFeedback === 'ok' ? `${iconHtml('check-circle', 11)} 已保存` : `${iconHtml('save', 10)} 保存`,
            }}
          />
          <button
            className="cs-btn cs-btn-reset"
            onClick={handleReset}
            disabled={!dirty}
            dangerouslySetInnerHTML={{ __html: `${iconHtml('reset', 10)} 重置` }}
          />
        </div>
      </div>
    </>
  );
};

// ── Helpers ──

function getListEntry(data: ConstraintsData, key: string): string[] | null {
  switch (key) {
    case 'allow-modules':
      return data.allowlist.modules;
    case 'allow-files':
      return data.allowlist.files;
    case 'deny-keywords':
      return data.denylist.keywords;
    default:
      return null;
  }
}

// ── Panel root（P3：直接挂 DockPanel 树，Controller 包装已删）──
// 内联样式与旧 Controller 完全一致（position:absolute 覆盖样式表的 fixed，保持原样）。

export function ConstraintsPanel() {
  const open = useDockStore((s) => s.open.constraints);
  const projectPath = useDockStore((s) => s.projectPath);
  const closePanel = useDockStore((s) => s.closePanel);

  return (
    <div
      id="constraints-panel"
      className={open ? 'cs-open' : ''}
    >
      <ConstraintsPanelApp projectPath={projectPath} visible={open} onClose={() => closePanel('constraints')} />
    </div>
  );
}
