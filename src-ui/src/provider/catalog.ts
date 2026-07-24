// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Model catalog — static model data from Pi's provider registry, adapted for HoloGram.
// Provides data-driven model discovery so users don't need to manually type model names.

import anthropicJson from './catalog/anthropic.json';
import deepseekJson from './catalog/deepseek.json';
import minimaxJson from './catalog/minimax.json';
import moonshotaiJson from './catalog/moonshotai.json';
import openaiJson from './catalog/openai.json';
import qwenJson from './catalog/qwen.json';
import type { ModelDescriptor } from './types';

/** Catalog JSON file shape: { [modelId]: ModelDescriptor } */
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

// ── Dynamic models (fetched from provider APIs at runtime) ──
// Static catalog takes priority for same model ID (richer metadata: cost, contextWindow, etc.)
const _dynamicModels = new Map<string, ModelDescriptor[]>();

/** Merge dynamically-fetched models into the catalog. Invalidates the cache.
 *  Models with IDs already in the static catalog are skipped (static has richer metadata). */
export function mergeDynamicModels(providerName: string, models: ModelDescriptor[]): void {
  if (models.length === 0) return;
  _dynamicModels.set(providerName, models);
  _catalog = undefined; // invalidate cache
}

/** Get the count of dynamically discovered models for a provider. */
export function getDynamicModelCount(providerName: string): number {
  return _dynamicModels.get(providerName)?.length ?? 0;
}

function loadCatalog(): CatalogData {
  if (_catalog) return _catalog;
  const all: ModelDescriptor[] = [];
  const seenIds = new Set<string>();

  // Static catalog first (rich metadata — cost, contextWindow, reasoning, etc.)
  for (const file of Object.values(CATALOG_FILES)) {
    for (const model of Object.values(file)) {
      all.push(model);
      seenIds.add(model.id);
    }
  }

  // Merge dynamic models (skip if already in static — static has richer metadata)
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

/** Get all models in the catalog. */
export function getAllModels(): ModelDescriptor[] {
  return loadCatalog().allModels;
}

/** Find models belonging to a specific provider. */
export function findModels(providerName: string): ModelDescriptor[] {
  return loadCatalog().allModels.filter((m) => m.provider === providerName);
}

/** Look up a model by its id. */
export function getModel(modelId: string): ModelDescriptor | undefined {
  return loadCatalog().modelMap.get(modelId);
}

/** Fuzzy search models by id or display name (case-insensitive substring match). */
export function searchModels(query: string): ModelDescriptor[] {
  const { allModels } = loadCatalog();
  const q = query.toLowerCase().trim();
  if (!q) return allModels;
  return allModels.filter(
    (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
  );
}

/** Get the recommended default model for a provider. */
export function getDefaultModel(providerName: string): ModelDescriptor | undefined {
  const models = findModels(providerName);
  if (models.length === 0) return undefined;
  // Prefer the first model in the catalog (already ordered by relevance in Pi's data)
  return models[0];
}

/** List all provider names that have models in the catalog. */
export function getCatalogProviders(): string[] {
  return [...new Set(loadCatalog().allModels.map((m) => m.provider))];
}
