// Graph Interaction — Step 3: 图作为 Agent 输入设备
// 订阅图交互事件 (graph:node-clicked / graph:path-selected / graph:region-selected)
// 自动生成 Agent 查询并发送到聊天面板。
// 不改 Agent 循环，不改 Python 引擎。纯增量。

import { bus } from './events';
import { dbg } from './debug';

interface NodeInfo { name: string; id: string; type: string; }

interface NodeClickedData {
  nodeName: string;
  nodeType: string;
  nodeId: string;
  degree: number;
  location: string;
}

interface PathSelectedData {
  from: NodeInfo;
  to: NodeInfo;
  pathLength: number;
  pathNames: string[];
}

interface RegionSelectedData {
  nodeNames: string[];
  nodeCount: number;
}

export class GraphInteraction {
  constructor() {
    bus.on('graph:node-clicked', this._onNodeClicked.bind(this));
    bus.on('graph:path-selected', this._onPathSelected.bind(this));
    bus.on('graph:region-selected', this._onRegionSelected.bind(this));
  }

  // ── Node clicked → informational, detail card handles the "ask agent" button ──

  private _onNodeClicked(data: NodeClickedData): void {
    dbg('graph-interaction', `node-clicked: "${data.nodeName}" (${data.nodeType})`);
    // The existing detail card already provides a "问 Agent" button.
    // This event is for future extensions (e.g. quick-action chips, analytics).
  }

  // ── Path selected (Shift+click two nodes) → auto-query agent about the dependency chain ──

  private _onPathSelected(data: PathSelectedData): void {
    const pathStr = data.pathNames.length > 0
      ? data.pathNames.join(' → ')
      : `${data.from.name} → ${data.to.name}`;
    const question = [
      `分析从 \`${data.from.name}\` 到 \`${data.to.name}\` 的依赖路径。`,
      ``,
      `路径包含 ${data.pathLength} 个节点：${pathStr}`,
      ``,
      `请分析：`,
      `1. 这条依赖链的架构合理性（是否存在不必要的跨层依赖？）`,
      `2. 路径上的风险点（哪些节点是关键枢纽？耦合深度如何？）`,
      `3. 如果修改 \`${data.from.name}\`，对 \`${data.to.name}\` 的影响范围`,
    ].join('\n');
    dbg('graph-interaction', `path-selected: "${data.from.name}" → "${data.to.name}" (${data.pathLength} nodes)`);
    bus.emit('agent:query', question);
  }

  // ── Region selected (Alt+drag box select) → auto-summarize the selected modules ──

  private _onRegionSelected(data: RegionSelectedData): void {
    const maxShow = 12;
    const shown = data.nodeNames.slice(0, maxShow);
    const more = data.nodeCount > maxShow ? `...等共 ${data.nodeCount} 个` : '';
    const nameList = shown.map(n => `\`${n}\``).join(', ') + more;
    const question = [
      `我框选了图中的 ${data.nodeCount} 个节点：${nameList}`,
      ``,
      `请分析：`,
      `1. 这些模块之间的关系和整体架构特征`,
      `2. 是否有循环依赖或深度耦合？`,
      `3. 哪些是关键节点（扇入/扇出最高）？`,
    ].join('\n');
    dbg('graph-interaction', `region-selected: ${data.nodeCount} nodes`);
    bus.emit('agent:query', question);
  }
}
