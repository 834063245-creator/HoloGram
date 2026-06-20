// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings — API key management, model selection, provider config
// Stored in localStorage, backed by Tauri store plugin when available

export interface ProviderSettings {
  kind: 'anthropic' | 'openai';
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking?: string; // Anthropic extended thinking
}

export interface AgentSettings {
  temperature: number;
  maxSteps: number;
  contextWindow: number;
  chatMode: ChatModeId;
}

export type ChatModeId = 'general' | 'code' | 'architect' | 'fast';

export interface ChatMode {
  id: ChatModeId;
  label: string;
  description: string;
  temperature: number;
  maxSteps: number;
}

export const CHAT_MODES: ChatMode[] = [
  { id: 'general', label: '通用', description: '均衡回答', temperature: 0.7, maxSteps: 50 },
  { id: 'code', label: '编码', description: '直接动手，少问', temperature: 0.3, maxSteps: 80 },
  { id: 'architect', label: '架构', description: '深度查图分析', temperature: 0.5, maxSteps: 60 },
  { id: 'fast', label: '极速', description: '简短快速迭代', temperature: 0.2, maxSteps: 25 },
];

export interface DisplaySettings {
  defaultViewMode: 'standard' | 'full' | 'files';
  language: 'zh' | 'en';
}

export interface AppSettings {
  activeProvider: string; // provider name
  providers: ProviderSettings[];
  projectPath: string;
  agent: AgentSettings;
  display: DisplaySettings;
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
    maxSteps: 50,
    contextWindow: 0,
    chatMode: 'general',
  },
  display: {
    defaultViewMode: 'standard',
    language: 'zh',
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
    // corrupted settings, use defaults
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
    const { invoke } = await import('./bridge');
    for (const p of s.providers) {
      const key = (p.apiKey || '').trim();
      if (key) {
        try {
          await invoke('credential_store', { provider: p.name, key });
        } catch { /* non-critical — localStorage still has the key */ }
      }
    }
  } catch { /* dynamic import failed — non-critical */ }
}

/** 从系统加密存储恢复 API Key（仅填充 apiKey 为空的 provider）。loadSettings 后用。 */
export async function restoreSecrets(s: AppSettings): Promise<AppSettings> {
  try {
    const { invoke } = await import('./bridge');
    let changed = false;
    for (const p of s.providers) {
      if (!p.apiKey || p.apiKey.trim() === '') {
        try {
          const stored: string | null = await invoke('credential_get', { provider: p.name });
          if (stored && stored.trim()) {
            p.apiKey = stored.trim();
            changed = true;
          }
        } catch { /* no encrypted store or decrypt failed */ }
      }
    }
    if (changed) {
      saveSettings(s);
    }
  } catch { /* dynamic import failed — proceed with localStorage-only settings */ }
  return s;
}

export function getActiveProvider(s: AppSettings): ProviderSettings {
  const active = s.providers.find((p) => p.name === s.activeProvider);
  return active || s.providers[0];
}

export function setActiveProvider(s: AppSettings, name: string): AppSettings {
  if (!s.providers.find((p) => p.name === name)) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return { ...s, activeProvider: name };
}

export function updateProvider(
  s: AppSettings,
  name: string,
  patch: Partial<ProviderSettings>,
): AppSettings {
  return {
    ...s,
    providers: s.providers.map((p) =>
      p.name === name ? { ...p, ...patch } : p,
    ),
  };
}

// ---- Pricing (per 1M tokens) ----

export function defaultPricing(kind: string, model: string) {
  if (kind === 'anthropic') {
    // Claude Sonnet 4 pricing
    return { cache_hit: 0.30, input: 3, output: 15, currency: '$' };
  }
  if (model.includes('deepseek')) {
    return { cache_hit: 0.14, input: 2.0, output: 8.0, currency: '¥' };
  }
  // OpenAI default
  return { cache_hit: 2.5, input: 5, output: 15, currency: '$' };
}
