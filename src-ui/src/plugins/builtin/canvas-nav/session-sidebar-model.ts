// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionSidebar 数据模型（纯函数）——侧边栏行合流/排序/相对时间/状态点。
// Stage-3 DSH 范式：当前工作区会话管理 = 摊开会话（sess store）+ 未摊开
// 已存卷（listSavedSessions）两源合流；状态点 pending > running > done/idle
// （子 agent 与 running 同点——当前 exec 面暂无每会话子 agent 计数，运行中
// 即亮石青点，stage-3 §5 数据源核对）。
//
// 行的 `label` = **原样卷名**（空 = 未命名）——显示兜底是呈现层的事
// （state/volume-name 的 volumeDisplayName，按档号；禁在数据面把显示值洗成真值）。

import { volumeDisplayName } from '../../../state/volume-name';

export type SessionStatus = 'pending' | 'running' | 'done' | 'idle';

export interface SidebarRow {
  id: number;
  /** **原样**卷名（空 = 未命名）——显示走 volumeDisplayName，别直接用。 */
  label: string;
  savedAt: string;
  open: boolean;
  msgCount: number;
  /** 行状态点（组件计算后填充；纯模型保留类型供测试） */
  status: SessionStatus;
  /** **父卷号**（会话树「枝」的那条边；真源 = 卷日志头行 → 清单投影 `parentId`）。
   *  缺 = 根卷。合流时由**盘上行**供给（摊开集只有 label/块数，没有血缘）。 */
  parentId?: number;
  /** 树深（0 = 本节内的根行）——渲染缩进用，由 `treeRows` 填。 */
  depth?: number;
  /** **血缘悬空**：父卷不在场（外部删除/拷走——应用内删除必连坐，故悬空只可能来自外部）。
   *  显示「父卷已删」，**不阻塞打开**（枝卷内容自包含，plan §8）。 */
  orphan?: boolean;
  /** **直系子行数**（在场者；`treeRows`/`familyForest` 填）——枝视图右端「▾ N 枝」汇总。 */
  kids?: number;
  /** **逐层「是否末子」**（下标 = 层，0 = 本族根层；`treeRows` 填）——引线折角 `├/└` 的素材。 */
  lastAt?: boolean[];
  /** **仅作检索上下文在场**（不是命中行）：搜到子卷时把它的祖先链补进来，弱墨呈现。 */
  contextOnly?: boolean;
}

/** 两源合流：磁盘已存卷为底，摊开会话覆盖（label 取内存最新；savedAt 缺失
 *  的未落盘新卷保留空）。排序 = 摊开优先，同组按 savedAt 倒序（新者上）。
 *  血缘（`parentId`）只在盘上那一源：摊开集没有它（卷日志头行是唯一真源），
 *  故摊开行沿用其盘上行的边——未落盘的摊开卷 = 无父（新卷本就是根卷）。
 *
 *  `open[].msgCount` **可选**：内存摊开集只有 `{id, label}`（ChatSessionMeta），
 *  块数真源在盘上投影。传 `undefined` = 沿用盘上值；2026-09-21 前调用点填死 0，
 *  而 `0` 不是 nullish ⇒ 把盘上真值整个盖掉（书脊小卡「Nº 7 · 0 块」病灶）。 */
export function mergeSessionRows(
  open: Array<{ id: number; label: string; msgCount?: number }>,
  saved: Array<{ id: number; label: string; msgCount: number; savedAt: string; parentId?: number }>,
): SidebarRow[] {
  const byId = new Map<number, SidebarRow>();
  for (const s of saved) {
    byId.set(s.id, {
      id: s.id,
      label: s.label,
      savedAt: s.savedAt,
      open: false,
      msgCount: s.msgCount,
      status: 'idle',
      ...(s.parentId != null ? { parentId: s.parentId } : {}),
    });
  }
  for (const o of open) {
    const prev = byId.get(o.id);
    byId.set(o.id, {
      id: o.id,
      // 内存最新优先；缺则沿用盘上行（两者都是**原名**，空 = 未命名）
      label: o.label || prev?.label || '',
      savedAt: prev?.savedAt ?? '',
      open: true,
      msgCount: o.msgCount ?? prev?.msgCount ?? 0,
      status: 'idle',
      ...(prev?.parentId != null ? { parentId: prev.parentId } : {}),
    });
  }
  const rows = [...byId.values()];
  rows.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    const t = (b.savedAt || '').localeCompare(a.savedAt || '');
    if (t !== 0) return t;
    return b.id - a.id;
  });
  return rows;
}

/**
 * **树形排布**（会话树「枝」）：把一节的扁平行列排成父子段。
 *
 *  · 根行（无父 / 父不在本节 / 自环）= 本节既有序（合流序：新者上）不动；
 *  · 子行**紧随其父之后**（DFS，兄弟间保持既有序），`depth` 逐层 +1；
 *  · `present` = **全部**已知卷号（不只本节）——父不在场 = 血缘悬空（外部删除/
 *    拷走），标 `orphan`（显示「父卷已删」，不阻塞打开：内容自包含，plan §8）。
 *
 *  坏血缘兜底（**绝不因脏数据让行消失**）：环里的行从根走不到，末尾按根行补出；
 *  自环当根行。
 */
export function treeRows(rows: SidebarRow[], present: ReadonlySet<number>): SidebarRow[] {
  const inSection = new Set(rows.map((r) => r.id));
  const byParent = new Map<number, SidebarRow[]>();
  const roots: SidebarRow[] = [];
  for (const r of rows) {
    const pid = r.parentId;
    if (pid != null && pid !== r.id && inSection.has(pid)) {
      const bucket = byParent.get(pid);
      if (bucket) bucket.push(r);
      else byParent.set(pid, [r]);
    } else {
      roots.push(r);
    }
  }
  const out: SidebarRow[] = [];
  const seen = new Set<number>();
  const walk = (row: SidebarRow, depth: number, lastAt: boolean[]): void => {
    if (seen.has(row.id)) return; // 环守卫：坏血缘不递归，也不吞行
    seen.add(row.id);
    const kids = byParent.get(row.id) ?? [];
    out.push({
      ...row,
      depth,
      lastAt,
      kids: kids.length,
      ...(row.parentId != null && !present.has(row.parentId) ? { orphan: true } : {}),
    });
    kids.forEach((child, i) => {
      walk(child, depth + 1, [...lastAt, i === kids.length - 1]);
    });
  };
  roots.forEach((r, i) => {
    walk(r, 0, [i === roots.length - 1]);
  });
  // 环 / 父在本节但其自身不可达的行：按根行补出（顺序退化为合流序，行不丢）
  for (const r of rows) if (!seen.has(r.id)) walk(r, 0, [true]);
  return out;
}

/**
 * **族**（会话树「枝」的呈现单位）：一个根卷 + 它的整棵子树 = 一族。
 *
 *  · `families` = 有子行的族（按**族内最新 `savedAt`** 倒序——族序读作「最近动过的那一家在上」）；
 *  · `solo` = 无子行的根卷（独立卷；呈现面折成末组一行）。
 *
 *  与 `treeRows` 的分工：`treeRows` 管**节内**树形（父不在本节 ⇒ 当根行）；本函数管**跨节**建族
 *  （枝视图里族不拆——摊开/已合卷由行状态表达，不再切段）。父不在场（悬空血缘）的行自成根，
 *  其子行仍随它成族（族内在场，族根那条边是断的）。
 */
export function familyForest(rows: SidebarRow[]): {
  families: Array<{ root: SidebarRow; rows: SidebarRow[] }>;
  solo: SidebarRow[];
} {
  const ids = new Set(rows.map((r) => r.id));
  const byParent = new Map<number, SidebarRow[]>();
  const roots: SidebarRow[] = [];
  for (const r of rows) {
    const pid = r.parentId;
    if (pid != null && pid !== r.id && ids.has(pid)) {
      const bucket = byParent.get(pid);
      if (bucket) bucket.push(r);
      else byParent.set(pid, [r]);
    } else {
      roots.push(r);
    }
  }
  const families: Array<{ root: SidebarRow; rows: SidebarRow[]; latestAt: string }> = [];
  const solo: SidebarRow[] = [];
  const covered = new Set<number>();
  const buildFamily = (root: SidebarRow): void => {
    const members: SidebarRow[] = [root];
    const guard = new Set<number>([root.id]);
    covered.add(root.id);
    const collect = (id: number): void => {
      for (const child of byParent.get(id) ?? []) {
        if (guard.has(child.id)) continue; // 环守卫：坏血缘不递归（与 treeRows 同一纪律）
        guard.add(child.id);
        covered.add(child.id);
        members.push(child);
        collect(child.id);
      }
    };
    collect(root.id);
    const tree = treeRows(members, ids);
    if (tree.length <= 1) {
      solo.push(tree[0] ?? root);
      return;
    }
    const latestAt = tree.reduce((acc, r) => ((r.savedAt || '') > acc ? r.savedAt || '' : acc), '');
    families.push({ root, rows: tree, latestAt });
  };
  for (const root of roots) buildFamily(root);
  // 坏血缘（环）：从任何根都走不到的行**末尾按族根补出**——绝不吞行（与 treeRows 同一条纪律）
  for (const r of rows) if (!covered.has(r.id)) buildFamily(r);
  families.sort((a, b) => (b.latestAt || '').localeCompare(a.latestAt || ''));
  return { families: families.map(({ root, rows: famRows }) => ({ root, rows: famRows })), solo };
}

/**
 * **检索保祖先链**：命中行 + 其祖先上下文行（父不在命中集 ⇒ 补进来，标 `contextOnly`）。
 *
 *  病根（2026-09-20 走查）：旧实现先 `filterRows` 再建树 ⇒ 搜子卷名时父卷被滤掉，
 *  子卷当根行、血缘不可见；搜父卷名时子卷不出现（「这一枝都有谁」搜不到）。
 *  祖先按**根→父**顺序插在首个命中的后代行之前；同一祖先只补一次（幂等）。
 */
export function withAncestorContext(hits: SidebarRow[], all: SidebarRow[]): SidebarRow[] {
  const byId = new Map(all.map((r) => [r.id, r]));
  const hitIds = new Set(hits.map((r) => r.id));
  const emitted = new Set<number>();
  const out: SidebarRow[] = [];
  for (const hit of hits) {
    const chain: SidebarRow[] = [];
    const seen = new Set<number>([hit.id]);
    let cur = hit.parentId != null ? byId.get(hit.parentId) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
    }
    for (const anc of chain) {
      if (hitIds.has(anc.id) || emitted.has(anc.id)) continue;
      emitted.add(anc.id);
      out.push({ ...anc, contextOnly: true });
    }
    out.push(hit);
  }
  return out;
}

/**
 * **血缘悬空标记**（案卷视图用）：父卷不在场（外部删除/拷走）⇒ 标 `orphan`。
 *
 *  树面（枝视图）由 `treeRows` 顺带标记；案卷视图不建树，但同样需要那枚「父卷已删」
 *  ——同一条判据（父卷号在场集里查不到），两处不许各写一份。
 */
export function markOrphans(rows: SidebarRow[], present: ReadonlySet<number>): SidebarRow[] {
  return rows.map((r) => (r.parentId != null && !present.has(r.parentId) ? { ...r, orphan: true } : r));
}

/** 相对时间（DSH 行副信息）：刚刚 / N 分钟前 / N 小时前 / N 天前；缺省 '—'。 */
export function relativeTime(iso: string, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffMs = now - t;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString();
}

/** 状态点文案（title/aria 用）。 */
export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'pending':
      return '等待交互';
    case 'running':
      return '运行中';
    case 'done':
      return '已完成';
    case 'idle':
      return '空闲';
  }
}

/** 检索过滤（注疏重排 2026-08-31）：query 空 = 全量；匹配卷名（大小写
 *  无关）或卷号数字——未命名卷的显示名「案卷 N」天然可被命中。 */
export function filterRows(rows: SidebarRow[], query: string): SidebarRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => volumeDisplayName(r.label, r.id).toLowerCase().includes(q) || String(r.id).includes(q));
}

/** 分节：摊开中（OPEN）在前、已合卷（CLOSED）在后——节内保持合流排序
 *  （新者上），不再做摊开优先的扁平混排。 */
export function splitSections(rows: SidebarRow[]): { open: SidebarRow[]; closed: SidebarRow[] } {
  return {
    open: rows.filter((r) => r.open),
    closed: rows.filter((r) => !r.open),
  };
}

/** 已合卷时间桶（2026-09-02 UX 批）：大卷量下的可扫性分桶。 */
export type ClosedBucket = 'today' | 'week' | 'earlier';

/** 判桶：同本地日历日 = 今天；7 天内 = week；更早。savedAt 缺省/坏值归
 *  更早桶（防御位——合卷行来自磁盘必有 savedAt，理论上走不到）。 */
export function closedBucket(savedAt: string, now = Date.now()): ClosedBucket {
  const t = new Date(savedAt).getTime();
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    const n = new Date(now);
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
      return 'today';
    }
    if (now - t < 7 * 24 * 3600_000) return 'week';
  }
  return 'earlier';
}

/** 桶中文标签（节头文案单一真源；机读码另由消费面拼）。 */
export const CLOSED_BUCKET_LABEL: Record<ClosedBucket, string> = {
  today: '今天',
  week: '7 天内',
  earlier: '更早',
};

/** 已合卷分桶：桶序固定（今天 → 7 天内 → 更早），空桶不出场；
 *  返回长度 ≤1 时消费面不立桶头（单桶立头是噪音）。 */
export function bucketClosed(
  closed: SidebarRow[],
  now = Date.now(),
): Array<{ bucket: ClosedBucket; rows: SidebarRow[] }> {
  const by: Record<ClosedBucket, SidebarRow[]> = { today: [], week: [], earlier: [] };
  for (const r of closed) by[closedBucket(r.savedAt, now)].push(r);
  const out: Array<{ bucket: ClosedBucket; rows: SidebarRow[] }> = [];
  for (const b of ['today', 'week', 'earlier'] as const) {
    if (by[b].length > 0) out.push({ bucket: b, rows: by[b] });
  }
  return out;
}

/** 行机读注记（注疏版式第二行）：N 块 · 相对时间；未落盘新卷
 *  （无 savedAt）出「未存」段——显式标记比缺段诚实（自动存失败可据此发现）。
 *  血缘悬空（`orphan`）追加「父卷已删」——外部删除/拷走才可能，不阻塞打开。
 *
 *  **不报卷号**（2026-09-21 卷号收显示）：号就在紧邻的卷名里——未命名卷的名本身
 *  即「案卷 N」（state/volume-name 的档号兜底），同一行再报一次是同义反复。
 *  常显的号只留两处：书脊档号 `.sr-num`（题名两栏截断后唯一可靠的身份）与卷首
 *  眉行（恰出现一次口径）。设计件：docs/archive/session-line/volume-number-governance-plan.md §2。 */
export function sessionMeta(r: Pick<SidebarRow, 'msgCount' | 'savedAt' | 'orphan'>, now = Date.now()): string {
  const parts = [`${r.msgCount} 块`];
  if (r.savedAt) parts.push(relativeTime(r.savedAt, now));
  else parts.push('未存');
  if (r.orphan) parts.push('父卷已删');
  return parts.join(' · ');
}
