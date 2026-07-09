// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Minimal skill system — loads markdown files from .hologram/skills/<name>/SKILL.md
// Format: YAML frontmatter (name, description) + markdown body.
// ponytail: no yaml library, no plugin system, no hot reload, no namespace mgmt.
// Skills are loaded once at agent setup.

import { invoke } from '../bridge';
import type { Tool } from './tool';

export interface SkillDef {
  name: string;
  description: string;
  prompt: string;
}

// ── Frontmatter parser (line-by-line, zero deps) ──

function parseSkillMd(raw: string): { meta: Record<string, string>; body: string } {
  const stripped = raw.replace(/^\s*\d+\t/gm, ''); // strip cat -n line numbers
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

// ── Skill loader ──

/** Load all skills from .hologram/skills/<name>/SKILL.md. Returns empty array
 *  if the directory doesn't exist or no valid skills are found. */
export async function loadSkills(projectPath: string): Promise<SkillDef[]> {
  const root = projectPath.replace(/\\/g, '/');
  const dir = `${root}/.hologram/skills`;
  let entries: Array<{ name: string; type: string; path: string }>;
  try {
    entries = await invoke<Array<{ name: string; type: string; path: string }>>(
      'list_directory_flat',
      { path: dir, isAgent: false },
    );
  } catch {
    return []; // directory doesn't exist — no skills
  }

  const skills: SkillDef[] = [];
  for (const e of entries) {
    if (e.type !== 'dir') continue;
    const fp = `${e.path.replace(/\\/g, '/')}/SKILL.md`;
    try {
      const raw = await invoke<string>('read_file_content', { filePath: fp, isAgent: false });
      const { meta, body } = parseSkillMd(raw);
      if (!body) continue;
      skills.push({
        name: e.name,
        description: meta.description || meta.name || e.name,
        prompt: body,
      });
    } catch { /* skip broken or missing SKILL.md */ }
  }
  return skills;
}

// ── Skill tool factory ──

/** Create the Skill tool that the model can call to invoke a skill by name.
 *  Returns the skill's prompt content as the tool result — model reads it
 *  and follows the embedded instructions. */
export function createSkillTool(skills: SkillDef[]): Tool {
  return {
    name: () => 'Skill',
    description: () =>
      'Execute a skill within the main conversation. Skills are predefined workflows. ' +
      'Use to invoke a known skill by name. Call without args to list available skills.',
    parameters: () => ({
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: `Skill name. Available: ${skills.map(s => s.name).join(', ') || 'none'}`,
        },
        args: {
          type: 'string',
          description: 'Optional argument string passed to the skill (substituted as $ARGUMENTS in the skill body).',
        },
      },
      required: ['skill'],
    }),
    readOnly: () => true,
    execute: async (args) => {
      const name = (args['skill'] as string)?.trim();
      const skillArgs = (args['args'] as string) || '';
      if (!name) {
        return `Available skills:\n${skills.map(s => `- **${s.name}**: ${s.description}`).join('\n') || 'none'}`;
      }
      const skill = skills.find(s => s.name === name);
      if (!skill) {
        return `Skill "${name}" not found. Available: ${skills.map(s => s.name).join(', ') || 'none'}`;
      }
      // Substitute $ARGUMENTS placeholder if present
      const body = skill.prompt.replace(/\$ARGUMENTS/g, skillArgs);
      return body;
    },
  };
}
