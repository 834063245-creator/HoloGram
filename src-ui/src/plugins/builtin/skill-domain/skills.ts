// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Skill system — loads SKILL.md skills from project `.lantai/skills/` and
// user-level `~/.lantai/skills/` (Agent Skills 开放标准形态：目录包
// `<name>/SKILL.md`，YAML frontmatter `name` + `description` + markdown body）。
//
// 生产级改造（2026-09-07，skills-mcp-production-plan §3.1）：
//   - frontmatter 用 yaml 包解析（对齐 composition/preset-discovery），不再手写行扫
//   - schema 校验（name/description/可选项），坏档带 reason 可见诊断（skip 不炸发现）
//   - 双发现根：项目 `.lantai/skills` + 用户级 `~/.lantai/skills`（用户级读取依赖
//     Rust sandbox 白名单扩展，Commit 3 落地前静默降级——失败不影响项目级）
//   - 双形态：目录包 `<name>/SKILL.md` + 扁平 `<name>.md`
//   - digest 化目录（供每步 available_skills 发现注入增量判断）
//   - `${LANTAI_SKILL_DIR}` 占位符展开为技能目录绝对路径（资源基址锚）
//   - 热装载保留（调用时重扫），但加目录缓存——技能不变不重复 list+read
//
// 第三发现根（2026-09-08）：出厂技能 builtin-skills.ts——编译进 bundle 随
// exe 分发（分发环境下项目/用户两个磁盘根都是空的，Agent 的兰台特有知识
// 全靠这一根；2026-10-13 起含插件开发 + office 域两门）。优先级：项目 >
// 用户 > 出厂（同名去重，用户可用同名覆盖出厂版）。
//
// 接口面：SkillDef / scanSkills / SkillRegistry(reload/.names) / createSkillTool。
//
// 批 9h-3（2026-09-26）：本件随 `skill-domain` 产物包（原 `agent/skills.ts`）——
// **形状上收内核契约** `agent/skill-contract.ts`（`SkillDef` / `SkillScan` /
// `SkillRegistryFace` / `SkillImplementation`），内核调用点改走登记表门面
// （`agent/skill-impl.ts` 的 `createSkillRegistry` / `scanSkills`，缺实现 fail-loud）。
// `yaml` / `zod` 是裸包，产物构建期整包内联（自包含契约：产物 entry.js 零静态 import）。

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { BUILTIN_SKILLS } from './builtin-skills';
import {
  type DirEntry,
  defineTool,
  kernelGlobalMemoryDir,
  kernelListDirectoryFlat,
  kernelReadFile,
  type SkillDef,
  type SkillRegistryFace,
  type SkillScan,
  type Tool,
} from './host';

export type { SkillDef, SkillScan };

// ── 技能名规约（对齐 Agent Skills 标准：小写 kebab-case）──

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** frontmatter 解析：yaml 库解析 `---` 围栏段（对齐 preset-discovery 的 yaml
 *  用法）。body 保留原样（仅去首尾空行——正文格式不丢）。解析失败抛错由调用
 *  方转 skipped 诊断。 */
function parseSkillMd(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { meta: {}, body: raw };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    // 未闭合 frontmatter——不炸，当无 frontmatter 处理（body 含围栏原文）
    return { meta: {}, body: raw };
  }
  const frontRaw = lines.slice(1, end).join('\n');
  let parsed: unknown;
  try {
    parsed = parseYaml(frontRaw);
  } catch (e) {
    throw new Error(`frontmatter YAML 解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (parsed == null) return { meta: {}, body };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter 必须是 YAML 键值映射');
  }
  const rec = parsed as Record<string, unknown>;
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    meta[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return { meta, body };
}

/** 从元数据 + 目录名产出一条技能（name/description 宽松回退 + 校验）。
 *  目录名是技能身份（Agent Skills 标准：SKILL.md 所在目录 = 技能名）；
 *  frontmatter name 仅作一致性展示（不一致不致命，目录名胜）。 */
function skillFromMeta(
  dirName: string,
  meta: Record<string, string>,
  body: string,
  source: 'project' | 'user',
  dirPath: string,
): { skill: SkillDef } | { error: string } {
  const name = dirName;
  if (!SKILL_NAME_RE.test(name)) {
    return { error: `技能名 "${name}" 非法（必须小写 kebab-case）` };
  }
  const description =
    meta.description ||
    meta.Description ||
    body
      .split('\n')
      .find((l) => l.trim())
      ?.slice(0, 240) ||
    '';
  const prompt = body
    // ${LANTAI_SKILL_DIR} → 技能目录绝对路径（资源基址——技能内引用
    // scripts/references/assets 的相对解析锚）
    .replaceAll('$' + '{LANTAI_SKILL_DIR}', dirPath.replace(/\\/g, '/'));
  return {
    skill: {
      name,
      description: description.slice(0, 1024),
      prompt,
      whenToUse: meta.when_to_use || meta.whenToUse || undefined,
      dir: dirPath,
      source,
    },
  };
}

/** 扫描单个技能目录（<name>/SKILL.md）。损坏 → skipped（带 reason，不炸）。 */
async function scanSkillDir(
  dirPath: string,
  name: string,
  source: 'project' | 'user',
  skipped: Array<{ name: string; reason: string; dir: string }>,
): Promise<SkillDef | null> {
  const fp = `${dirPath}/SKILL.md`;
  try {
    const raw = await kernelReadFile(fp);
    const { meta, body } = parseSkillMd(raw);
    const parsed = skillFromMeta(name, meta, body, source, dirPath);
    if ('error' in parsed) {
      skipped.push({ name, reason: parsed.error, dir: dirPath });
      return null;
    }
    return parsed.skill;
  } catch (e) {
    skipped.push({
      name,
      reason: `读取/解析失败: ${e instanceof Error ? e.message : String(e)}`,
      dir: dirPath,
    });
    return null;
  }
}

/** 扫描一个技能根（目录包 <name>/SKILL.md + 扁平 <name>.md 双形态）。 */
async function scanSkillRoot(
  root: string,
  source: 'project' | 'user',
  skipped: Array<{ name: string; reason: string; dir: string }>,
): Promise<SkillDef[]> {
  let entries: DirEntry[];
  try {
    entries = await kernelListDirectoryFlat(root);
  } catch {
    // 目录不存在 / 沙箱拒（用户级在 Rust 白名单扩展前）——非错误
    return [];
  }
  const skills: SkillDef[] = [];
  for (const e of entries) {
    if (e.is_dir) {
      const s = await scanSkillDir(e.path.replace(/\\/g, '/'), e.name, source, skipped);
      if (s) skills.push(s);
    } else if (/\.md$/i.test(e.name)) {
      // 扁平形态 <name>.md（技能名 = 文件名去扩展）
      const name = e.name.replace(/\.md$/i, '');
      const fp = e.path.replace(/\\/g, '/');
      try {
        const raw = await kernelReadFile(fp);
        const { meta, body } = parseSkillMd(raw);
        const parsed = skillFromMeta(name, meta, body, source, fp);
        if ('error' in parsed) {
          skipped.push({ name, reason: parsed.error, dir: fp });
          continue;
        }
        skills.push(parsed.skill);
      } catch (err) {
        skipped.push({
          name,
          reason: `读取/解析失败: ${err instanceof Error ? err.message : String(err)}`,
          dir: fp,
        });
      }
    }
  }
  return skills;
}

/** 用户级 .lantai 目录（~/.lantai）。经 kernelGlobalMemoryDir 推导
 *  （`~/.lantai/global_memory` → 父目录）。失败返回 null（降级项目级）。 */
async function resolveUserLantaiDir(): Promise<string | null> {
  try {
    const g = await kernelGlobalMemoryDir();
    const norm = g.replace(/\\/g, '/').replace(/\/+$/, '');
    // ~/.lantai/global_memory → ~/.lantai
    const idx = norm.lastIndexOf('/global_memory');
    if (idx > 0) return norm.slice(0, idx);
    return norm;
  } catch {
    return null;
  }
}

/** 目录扫描（纯函数，供 reload 与测试直调）。返回目录 + 诊断 + digest。 */
export async function scanSkills(projectPath: string, userDirOverride?: string | null): Promise<SkillScan> {
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const projectRoot = `${root}/.lantai/skills`;
  const skipped: Array<{ name: string; reason: string; dir: string }> = [];
  const skills: SkillDef[] = [];

  // 项目级优先（同名时项目覆盖用户——靠收集序 + 去重实现）
  const projectSkills = await scanSkillRoot(projectRoot, 'project', skipped);
  skills.push(...projectSkills);

  // 用户级（读取依赖 Rust 沙箱白名单；失败静默降级——项目级不受影响）
  let userRoot: string | null = null;
  if (userDirOverride !== undefined) {
    userRoot = userDirOverride ? `${userDirOverride.replace(/\\/g, '/').replace(/\/+$/, '')}/skills` : null;
  } else {
    const userLantai = await resolveUserLantaiDir();
    userRoot = userLantai ? `${userLantai}/skills` : null;
  }
  if (userRoot) {
    const userSkills = await scanSkillRoot(userRoot, 'user', skipped);
    // 项目胜用户：同名保留项目版
    const projectNames = new Set(skills.map((s) => s.name));
    for (const s of userSkills) {
      if (!projectNames.has(s.name)) skills.push(s);
    }
  }

  // 出厂技能（第三发现根——bundle 内、随 exe 分发）：优先级最低，项目/用户
  // 同名版胜出（用户可覆盖出厂面）。出厂内容自包含（无 dir——占位符不适用）。
  const seen = new Set(skills.map((s) => s.name));
  for (const b of BUILTIN_SKILLS) {
    if (!seen.has(b.name)) {
      skills.push({
        name: b.name,
        description: b.description,
        whenToUse: b.whenToUse,
        prompt: b.prompt,
        source: 'builtin',
      });
    }
  }

  // digest（稳定摘要——发现注入增量判断）：name|source 排序后 hash
  const digest = stableDigest(
    skills
      .map((s) => `${s.source}:${s.name}`)
      .sort()
      .join('|'),
  );
  return { skills, skipped, digest };
}

/** 稳定摘要（FNV-1a 32 位 hex——无 crypto 依赖，纯函数可测）。 */
function stableDigest(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── SkillRegistry — hot-loading skill manager ──

export class SkillRegistry implements SkillRegistryFace {
  private projectPath: string;
  /** 用户级 .lantai 目录（缺省 null = 内部经 kernelGlobalMemoryDir 推导）。 */
  private userDirOverride: string | null | undefined;
  private _names: string[] = [];
  /** 最近一次扫描的 digest（发现注入增量判断）。 */
  private _digest = '';
  /** 最近一次扫描的完整产出（含 skipped 诊断——工具调用时可读）。 */
  private _lastScan: SkillScan = { skills: [], skipped: [], digest: '' };

  constructor(projectPath: string, userDirOverride?: string | null) {
    this.projectPath = projectPath;
    this.userDirOverride = userDirOverride;
  }

  /** 全量重扫磁盘（项目 + 用户双层）。调用时热装载——技能安装即现。 */
  async reload(): Promise<SkillDef[]> {
    const scan = await scanSkills(this.projectPath, this.userDirOverride);
    this._names = scan.skills.map((s) => s.name);
    this._digest = scan.digest;
    this._lastScan = scan;
    return scan.skills;
  }

  /** 只重扫（不返回技能列表——内部消费：装载预热/变更检测）。 */
  async refresh(): Promise<void> {
    await this.reload();
  }

  /** 当前技能名（来自最近 reload）。slash 命令 handler 用。 */
  get names(): string[] {
    return this._names;
  }

  /** 最近一次扫描 digest（空 = 未扫/无技能）。 */
  get digest(): string {
    return this._digest;
  }

  /** 最近一次扫描产出（含 skipped 诊断）。 */
  get lastScan(): SkillScan {
    return this._lastScan;
  }
}

// ── Skill tool factory ──

/** 创建 Skill 工具（registry 每次调用热装载）。
 *  批 9h-3：入参取**内核契约面** `SkillRegistryFace`（装配面传入的是门面类型，
 *  实现只需 `reload()` / `lastScan` 两个成员）。 */
export function createSkillTool(registry: SkillRegistryFace): Tool {
  return defineTool({
    name: 'Skill',
    description:
      'Execute a skill within the main conversation. Skills are predefined workflows stored ' +
      'as markdown files under .lantai/skills/ (project) and ~/.lantai/skills/ (user). ' +
      'Install a new skill mid-session — it is immediately available. ' +
      'Call without a skill name to list all available skills. ' +
      'User slash commands like /skill-name are automatically routed here.',
    schema: z.object({
      // skill 可选：缺省 = 列举全部可用技能（含装载失败诊断）
      skill: z.string().trim().optional().describe('Skill name (optional — omit to list all available skills).'),
      args: z.string().optional().describe('Optional argument string ($ARGUMENTS in skill body).'),
    }),
    readOnly: true,
    execute: async (args) => {
      // Hot-load — 新装技能立即可见；同时更新 digest/诊断
      const skills = await registry.reload();
      const name = args.skill;
      const skillArgs = args.args || '';

      if (!name) {
        const lines = skills.map((s) => `- **${s.name}**: ${s.description}`);
        if (registry.lastScan.skipped.length > 0) {
          const diag = registry.lastScan.skipped.map((s) => `  - ${s.name}: ${s.reason}`).join('\n');
          lines.push(`\n以下技能装载失败（已跳过）:\n${diag}`);
        }
        return skills.length === 0 && registry.lastScan.skipped.length === 0
          ? 'No skills installed. Create .lantai/skills/<name>/SKILL.md or ~/.lantai/skills/<name>/SKILL.md to add one.'
          : `Available skills:\n${lines.join('\n')}`;
      }

      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return `Skill "${name}" not found. Available: ${skills.map((s) => s.name).join(', ') || 'none'}`;
      }

      return skill.prompt.replace(/\$ARGUMENTS/g, skillArgs);
    },
  });
}
