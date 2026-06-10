// Agent Visualizer — 解析 Agent 工具调用结果，触发星图可视化
// 不改 Agent 循环，不改 Python 引擎。纯胶水层。

import type { StarGraph } from './graph';
import { bus } from './events';

/**
 * Shared helper — send a question to the Agent (opens chat panel if closed).
 * Use this from any UI panel to let the user ask Agent about something.
 */
export function askAgent(question: string): void {
  bus.emit('agent:query', question);
}

/**
 * Called after every Agent tool invocation.
 * Parses the tool name, arguments, and result text to decide
 * which visual effect to trigger on the star graph.
 *
 * All parsing is try-catch wrapped — failures silently skip.
 * The chat panel text output is never affected.
 */
export function visualizeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  graph: StarGraph,
): void {
  try {
    switch (toolName) {
      case 'hologram_path':
        handlePath(args, graph);
        break;
      case 'hologram_impact':
        handleImpact(args, graph);
        break;
      case 'hologram_neighbors':
        handleNeighbors(args, graph);
        break;
      case 'hologram_coupling_report':
        handleCouplingReport(args, graph);
        break;
      case 'hologram_fragile':
        handleFragile(resultText, graph);
        break;
      case 'hologram_cycle':
        handleCycle(resultText, graph);
        break;
      case 'hologram_diff':
        handleDiff(resultText, graph);
        break;
      case 'hologram_blindspots':
        handleBlindspots(resultText, graph);
        break;
      case 'hologram_run_check':
        handleRunCheck(resultText, graph);
        break;
      case 'hologram_history':
        handleHistory(args, graph);
        break;
      case 'hologram_community':
        handleCommunity(resultText, graph);
        break;
      case 'hologram_delayed':
        handleDelayed(resultText, graph);
        break;
      case 'hologram_changes':
        handleChanges(resultText, graph);
        break;
    }
  } catch {
    // Visualization failure must never break the chat
  }
}

// ── Individual handlers ────────────────────────────────

function handlePath(args: Record<string, unknown>, graph: StarGraph): void {
  const from = String(args['from'] || args['from_node'] || '');
  const to = String(args['to'] || args['to_node'] || '');
  if (!from || !to) return;
  graph.showPathOnGraph(from, to);
}

function handleImpact(args: Record<string, unknown>, graph: StarGraph): void {
  const node = String(args['node_id'] || '');
  if (!node) return;
  graph.focusNode(node);
}

function handleNeighbors(args: Record<string, unknown>, graph: StarGraph): void {
  const node = String(args['node_id'] || '');
  if (!node) return;
  graph.focusNode(node);
}

function handleCouplingReport(args: Record<string, unknown>, graph: StarGraph): void {
  const module = String(args['module'] || '');
  if (!module) return;
  graph.focusNode(module);
}

function handleFragile(resultText: string, graph: StarGraph): void {
  const names = parseFragileOutput(resultText);
  if (names.length > 0) {
    graph.highlightNodeNames(names, '#f0b848'); // sol = warm warning
  }
}

function handleCycle(resultText: string, graph: StarGraph): void {
  const names = parseCycleOutput(resultText);
  if (names.length > 0) {
    graph.highlightNodeNames(names, '#d94444'); // fail = danger
  }
}

function handleDiff(resultText: string, graph: StarGraph): void {
  let diffData: any;
  try {
    diffData = JSON.parse(resultText);
  } catch {
    return; // not valid JSON, skip
  }
  if (diffData && !diffData.is_empty) {
    graph.showDiff(diffData);
  }
}

function handleBlindspots(resultText: string, graph: StarGraph): void {
  let data: any;
  try {
    data = JSON.parse(resultText);
  } catch {
    return;
  }
  const names: string[] = [];
  const items = Array.isArray(data) ? data : (data?.blindspots || data?.results || []);
  for (const item of items) {
    const name = item?.node_name || item?.name || item?.module || '';
    if (name) names.push(String(name));
  }
  if (names.length > 0) {
    graph.highlightNodeNames(names, '#f0b848'); // sol
  }
}

function handleRunCheck(resultText: string, graph: StarGraph): void {
  let data: any;
  try {
    data = JSON.parse(resultText);
  } catch {
    return;
  }
  // Check results have affected_nodes with graph_node_ids
  const signals = data?.signals || [];
  const names: string[] = [];
  for (const sig of signals) {
    const ids = sig?.graph_node_ids || [];
    const nodeNames = sig?.affected_nodes || [];
    names.push(...nodeNames.map(String));
  }
  if (names.length > 0) {
    graph.highlightNodeNames(names, '#d94444'); // fail = violations
  }
}

// ── Text parsers ──────────────────────────────────────

/**
 * Parse hologram_fragile tabular output.
 * Format:
 *   Top N Most Fragile Modules:
 *     Module                    L4   L3   L2   L1   Score
 *     -----------------------  ---  ---  ---  ---  ------
 *     my.module.name             5    3    2    1   0.850
 */
function parseFragileOutput(text: string): string[] {
  const names: string[] = [];
  const lines = text.split('\n');
  let inTable = false;
  for (const line of lines) {
    if (line.includes('---') && line.includes('--')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    // Match module name in first column: whitespace-padded, followed by numbers
    const m = line.match(/^\s{2}(\S+)\s+\d+/);
    if (m && m[1]) {
      names.push(m[1]);
    }
  }
  return names;
}

/**
 * Parse hologram_cycle output.
 * Format:
 *   [category] 环长 N 跳: A → B → C
 */
function parseCycleOutput(text: string): string[] {
  const names = new Set<string>();
  // Match arrows: "A → B → C"
  const arrowLines = text.match(/→.+→/g);
  if (arrowLines) {
    for (const line of arrowLines) {
      const parts = line.split('→').map(s => s.trim());
      for (const p of parts) {
        if (p && p.length < 120 && !p.startsWith('[')) {
          names.add(p);
        }
      }
    }
  }
  return Array.from(names);
}

// ── New tools (from MCP) ──────────────────────────────

function handleHistory(args: Record<string, unknown>, graph: StarGraph): void {
  const node = String(args['node_id'] || '');
  if (!node) return;
  graph.focusNode(node);
}

function handleCommunity(resultText: string, graph: StarGraph): void {
  let data: any;
  try { data = JSON.parse(resultText); } catch { return; }
  const names: string[] = [];
  const siblings = data?.sibling_nodes || [];
  for (const sid of siblings) names.push(String(sid));
  // Also include the node itself
  if (data?.node_id) names.push(String(data.node_id));
  if (names.length > 0) {
    graph.highlightNodeNames(names, '#a088e0'); // nebula = community
  }
}

function handleDelayed(resultText: string, graph: StarGraph): void {
  let data: any;
  try { data = JSON.parse(resultText); } catch { return; }
  const names = new Set<string>();
  for (const d of (data?.realtime || [])) {
    if (d.source?.name) names.add(String(d.source.name));
    if (d.target?.name) names.add(String(d.target.name));
  }
  for (const d of (data?.periodic || [])) {
    if (d.source?.name) names.add(String(d.source.name));
    if (d.target?.name) names.add(String(d.target.name));
  }
  if (names.size > 0) {
    graph.highlightNodeNames(Array.from(names), '#f0b848'); // sol = temporal
  }
}

function handleChanges(resultText: string, graph: StarGraph): void {
  let data: any;
  try { data = JSON.parse(resultText); } catch { return; }
  const nodes = data?.last_change?.affected_nodes || [];
  const names = nodes.map(String);
  if (names.length > 0) {
    graph.highlightNodeNames(names, '#d94444'); // fail = changed
  }
}
