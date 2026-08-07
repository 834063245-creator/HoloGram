// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings — API Key 管理、模型选择、provider 配置
// 存储在 localStorage 中，在可用时由 Tauri store 插件支持

import { getModel } from './provider/catalog';

export interface ProviderSettings {
  kind: 'anthropic' | 'openai';
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking?: string; // Anthropic 扩展思考
  /** @deprecated 已移除——max_tokens 现在由 provider 默认值 + 模型目录上限自动决定。
   *  旧 localStorage 数据里的此字段会被忽略。 */
  maxTokens?: number;
}

export interface AgentSettings {
  temperature: number;
  contextWindow: number;
  /** DeepSeek: 禁用深度思考 (default false = auto). */
  disableThinking?: boolean;
  /** 默认协作模式 */
  collaborationMode?: 'normal' | 'plan';
  /** 默认权限模式 */
  permissionMode?: 'ask' | 'auto' | 'yolo';
}

interface DisplaySettings {
  language: 'zh' | 'en';
  fontScale: number;
}

export interface AppSettings {
  activeProvider: string; // provider name
  providers: ProviderSettings[];
  projectPath: string;
  agent: AgentSettings;
  display: DisplaySettings;
  /** @deprecated — 权限规则已迁移到 .hologram/permissions.json，由 Rust 后端管理。此字段仅保留以兼容旧 localStorage 数据，不再被读取。 */
  permissions?: { defaultMode?: 'allow' | 'ask' | 'deny'; allow?: string[]; deny?: string[] };
}

const STORAGE_KEY = 'hologram_settings';

const DEFAULTS: AppSettings = {
  activeProvider: 'deepseek',
  providers: [
    {
      kind: 'openai',
      name: 'deepseek',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    },
    {
      kind: 'anthropic',
      name: 'anthropic',
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      thinking: '',
    },
  ],
  projectPath: '.',
  agent: {
    temperature: 0.7,
    contextWindow: 0,
  },
  display: {
    language: 'zh',
    fontScale: 1.2,
  },
};

export function loadSettings(): AppSettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...parsed };
      }
    }
  } catch {
    // 设置损坏，使用默认值
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: AppSettings): void {
  if (typeof localStorage !== 'undefined') {
    // ⚡ 2026-08-04 状态治理：apiKey 不落 localStorage 明文。
    // 唯一权威 = 系统加密凭据（persistSecrets / restoreSecrets）；
    // localStorage 只存非敏感配置。provider 配置结构保留，仅抹空密钥字段。
    const sanitized: AppSettings = {
      ...s,
      providers: s.providers.map((p) => (p.apiKey ? { ...p, apiKey: '' } : p)),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  }
}

/** 将 API Key 持久化到系统加密存储（DPAPI on Windows），防止 localStorage 被清丢 Key。
 *  ⚡ 2026-08-04：apiKey 唯一权威在此 — 保存设置时同步写入凭据。
 *  ⚡ 2026-08-07 修正：空 key **不再执行 delete**——state 与凭据可能因异步回填
 *  暂时不同步（restoreSecrets 未完成时遍历会把未回填的 provider 误删）。
 *  删除凭据只走两个明确场景：removeProvider（removeSecret）与用户主动清空
 *  输入框（SettingsPanel commitSecret 对空值调 removeSecret）。 */
export async function persistSecrets(s: AppSettings): Promise<void> {
  try {
    const { rpc } = await import('./bridge');
    for (const p of s.providers) {
      const key = (p.apiKey || '').trim();
      if (key) {
        try {
          await rpc('credential_store', { provider: p.name, key });
        } catch {
          /* 非关键 — 凭据写入失败不影响本次会话 */
        }
      }
    }
  } catch {
    /* 动态导入失败 — 非关键 */
  }
}

/** 删除指定 provider 的 API Key from 系统加密存储（DPAPI）。removeProvider 时调用。 */
export async function removeSecret(providerName: string): Promise<void> {
  try {
    const { rpc } = await import('./bridge');
    await rpc('credential_delete', { provider: providerName });
  } catch {
    /* 无加密存储或 Key 未找到 — 非关键 */
  }
}

/** 解析 rpc 返回值中的字符串。rpc 返回 JSON 编码字符串（`"sk-xxx"` 或 `null`），
 *  调用方普遍需 JSON.parse；此处兼容两种形态：
 *  - `"sk-xxx"`（JSON 编码）→ 解析出 `sk-xxx`
 *  - `sk-xxx`（纯字符串，未来 Tauri 行为变化）→ 原样返回
 *  - `null` / 非法 JSON → null */
export function parseRpcString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === 'null' || trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return trimmed;
  }
}

/** 从系统加密存储恢复 API Key（仅填充 apiKey 为空的 provider）。loadSettings 后用。 */
export async function restoreSecrets(s: AppSettings): Promise<AppSettings> {
  try {
    const { rpc } = await import('./bridge');
    for (const p of s.providers) {
      if (!p.apiKey || p.apiKey.trim() === '') {
        try {
          const stored = await rpc('credential_get', { provider: p.name });
          const key = parseRpcString(stored);
          if (key?.trim()) {
            p.apiKey = key.trim();
          }
        } catch {
          /* 无加密存储或解密失败 */
        }
      }
    }
  } catch {
    /* 动态导入失败 — 继续使用仅 localStorage 的设置 */
  }
  // ⚡ 2026-08-04：不再 saveSettings 回写 — apiKey 权威在加密凭据，
  // 不允许把恢复出的密钥落回 localStorage 明文。
  return s;
}

export function getActiveProvider(s: AppSettings): ProviderSettings {
  const active = s.providers.find((p) => p.name === s.activeProvider);
  return active || s.providers[0];
}

function _setActiveProvider(s: AppSettings, name: string): AppSettings {
  if (!s.providers.find((p) => p.name === name)) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return { ...s, activeProvider: name };
}

export function updateProvider(s: AppSettings, name: string, patch: Partial<ProviderSettings>): AppSettings {
  return {
    ...s,
    providers: s.providers.map((p) => (p.name === name ? { ...p, ...patch } : p)),
  };
}

export function addProvider(s: AppSettings, name: string, kind: 'anthropic' | 'openai'): AppSettings {
  if (s.providers.find((p) => p.name === name)) {
    throw new Error(`Provider "${name}" 已存在`);
  }
  const baseUrl = kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  return {
    ...s,
    activeProvider: name,
    providers: [
      ...s.providers,
      {
        kind,
        name,
        apiKey: '',
        baseUrl,
        model: '',
      },
    ],
  };
}

export function removeProvider(s: AppSettings, name: string): AppSettings {
  const idx = s.providers.findIndex((p) => p.name === name);
  if (idx < 0) throw new Error(`Provider "${name}" 不存在`);
  if (s.providers.length <= 1) throw new Error('至少保留一个 Provider');
  const next = s.providers.filter((p) => p.name !== name);
  const active = s.activeProvider === name ? next[0].name : s.activeProvider;
  return { ...s, activeProvider: active, providers: next };
}

// ---- 定价（每百万 token）----

/** 解析显示定价：优先模型目录（权威 USD 数据），读不到才回退硬编码。 */
export function defaultPricing(kind: string, model: string) {
  const m = getModel(model);
  if (m && m.cost && m.cost.input > 0) {
    return { cache_hit: m.cost.cacheRead, input: m.cost.input, output: m.cost.output, currency: '$' };
  }
  if (kind === 'anthropic') {
    // Claude Sonnet 4 定价
    return { cache_hit: 0.3, input: 3, output: 15, currency: '$' };
  }
  if (model.includes('deepseek')) {
    return { cache_hit: 0.14, input: 2.0, output: 8.0, currency: '¥' };
  }
  // OpenAI 默认
  return { cache_hit: 2.5, input: 5, output: 15, currency: '$' };
}
