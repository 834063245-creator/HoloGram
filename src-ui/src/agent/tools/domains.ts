// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 领域工具收敛 — 把 ~70 个细粒度工具折叠成 8 个领域工具（fs/shell/git/search/web/agent/task/memory）。
// 设计：
//   - 每个领域工具 = action 判别联合（zod discriminatedUnion），动作参数直接继承旧工具的 JSON Schema，
//     避免手写参数映射造成"schema key / execute key / Rust 参数名"三处漂移（见 tests/tool-param-contract.test.ts）。
//   - execute 委托给 registry 中仍保留的旧工具（隐藏但可解析），逻辑零复制。
//   - 旧工具通过 ToolRegistry.hide() 从 schemas() 消失，但 get() 仍可解析（防御模型幻觉旧名、保持测试兼容）。

import type { Tool, ToolRegistry } from '../tool';

interface JsonProp {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type?: string };
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonProp>;
  required?: string[];
}

/**
 * 领域工具面向模型的 JSON Schema：扁平 object，而不是 discriminated union 的 oneOf。
 * DeepSeek 等严格校验的 OpenAI 兼容端点要求工具参数根节点为 type: "object"，
 * oneOf 根节点会直接 400（Invalid schema for function 'fs' ... got 'type: null'）。
 * action 为必选枚举；各动作私有参数合并为可选属性，跨动作参数在描述中标注所属动作。
 */
function domainParametersSchema(entries: Array<[string, string]>, registry: ToolRegistry): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: entries.map(([a]) => a),
      description: 'Which operation to perform.',
    },
  };
  const sources = new Map<string, Array<{ action: string; prop: JsonProp }>>();

  for (const [action, oldName] of entries) {
    const old = registry.get(oldName);
    if (!old) continue;
    const oldSchema = (old.parameters() ?? {}) as JsonSchema;
    for (const [key, rawProp] of Object.entries(oldSchema.properties ?? {})) {
      if (key === 'action') continue; // 保留域判别字段，避免旧工具参数覆盖
      const prop = rawProp as JsonProp;
      const list = sources.get(key);
      if (list) list.push({ action, prop });
      else sources.set(key, [{ action, prop }]);
    }
  }

  for (const [key, list] of sources) {
    const merged: JsonProp = { ...list[0].prop };
    const described = list.filter((s) => s.prop.description);
    if (described.length === 1) {
      merged.description = described[0].prop.description;
    } else if (described.length > 1) {
      merged.description = described.map((s) => `${s.prop.description} (action: ${s.action})`).join('; ');
    }
    properties[key] = merged;
  }

  return { type: 'object', properties, required: ['action'] };
}

/** 领域扁平 schema 的参数名归一：模型常混用 filePath/path/projectPath 等常见键。
 *  按旧工具的必填参数补齐（例如 fs(delete, filePath) → delete_file 的 path）。 */
export function normalizeArgs(old: Tool, rest: Record<string, unknown>): Record<string, unknown> {
  const schema = (old.parameters() ?? {}) as JsonSchema;
  const required = (schema.required ?? []) as string[];
  const out = { ...rest };
  const aliasMap: Record<string, string[]> = {
    filePath: ['path', 'file_path'],
    path: ['filePath'],
    projectPath: ['path', 'project_path'],
    newName: ['new_name'],
    new_name: ['newName'],
  };
  for (const req of required) {
    if (out[req] !== undefined) continue;
    for (const alias of aliasMap[req] ?? []) {
      if (out[alias] !== undefined) {
        out[req] = out[alias];
        break;
      }
    }
  }
  return out;
}

export interface DomainSpec {
  name: string;
  description: string;
  /** action 名 -> 旧工具名 */
  actions: Record<string, string>;
}

/** 领域定义 — 单一事实来源：动作名到旧工具名的映射。 */
export const DOMAIN_SPECS: DomainSpec[] = [
  {
    name: 'fs',
    description:
      'File-system operations: read / write / edit / list / glob / mkdir / move / rename / delete / constraints. ' +
      'Use fs(read) to inspect files, fs(write)/fs(edit) to modify them.',
    actions: {
      read: 'read_file_content',
      write: 'write_file',
      edit: 'edit_file',
      list: 'list_directory',
      glob: 'glob',
      mkdir: 'create_directory',
      move: 'move_file',
      rename: 'rename_file',
      delete: 'delete_file',
      constraints: 'read_constraints',
    },
  },
  {
    name: 'shell',
    description:
      'Shell execution: run (build/test commands only), plus output / wait / kill for background jobs. ' +
      'Do NOT use shell(run) for file search, code search, or git — use fs/search/git instead.',
    actions: {
      run: 'run_shell',
      output: 'bash_output',
      wait: 'bash_wait',
      kill: 'bash_kill',
    },
  },
  {
    name: 'git',
    description:
      'Git operations: status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame.',
    actions: {
      status: 'git_status',
      diff: 'git_diff',
      log: 'git_log',
      stage: 'git_stage',
      commit: 'git_commit',
      push: 'git_push',
      pull: 'git_pull',
      checkout: 'git_checkout',
      branch: 'git_create_branch',
      stash: 'git_stash_push',
      unstash: 'git_stash_pop',
      discard: 'git_discard',
      init: 'git_init',
      blame: 'git_blame',
    },
  },
  {
    name: 'search',
    description: 'Search source text across files: content matches, file lists, or match counts.',
    actions: {
      content: 'search_content',
    },
  },
  {
    name: 'web',
    description: 'Fetch a URL and return readable text (documentation, API responses, raw files).',
    actions: {
      fetch: 'web_fetch',
    },
  },
  {
    name: 'agent',
    description:
      'Sub-agent and inter-agent coordination: spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolation.',
    actions: {
      spawn: 'agent_spawn',
      status: 'agent_status',
      kill: 'agent_kill',
      message: 'agent_message',
      request: 'agent_request',
      reply: 'agent_reply',
      inbox: 'agent_inbox',
      ack: 'agent_ack',
      list: 'agent_list',
      merge: 'agent_merge',
      discover: 'agent_discover',
      lookup: 'agent_lookup',
      isolate_create: 'agent_isolation_create',
      isolate_diff: 'agent_isolation_diff',
      isolate_merge: 'agent_isolation_merge',
      isolate_discard: 'agent_isolation_discard',
      isolate_status: 'agent_isolation_status',
    },
  },
  {
    name: 'task',
    description: 'Task board: create / get / list / update / stop / board.',
    actions: {
      create: 'task_create',
      get: 'task_get',
      list: 'task_list',
      update: 'task_update',
      stop: 'task_stop',
      board: 'agent_board',
    },
  },
  {
    name: 'memory',
    description: 'Persistent project memory: save / read / search / list / delete.',
    actions: {
      save: 'hologram_memory_save',
      read: 'hologram_memory_read',
      search: 'hologram_memory_search',
      list: 'hologram_memory_list',
      delete: 'hologram_memory_delete',
    },
  },
];

function buildDomainTool(registry: ToolRegistry, spec: DomainSpec): Tool | null {
  const entries = Object.entries(spec.actions).filter(([, oldName]) => registry.get(oldName) !== undefined);
  if (entries.length === 0) return null;

  const parameters = domainParametersSchema(entries, registry);
  const readOnlyActions = entries.filter(([, oldName]) => registry.get(oldName)!.readOnly()).map(([a]) => a);

  return {
    name: () => spec.name,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => readOnlyActions.length === entries.length,
    domain: () => spec.name,
    actions: () => entries.map(([a]) => a),
    readOnlyActions: () => readOnlyActions,
    execute: async (args, onProgress, signal) => {
      const action = (args as { action?: unknown })?.action;
      const oldName = typeof action === 'string' ? spec.actions[action] : undefined;
      const old = oldName ? registry.get(oldName) : undefined;
      if (!old) {
        const available = entries.map(([a]) => a).join(', ');
        return `[${spec.name}] unsupported action "${String(action)}". Available actions: ${available}`;
      }
      const { action: _action, ...rest } = args;
      // signal 透传 — shell 链路的 abort 取消依赖它（取消排队/终止进程）
      return old.execute(normalizeArgs(old, rest), onProgress, signal);
    },
  };
}

/** 创建领域工具。缺失的旧工具（按配置可选注册）对应的动作被静默跳过。 */
export function createDomainTools(registry: ToolRegistry): Tool[] {
  const tools: Tool[] = [];
  for (const spec of DOMAIN_SPECS) {
    if (registry.get(spec.name)) continue; // 已存在（plan 模式守卫版 / 重复收敛）
    const t = buildDomainTool(registry, spec);
    if (t) tools.push(t);
  }
  return tools;
}

/** 需要从 schemas() 隐藏的旧工具名（含别名）。hide() 对不存在的名字无操作。 */
export function collectHiddenToolNames(): string[] {
  const names = new Set<string>(['read_file', 'symbol_history']);
  for (const spec of DOMAIN_SPECS) {
    for (const oldName of Object.values(spec.actions)) names.add(oldName);
  }
  // 运行时后注册的细粒度工具（runtime.ts createAgent 中注入）
  for (const n of [
    'agent_ack',
    'agent_board',
    'agent_discover',
    'agent_inbox',
    'agent_kill',
    'agent_list',
    'agent_lookup',
    'agent_merge',
    'agent_message',
    'agent_reply',
    'agent_request',
  ]) {
    names.add(n);
  }
  return [...names];
}

/** 收敛入口：注册领域工具 + 隐藏旧工具名。
 *  rebuildDomains=true 时先注销已有领域工具再重建（正常模式：补齐运行时后注册的动作）；
 *  rebuildDomains=false 时保留现有领域工具不重建，仅追加隐藏旧名。 */
export function convergeRegistry(registry: ToolRegistry, opts: { rebuildDomains?: boolean } = {}): void {
  const { rebuildDomains = true } = opts;
  if (rebuildDomains) {
    for (const spec of DOMAIN_SPECS) registry.unregister(spec.name);
  }
  for (const t of createDomainTools(registry)) registry.register(t);
  for (const n of collectHiddenToolNames()) registry.hide(n);
}

/** 把领域工具调用解析回旧工具名，供 preflight 门禁 / 图增强 hooks / 子 Agent 关联使用。 */
export function resolveGuardToolName(registry: ToolRegistry, toolName: string, args: Record<string, unknown>): string {
  const t = registry.get(toolName);
  if (!t?.domain) return toolName;
  const action = (args as { action?: unknown })?.action;
  if (typeof action !== 'string') return toolName;
  const spec = DOMAIN_SPECS.find((s) => s.name === toolName);
  return spec?.actions[action] ?? toolName;
}

/** 旧名重定向表：隐藏的旧工具被模型调用时，executor 返回"已淘汰 → 领域动作"而非执行。
 *  仅作用于模型调用路径（streaming-executor）；内部委托 / plan 写入 / 测试直接调旧工具不受影响。 */
const ALIAS_REDIRECTS: Record<string, string> = {
  read_file: 'read_file_content',
  symbol_history: 'inspect_symbol',
};

export function retireRedirect(toolName: string): string | null {
  let name = toolName;
  const visited = new Set<string>();
  while (ALIAS_REDIRECTS[name] && !visited.has(name)) {
    visited.add(name);
    name = ALIAS_REDIRECTS[name];
  }
  for (const spec of DOMAIN_SPECS) {
    for (const [action, oldName] of Object.entries(spec.actions)) {
      if (oldName === name) return `${spec.name}(${action})`;
    }
  }
  return null;
}
