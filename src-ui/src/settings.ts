// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings — API Key 管理、模型选择、provider 配置
// 存储在 localStorage 中，在可用时由 Tauri store 插件支持

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }
}

/** 将 API Key 持久化到系统加密存储（DPAPI on Windows），防止 localStorage 被清丢 Key。 */
export async function persistSecrets(s: AppSettings): Promise<void> {
  try {
    const { rpc } = await import('./bridge');
    for (const p of s.providers) {
      const key = (p.apiKey || '').trim();
      if (key) {
        try {
          await rpc('credential_store', { provider: p.name, key });
        } catch {
          /* 非关键 — localStorage 中仍有 Key */
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

/** 从系统加密存储恢复 API Key（仅填充 apiKey 为空的 provider）。loadSettings 后用。 */
export async function restoreSecrets(s: AppSettings): Promise<AppSettings> {
  try {
    const { rpc } = await import('./bridge');
    let changed = false;
    for (const p of s.providers) {
      if (!p.apiKey || p.apiKey.trim() === '') {
        try {
          const stored: string | null = await rpc('credential_get', { provider: p.name });
          if (stored?.trim()) {
            p.apiKey = stored.trim();
            changed = true;
          }
        } catch {
          /* 无加密存储或解密失败 */
        }
      }
    }
    if (changed) {
      saveSettings(s);
    }
  } catch {
    /* 动态导入失败 — 继续使用仅 localStorage 的设置 */
  }
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

export function defaultPricing(kind: string, model: string) {
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
