// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Skills 系统测试（skills-mcp-production-plan Commit 1）：
//   - yaml frontmatter 解析（标准 name/description + 附加字段）
//   - 项目级 + 用户级双层发现 + 项目胜用户同名去重
//   - 出厂技能第三发现根（builtin-skills.ts）：恒在场 + 项目/用户同名覆盖
//   - 坏档可见诊断（skipped 带 reason，不炸发现）
//   - digest 稳定（同内容同 digest；内容变 digest 变）
//   - ${LANTAI_SKILL_DIR} 展开
//   - Skill 工具（createSkillTool）：列举 / 按名取 / $ARGUMENTS 替换

// fs 域收口 mock：站到 rpc-contract 具名 helper（tests/helpers/kernel-fs.ts）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

// 批 9h-3：技能域实现随 skill-domain 产物包（原 src/agent/skills.ts）
import { createSkillTool, SkillRegistry, scanSkills } from '../src/plugins/builtin/skill-domain/skills';

const PROJ = '/proj';
/** MockFs 的 kernelGlobalMemoryDir 固定返回 ~/.lantai/global_memory → 用户根 ~/.lantai/skills。 */
const USER_ROOT = '~/.lantai/skills';

/** 磁盘技能（项目 + 用户）——出厂技能恒在场（第三发现根），计数断言看磁盘面。 */
function diskSkills(skills: Array<{ source: string }>) {
  return skills.filter((s) => s.source !== 'builtin');
}

beforeEach(() => {
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.fail = {};
});

/** 预置一个目录包技能。 */
function setDirSkill(root: string, name: string, front: string, body = 'do the thing'): string {
  const dir = `${root}/${name}`;
  const fp = `${dir}/SKILL.md`;
  H.kernelFs!.fs.setFile(fp, `---\n${front}\n---\n\n${body}`);
  return fp;
}

const STANDARD_FRONT = 'description: 审查代码变更';

describe('scanSkills — 项目级发现', () => {
  it('发现目录包技能并解析 yaml frontmatter', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'code-review', STANDARD_FRONT);
    const scan = await scanSkills(PROJ);
    const disk = diskSkills(scan.skills);
    expect(disk).toHaveLength(1);
    const s = disk[0];
    expect(s.name).toBe('code-review');
    expect(s.description).toBe('审查代码变更');
    expect(s.source).toBe('project');
    expect(scan.skipped).toHaveLength(0);
  });

  it('when_to_use 进目录、正文保留', async () => {
    setDirSkill(
      `${PROJ}/.lantai/skills`,
      'deploy',
      'name: deploy\ndescription: 部署到生产\nwhen_to_use: 用户提到发布时',
      '## 步骤\n1. 跑测试',
    );
    const scan = await scanSkills(PROJ);
    const deploy = scan.skills.find((s) => s.name === 'deploy')!;
    expect(deploy.whenToUse).toBe('用户提到发布时');
    expect(deploy.prompt).toContain('## 步骤\n1. 跑测试');
  });

  it('无项目/用户技能 = 出厂技能恒在场（第三发现根，随 exe 分发）', async () => {
    const scan = await scanSkills(PROJ);
    expect(scan.skipped).toHaveLength(0);
    expect(diskSkills(scan.skills)).toHaveLength(0);
    const pluginDev = scan.skills.find((s) => s.name === 'lantai-plugin-dev');
    expect(pluginDev).toBeDefined();
    expect(pluginDev!.source).toBe('builtin');
    expect(pluginDev!.dir).toBeUndefined(); // 不在盘上——内容自包含
    expect(pluginDev!.prompt).toContain('为兰台写插件');
    // 2026-10-13 收编：officecli 手册随出厂（原 examples/office-cli/SKILL.md，内容自包含）
    const office = scan.skills.find((s) => s.name === 'officecli');
    expect(office).toBeDefined();
    expect(office!.source).toBe('builtin');
    expect(office!.dir).toBeUndefined();
    expect(office!.prompt).toContain('office 域');
    // 2026-10-13 新增：埃台产品地图（出厂，自包含）
    const guide = scan.skills.find((s) => s.name === 'lantai-guide');
    expect(guide).toBeDefined();
    expect(guide!.source).toBe('builtin');
    expect(guide!.dir).toBeUndefined();
    expect(guide!.prompt).toContain('设置页');
    // 出厂面 digest 稳定且非空串摘要（出厂技能在场改变了恒在面）
    const again = await scanSkills(PROJ);
    expect(again.digest).toBe(scan.digest);
    expect(scan.digest).not.toBe('811c9dc5');
  });
});

describe('scanSkills — 用户级双层 + 项目胜用户', () => {
  it('发现用户级技能（~/.lantai/skills 经 global_memory_dir 推导）', async () => {
    setDirSkill(USER_ROOT, 'global-util', STANDARD_FRONT);
    const scan = await scanSkills(PROJ);
    expect(diskSkills(scan.skills)).toHaveLength(1);
    expect(scan.skills[0].source).toBe('user');
    expect(scan.skills[0].dir).toContain('~/.lantai/skills/global-util');
  });

  it('同名技能：项目胜用户（用户版被去重）', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'code-review', STANDARD_FRONT);
    setDirSkill(USER_ROOT, 'code-review', 'name: code-review\ndescription: 用户版审查');
    const scan = await scanSkills(PROJ);
    expect(diskSkills(scan.skills)).toHaveLength(1);
    expect(scan.skills[0].description).toBe('审查代码变更');
    expect(scan.skills[0].source).toBe('project');
  });

  it('用户级目录不存在 = 静默降级（项目级不受影响）', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'local', 'name: local\ndescription: 本地技能');
    const scan = await scanSkills(PROJ);
    expect(diskSkills(scan.skills)).toHaveLength(1);
    expect(scan.skills[0].name).toBe('local');
  });
});

describe('scanSkills — 坏档可见诊断', () => {
  it('非法技能名（非 kebab-case）进 skipped 带 reason', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'Bad_Name', 'name: Bad_Name\ndescription: x');
    const scan = await scanSkills(PROJ);
    expect(diskSkills(scan.skills)).toHaveLength(0);
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0].reason).toContain('非法');
  });

  it('坏 YAML frontmatter 不炸发现（其余技能照常装载）', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'broken', 'name: [unclosed');
    setDirSkill(`${PROJ}/.lantai/skills`, 'good', STANDARD_FRONT);
    const scan = await scanSkills(PROJ);
    const good = scan.skills.find((s) => s.name === 'good');
    expect(good).toBeTruthy();
    expect(scan.skipped.some((s) => s.name === 'broken')).toBe(true);
  });

  it('缺 SKILL.md 的目录跳过（读失败诊断）', async () => {
    // 目录存在但无 SKILL.md——setDirSkill 只建文件；手动建个空目录技能位
    H.kernelFs!.fs.setFile(`${PROJ}/.lantai/skills/ghost/SKILL.md`, '---\nname: ghost\ndescription: x\n---\n');
    const scan = await scanSkills(PROJ);
    expect(diskSkills(scan.skills)).toHaveLength(1);
  });
});

describe('scanSkills — digest 稳定', () => {
  it('同内容同 digest；变更后 digest 变', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'a', STANDARD_FRONT);
    const d1 = (await scanSkills(PROJ)).digest;
    const d2 = (await scanSkills(PROJ)).digest;
    expect(d1).toBe(d2);
    setDirSkill(`${PROJ}/.lantai/skills`, 'b', STANDARD_FRONT);
    const d3 = (await scanSkills(PROJ)).digest;
    expect(d3).not.toBe(d1);
  });
});

describe('scanSkills — 占位符展开', () => {
  it('正文占位符展开为技能目录绝对路径', async () => {
    const placeholder = '$' + '{LANTAI_SKILL_DIR}';
    const fp = setDirSkill(
      `${PROJ}/.lantai/skills`,
      'res',
      STANDARD_FRONT,
      `参考 [REFERENCE](references/REFERENCE.md) 位于 ${placeholder}/references/REFERENCE.md`,
    );
    const scan = await scanSkills(PROJ);
    const skill = scan.skills.find((s) => s.name === 'res')!;
    const wantDir = fp.replace(/\/SKILL\.md$/, '');
    expect(skill.prompt).toContain(`${wantDir}/references/REFERENCE.md`);
  });
});

describe('scanSkills — 出厂技能第三发现根（2026-09-08）', () => {
  it('同名：项目胜出厂（用户可用项目版覆盖出厂面）', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'lantai-plugin-dev', 'description: 项目定制版');
    const scan = await scanSkills(PROJ);
    const found = scan.skills.filter((s) => s.name === 'lantai-plugin-dev');
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('project');
    expect(found[0].description).toBe('项目定制版');
  });

  it('同名：用户胜出厂（无项目版时用户版覆盖）', async () => {
    setDirSkill(USER_ROOT, 'lantai-plugin-dev', 'description: 用户定制版');
    const scan = await scanSkills(PROJ);
    const found = scan.skills.filter((s) => s.name === 'lantai-plugin-dev');
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('user');
  });

  it('Skill 工具按名执行出厂技能（模型消费面——手册全文可取）', async () => {
    const reg = new SkillRegistry(PROJ);
    const out = await createSkillTool(reg).execute({ skill: 'lantai-plugin-dev' });
    expect(out).toContain('为兰台写插件');
    expect(out).toContain('cordis');
    expect(out).toContain('manifest.json');
  });

  it('Skill 工具按名执行 officecli 出厂技能（2026-10-13 收编——全文可取且自包含）', async () => {
    const reg = new SkillRegistry(PROJ);
    const out = await createSkillTool(reg).execute({ skill: 'officecli' });
    expect(out).toContain('office 域');
    expect(out).toContain('交付门槛');
    expect(out).toContain('batch');
    // 自包含纪律：收编正文不得引用仓内路径（出厂技能无磁盘目录，引了也够不着）
    expect(out).not.toContain('examples/office-cli');
  });
});

describe('SkillRegistry + createSkillTool', () => {
  it('reload 热装载：先装技能、reload 立即可见', async () => {
    const reg = new SkillRegistry(PROJ);
    expect(diskSkills(await reg.reload())).toHaveLength(0);
    setDirSkill(`${PROJ}/.lantai/skills`, 'fresh', STANDARD_FRONT);
    const skills = await reg.reload();
    expect(diskSkills(skills)).toHaveLength(1);
    expect(reg.names).toContain('fresh');
    expect(reg.names).toContain('lantai-plugin-dev'); // 出厂面恒在场
  });

  it('无技能名调用 = 列举（含装载失败诊断）', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'ok', STANDARD_FRONT);
    setDirSkill(`${PROJ}/.lantai/skills`, 'Bad_Name', 'name: Bad_Name\ndescription: x');
    const reg = new SkillRegistry(PROJ);
    const tool = createSkillTool(reg);
    const out = await tool.execute({});
    expect(out).toContain('ok');
    expect(out).toContain('装载失败');
    expect(out).toContain('Bad_Name');
  });

  it('按名取技能 + $ARGUMENTS 替换', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'greet', 'name: greet\ndescription: 打招呼', '向 $ARGUMENTS 打招呼');
    const reg = new SkillRegistry(PROJ);
    const tool = createSkillTool(reg);
    const out = await tool.execute({ skill: 'greet', args: '世界' });
    expect(out).toBe('向 世界 打招呼');
  });

  it('技能不存在 = 明确报错 + 可用列表', async () => {
    setDirSkill(`${PROJ}/.lantai/skills`, 'ok', STANDARD_FRONT);
    const reg = new SkillRegistry(PROJ);
    const tool = createSkillTool(reg);
    const out = await tool.execute({ skill: 'nope' });
    expect(out).toContain('not found');
    expect(out).toContain('ok');
  });

  it('用户级技能对 Skill 工具可见（reload 合并双层）', async () => {
    setDirSkill(USER_ROOT, 'user-only', STANDARD_FRONT);
    const reg = new SkillRegistry(PROJ);
    const skills = await reg.reload();
    expect(skills.some((s) => s.name === 'user-only' && s.source === 'user')).toBe(true);
  });
});
