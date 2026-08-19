// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Graph Interaction — Step 3: 图作为 Agent 输入设备
// 订阅 scene 信号 store 的节点点击（P1 总线归零：原 bus 'graph:node-clicked'）
// 不改 Agent 循环。纯增量。

import { type GraphNodeClicked, useSceneSignalStore } from '../state/scene-signal-store';
import { dbg } from './debug';

export class GraphInteraction {
  constructor() {
    // ponytail：副作用构造函数，store 监听器常驻（main.ts 进程级单例）
    useSceneSignalStore.subscribe((s, prev) => {
      if (s.nodeClickedTick !== prev.nodeClickedTick && s.nodeClicked) {
        this._onNodeClicked(s.nodeClicked);
      }
    });
  }

  private _onNodeClicked(data: GraphNodeClicked): void {
    dbg('graph-interaction', `node-clicked: "${data.nodeName}" (${data.nodeType})`);
  }
}
