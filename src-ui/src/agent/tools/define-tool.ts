// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════
// defineTool — zod Schema-First 工具定义工厂
// ═══════════════════════════════════════════════════════
// 一个 zod schema 同时产出三样东西:
//   1. JSON Schema(parameters()) — 给 LLM 的工具契约
//   2. 运行时校验(execute 前 parse) — 参数错误立即报错, 替代手写 as 强转 + 静默兜底
//   3. TS 类型(z.infer) — execute 收到的 args 已类型化, 消除手写解包
//
// 借鉴 kimi-code agent-core/tools/support/input-schema.ts:
//   zod v4 内置 z.toJSONSchema + io:'input' 视图 — defaulted 字段保持 optional,
//   避免"同时声明 default 又 required"的矛盾。
// 与 kimi 的差异: kimi 用 closeObjectNodes 强制 additionalProperties:false(他们无 parse 步骤);
//   我们 defineTool 内统一 .passthrough() — meta key(_callId/_agent_id/_forceGate)
//   由 streaming-executor 在 execute 前注入, 必须透传, 否则子 Agent 关联/架构门禁静默失效。

import { z } from 'zod';
import type { Tool } from '../tool';

/** zod schema → JSON Schema(draft-07, input 视图)。带 WeakMap 缓存 — parameters() 每轮被调用。 */
const schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  let cached = schemaCache.get(schema);
  if (!cached) {
    const jsonSchema = z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
    }) as Record<string, unknown>;
    delete jsonSchema.$schema; // 与现有手写 schema 输出形状一致(无 $schema 元字段)
    cached = jsonSchema;
    schemaCache.set(schema, cached);
  }
  return cached;
}

export interface DefineToolOpts<S extends z.ZodObject<z.ZodRawShape>> {
  /** 机器名, 与 ToolRegistry 注册名一致 */
  name: string;
  /** 面向模型的描述 */
  description: string;
  /** zod schema — 单一事实来源。schema key 必须与现状逐字一致(含 snake_case 风格),
   *  rpc() 的 camelCase→snake 转换 + Rust 端参数名依赖它。 */
  schema: S;
  /** 是否只读(可安全并行)。默认 false */
  readOnly?: boolean;
  /** 接收 parse 后的类型化参数(default 已注入, 校验失败会抛错而非静默兜底)。
   *  meta key(_callId/_agent_id/_forceGate) 不在类型内 — 需要时用 (args as { _callId?: string })._callId。
   *  signal 是可选中止信号 — 目前仅 shell 链路消费。 */
  execute: (args: z.infer<S>, onProgress?: (chunk: string) => void, signal?: AbortSignal) => Promise<string>;
}

/** 创建 Tool。返回的 Tool 与旧手写对象形状完全一致, 消费方(ToolRegistry/executor/plan/mock)零感知。 */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(opts: DefineToolOpts<S>): Tool {
  const { name, description, schema, readOnly = false, execute } = opts;
  // passthrough: 允许 schema 未声明的 meta key 透传(见文件头注释)
  const passthroughSchema = schema.passthrough();
  return {
    name: () => name,
    description: () => description,
    parameters: () => toInputJsonSchema(passthroughSchema),
    readOnly: () => readOnly,
    execute: async (args, onProgress, signal) => {
      let parsed: z.output<S>;
      try {
        // passthrough 的 TS 输出是 Record<string, unknown>（含未知 key），
        // 但运行时值一定满足 z.output<S> —— 此处收窄一次，execute 拿到类型化参数
        parsed = passthroughSchema.parse(args) as z.output<S>;
      } catch (e: any) {
        const issues = (e?.issues ?? [])
          .map((i: { path: (string | number)[]; message: string }) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new Error(`参数校验失败: ${issues || e?.message || String(e)}`);
      }
      return execute(parsed, onProgress, signal);
    },
  };
}
