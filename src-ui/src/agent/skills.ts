// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Skill system — loads markdown files from .hologram/skills/<name>/SKILL.md
// Format: YAML frontmatter (name, description) + markdown body.
// Hot-loading: skills are reloaded on every Skill tool call — install a skill
// mid-session and it's immediately available, no restart needed.

import { rpc } from '../bridge';
import type { Tool } from './tool';

export interface SkillDef {
  name: string;
  description: string;
  prompt: string;
}

// ── Frontmatter parser (line-by-line, zero deps) ──

function parseSkillMd(raw: string): { meta: Record<string, string>; body: string } {
  const stripped = raw.replace(/^\s*\d+\t/gm, '');
  const lines = stripped.split('\n');
  if (lines[0]?.trim() !== '---') return { meta: {}, body: stripped };

  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') { i++; break; }
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim().replace(/^['"](.*)['"]$/, '$1');
      meta[key] = val;
    }
  }
  return { meta, body: lines.slice(i).join('\n').trim() };
}

// ── Skill loader (pure function, called on every tool invocation) ──

async function loadSkills(projectPath: string): Promise<SkillDef[]> {
  const root = projectPath.replace(/\\/g, '/');
  const dir = `${root}/.hologram/skills`;
  let entries: Array<{ name: string; type: string; path: string }>;
  try {
    entries = await rpc<Array<{ name: string; type: string; path: string }>>(
      'list_directory_flat', { path: dir, isAgent: false },
    );
  } catch {
    return [];
  }

  const skills: SkillDef[] = [];
  for (const e of entries) {
    if (e.type !== 'dir') continue;
    const fp = `${e.path.replace(/\\/g, '/')}/SKILL.md`;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: fp, isAgent: false });
      const { meta, body } = parseSkillMd(raw);
      if (!body) continue;
      skills.push({
        name: e.name,
        description: meta.description || meta.name || e.name,
        prompt: body,
      });
    } catch { /* skip broken skills */ }
  }
  return skills;
}

// ── SkillRegistry — hot-loading skill manager ──

export class SkillRegistry {
  private projectPath: string;
  private _names: string[] = [];

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /** Reload all skills from disk. Called on every Skill tool invocation
   *  and when chat.ts needs skill names for slash commands.
   *  ponytail: no caching — directory listing + file reads for ~5 skills
   *  takes <10ms on any modern FS. Simpler than TTL cache + stale detection. */
  async reload(): Promise<SkillDef[]> {
    const skills = await loadSkills(this.projectPath);
    this._names = skills.map(s => s.name);
    return skills;
  }

  /** Get current skill names (from last reload). Used by slash command handler. */
  get names(): string[] { return this._names; }
}

// ── Skill tool factory ──

/** Create the Skill tool backed by a registry that hot-loads on every call. */
export function createSkillTool(registry: SkillRegistry): Tool {
  return {
    name: () => 'Skill',
    description: () =>
      'Execute a skill within the main conversation. Skills are predefined workflows stored ' +
      'as markdown files. Install a new skill mid-session — it is immediately available. ' +
      'Call without a skill name to list all available skills. ' +
      'User slash commands like /skill-name are automatically routed here.',
    parameters: () => ({
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name (directory name under .hologram/skills/).',
        },
        args: {
          type: 'string',
          description: 'Optional argument string ($ARGUMENTS in skill body).',
        },
      },
      required: ['skill'],
    }),
    readOnly: () => true,
    execute: async (args) => {
      // Hot-load — ensures newly installed skills are visible immediately
      const skills = await registry.reload();
      const name = (args['skill'] as string)?.trim();
      const skillArgs = (args['args'] as string) || '';

      if (!name) {
        return skills.length === 0
          ? 'No skills installed. Create .hologram/skills/<name>/SKILL.md to add one.'
          : `Available skills:\n${skills.map(s => `- **${s.name}**: ${s.description}`).join('\n')}`;
      }

      const skill = skills.find(s => s.name === name);
      if (!skill) {
        return `Skill "${name}" not found. Available: ${skills.map(s => s.name).join(', ') || 'none'}`;
      }

      return skill.prompt.replace(/\$ARGUMENTS/g, skillArgs);
    },
  };
}
