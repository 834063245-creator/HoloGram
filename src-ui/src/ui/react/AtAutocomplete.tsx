// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AtAutocomplete — React 重写 @ 文件/节点自动补全
// 替代 chat.ts 中 handleAtInput / buildAtPopup / updateAtSelection / confirmAtSelection。
// 零 innerHTML、零 querySelector、零手动 class 切换。

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useShellStore } from '../../app/shell-store';
import { typedRpc } from '../../rpc-contract';
import { getChatStore } from '../chat-store';

// ── 类型 ──

interface AtItem {
  kind: string;
  name: string;
}

// ── 辅助函数：从文本中解析 @ 触发位置 ──

function findAtTrigger(textBefore: string): number {
  for (let i = textBefore.length - 1; i >= 0; i--) {
    if (textBefore[i] === '@' && (i === 0 || textBefore[i - 1] === ' ' || textBefore[i - 1] === '\n')) {
      return i;
    }
  }
  return -1;
}

function buildToken(kind: string, name: string): string {
  if (kind === '节点') {
    return `\`${name}\``;
  }
  const base =
    name
      .split('/')
      .pop()
      ?.replace(/\.\w+$/, '') || name;
  return `[@${base}](${name})`;
}

// ── 暴露的命令式 API（core 注册接口签名不变）──
// P2′-2b：navigate/select/open 重写为状态驱动（旧版是 DOM-scraping hack）。
// 句柄只创建一次（core 挂载时注册）；命令式读取一律走 ref 镜像，避免陈旧闭包。

export interface AtAutocompleteHandle {
  /** 每次输入事件调用。textBefore = value.slice(0, cursorPos) */
  update(textBefore: string, cursorPos: number): void;
  /** 更新可用节点名（来自 starGraph） */
  setNodeNames(names: string[]): void;
  /** 键盘上下导航 — 输入框 keydown 转发 */
  navigate(delta: number): void;
  /** 选中当前高亮项 */
  select(): void;
  /** 弹层是否有可选项（非加载/空态） */
  readonly open: boolean;
}

// ── React 组件 ──

const CACHE_TTL = 30000;

export const AtAutocomplete = forwardRef<
  AtAutocompleteHandle,
  { panelId: string; onSelect: (atIdx: number, token: string) => void }
>(function AtAutocomplete({ panelId, onSelect }, ref) {
  const [textBefore, setTextBefore] = useState('');
  const [nodeNames, setNodeNames] = useState<string[]>([]);
  const [items, setItems] = useState<AtItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<{ data: string; ts: number; path: string } | null>(null);

  const atPos = findAtTrigger(textBefore);
  const query = atPos >= 0 ? textBefore.slice(atPos + 1).toLowerCase() : '';
  const visible = atPos >= 0;

  // 命令式句柄的实时数据镜像（每次渲染后同步）
  const itemsRef = useRef<AtItem[]>([]);
  const activeIdxRef = useRef(0);
  const atPosRef = useRef(-1);
  const visibleRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    itemsRef.current = items;
    activeIdxRef.current = activeIdx;
    atPosRef.current = atPos;
    visibleRef.current = visible;
    onSelectRef.current = onSelect;
  });

  // 可见时获取文件列表
  useEffect(() => {
    if (!visible) {
      setItems([]);
      return;
    }
    let cancelled = false;

    (async () => {
      setLoading(true);
      let files: string[] = [];

      // 使用缓存的 glob 结果
      try {
        let cache = cacheRef.current;
        const projectPath = useShellStore.getState().projectPath || '.';
        if (!cache || Date.now() - cache.ts > CACHE_TTL || cache.path !== projectPath) {
          const data = await typedRpc('glob', {
            pattern: '**/*.{ts,js,py,rs,html,css,vue,svelte,json,toml,yaml,yml,md}',
            path: projectPath,
          });
          cache = { data, ts: Date.now(), path: projectPath };
          cacheRef.current = cache;
        }

        const parsed = JSON.parse(cache.data) as { results?: Array<{ path: string }> };
        files = (parsed.results || []).map((r) => r.path).slice(0, 100);
      } catch {
        /* glob 失败 — 使用空数组 */
      }

      if (cancelled) return;

      const allItems: AtItem[] = [];
      for (const f of files) {
        allItems.push({ kind: '文件', name: f });
      }
      for (const n of nodeNames) {
        allItems.push({ kind: '节点', name: n });
      }

      const filtered = query ? allItems.filter((item) => item.name.toLowerCase().includes(query)) : allItems;
      setItems(filtered.slice(0, 10));
      setActiveIdx(0);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, query, panelId, nodeNames]);

  // 将活动项滚动到可见区域
  useEffect(() => {
    const el = popupRef.current?.querySelector('.at-item.active') as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  const applySelect = useCallback((item: AtItem) => {
    onSelectRef.current(atPosRef.current, buildToken(item.kind, item.name));
    // 选中即关弹层（清空 textBefore → atPos=-1；旧版选择后弹层滞留，紧接 Enter 会误选第二次）
    setTextBefore('');
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      update: (tb) => setTextBefore(tb),
      setNodeNames: (names) => setNodeNames(names),
      navigate: (delta) => {
        const len = itemsRef.current.length;
        if (len === 0) return;
        setActiveIdx((idx) => Math.max(0, Math.min(idx + delta, len - 1)));
      },
      select: () => {
        if (!visibleRef.current) return;
        const item = itemsRef.current[activeIdxRef.current];
        if (item) applySelect(item);
      },
      get open() {
        return visibleRef.current && itemsRef.current.length > 0;
      },
    }),
    [applySelect],
  );

  if (!visible || (items.length === 0 && !loading)) return null;

  return (
    <div ref={popupRef} className={`chat-at-popup${visible && (items.length > 0 || loading) ? ' open' : ''}`}>
      {loading && items.length === 0 ? (
        <div className="at-loading" style={{ opacity: 0.4 }}>
          加载中…
        </div>
      ) : items.length === 0 ? (
        <div className="at-empty" style={{ opacity: 0.4 }}>
          无匹配结果
        </div>
      ) : (
        items.map((item, i) => (
          <div
            key={`${item.kind}:${item.name}`}
            className={`at-item${i === activeIdx ? ' active' : ''}`}
            onMouseEnter={() => setActiveIdx(i)}
            onClick={() => applySelect(item)}
          >
            <span className="at-kind">{item.kind}</span>
            <span>{item.name}</span>
          </div>
        ))
      )}
    </div>
  );
});
