// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 模型目录 — 来自 Pi 的 provider 注册表的静态模型数据，已适配 HoloGram。
// 提供数据驱动的模型发现，用户无需手动输入模型名称。
//
// ⚡ 2026-08-07 定稿（docs/provider-system-spec.md 裁决 #15）：
//   目录 = 开箱体验优化，非必需——所有消费点均有 fallback。
//   目录 JSON 里的 `kind` 是【协议】（anthropic/openai），不是厂商：
//   DeepSeek Beta 端点挂 kind=anthropic 是特性（官方提供 Anthropic 兼容 API）。
//   JSON 不支持注释，模型条目的协议归属以本文件与 tests/provider-catalog.test.ts 为准。

import anthropicJson from './catalog/anthropic.json';
import deepseekJson from './catalog/deepseek.json';
import minimaxJson from './catalog/minimax.json';
import moonshotaiJson from './catalog/moonshotai.json';
import openaiJson from './catalog/openai.json';
import qwenJson from './catalog/qwen.json';
import type { ModelDescriptor } from './types';

/** 目录 JSON 文件结构：{ [modelId]: ModelDescriptor } */
type CatalogFile = Record<string, ModelDescriptor>;

const CATALOG_FILES: Record<string, CatalogFile> = {
  anthropic: anthropicJson as CatalogFile,
  deepseek: deepseekJson as CatalogFile,
  minimax: minimaxJson as CatalogFile,
  moonshotai: moonshotaiJson as CatalogFile,
  openai: openaiJson as CatalogFile,
  qwen: qwenJson as CatalogFile,
};

interface CatalogData {
  allModels: ModelDescriptor[];
  modelMap: Map<string, ModelDescriptor>;
}

let _catalog: CatalogData | undefined;

// ── 动态模型（运行时从 provider API 获取）──
// 同一模型 ID 以静态目录优先（元数据更丰富：cost、contextWindow 等）
const _dynamicModels = new Map<string, ModelDescriptor[]>();

/** 将动态获取的模型合并到目录中。会使缓存失效。
 *  已在静态目录中的模型 ID 会被跳过（静态目录元数据更丰富）。 */
export function mergeDynamicModels(providerName: string, models: ModelDescriptor[]): void {
  if (models.length === 0) return;
  _dynamicModels.set(providerName, models);
  _catalog = undefined; // 使缓存失效
}

/** 获取某个 provider 动态发现的模型数量。 */
export function getDynamicModelCount(providerName: string): number {
  return _dynamicModels.get(providerName)?.length ?? 0;
}

function loadCatalog(): CatalogData {
  if (_catalog) return _catalog;
  const all: ModelDescriptor[] = [];
  const seenIds = new Set<string>();

  // 静态目录优先（元数据丰富 — cost、contextWindow、reasoning 等）
  for (const file of Object.values(CATALOG_FILES)) {
    for (const model of Object.values(file)) {
      all.push(model);
      seenIds.add(model.id);
    }
  }

  // 合并动态模型（已在静态目录中的跳过 — 静态目录元数据更丰富）
  for (const [, models] of _dynamicModels) {
    for (const model of models) {
      if (!seenIds.has(model.id)) {
        all.push(model);
        seenIds.add(model.id);
      }
    }
  }

  _catalog = { allModels: all, modelMap: new Map(all.map((m) => [m.id, m])) };
  return _catalog;
}

/** 获取目录中的所有模型。 */
export function getAllModels(): ModelDescriptor[] {
  return loadCatalog().allModels;
}

/** 查找属于特定 provider 的模型。 */
export function findModels(providerName: string): ModelDescriptor[] {
  return loadCatalog().allModels.filter((m) => m.provider === providerName);
}

/** 根据 id 查找模型。 */
export function getModel(modelId: string): ModelDescriptor | undefined {
  return loadCatalog().modelMap.get(modelId);
}

/** 将请求的 max_tokens 限制在模型目录的输出上限内。
 *  超出范围的 max_tokens 会导致严格的 provider 在生成任何 token 之前
 *  就以 400 拒绝每次请求（DeepSeek：有效范围 [1, 393216]）。
 *  未知模型（无目录条目）不做限制直接通过。 */
export function clampMaxTokens(modelId: string, requested: number): number {
  const cap = getModel(modelId)?.maxTokens;
  return cap && cap > 0 ? Math.min(requested, cap) : requested;
}

/** 按 id 或显示名称模糊搜索模型（不区分大小写的子串匹配）。 */
export function searchModels(query: string): ModelDescriptor[] {
  const { allModels } = loadCatalog();
  const q = query.toLowerCase().trim();
  if (!q) return allModels;
  return allModels.filter(
    (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
  );
}

/** 获取某个 provider 推荐的默认模型。 */
export function getDefaultModel(providerName: string): ModelDescriptor | undefined {
  const models = findModels(providerName);
  if (models.length === 0) return undefined;
  // 优先选择目录中的第一个模型（Pi 的数据已按相关性排序）
  return models[0];
}

/** 列出目录中有模型的所有 provider 名称。 */
export function getCatalogProviders(): string[] {
  return [...new Set(loadCatalog().allModels.map((m) => m.provider))];
}
