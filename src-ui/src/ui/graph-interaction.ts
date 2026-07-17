// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Graph Interaction — Step 3: 图作为 Agent 输入设备
// 订阅图交互事件 graph:node-clicked
// 不改 Agent 循环。纯增量。

import { dbg } from './debug';
import { bus } from './events';

interface NodeClickedData {
  nodeName: string;
  nodeType: string;
  nodeId: string;
  degree: number;
  location: string;
}

export class GraphInteraction {
  constructor() {
    bus.on('graph:node-clicked', this._onNodeClicked.bind(this));
  }

  private _onNodeClicked(data: NodeClickedData): void {
    dbg('graph-interaction', `node-clicked: "${data.nodeName}" (${data.nodeType})`);
  }
}
