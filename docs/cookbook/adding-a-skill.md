# Adding a Skill（给 Agent 加一门技能）

> 技能 = 一段**按需加载**的说明（可带附属文件），让 Agent 在特定任务上按你写的步骤做。
> 形态遵循 Agent Skills 开放标准（目录包 + YAML frontmatter）。真源 `src-ui/src/plugins/builtin/skill-domain/skills.ts`；
> 技能面改造来历见 `docs/plans/skills-mcp-production-plan.md`。

## 放哪（三个发现根，优先级 项目 > 用户 > 出厂）

| 根 | 路径 | 用途 |
|---|---|---|
| **项目级** | `<工作区>/.lantai/skills/<name>/SKILL.md` | 只对当前项目生效 |
| **用户级** | `~/.lantai/skills/<name>/SKILL.md`（Windows = `%USERPROFILE%\.lantai\skills\`） | 跨项目共用 |
| **出厂** | 随包内置（`builtin-skills.ts`，编译进 exe） | 分发环境下 Agent 的插件开发知识；**同名时用户级可覆盖它** |

## 最小形态

```md
---
name: my-skill
description: 一句话说清什么时候用它（这句会进 Agent 每一步的技能目录）
---

# 我的技能

正文写步骤、注意事项、示例。资源可锚到本技能目录，例如运行
`${LANTAI_SKILL_DIR}/scripts/check.sh`，或引用 `${LANTAI_SKILL_DIR}/references/spec.md`。
```

- **两种形态**：目录包 `<name>/SKILL.md`（推荐，可带附属文件）+ 扁平 `<name>.md`。
- **frontmatter**：`name`（小写 kebab-case，必填）+ `description`（必填）+ 可选项（`when_to_use` / `allowed-tools` / `metadata`，宽松不严卡）。
- **资源**：技能目录里的 `scripts/` / `references/` / `assets/` 可被文件工具读到（读取放行；**写入仍锁在项目内**）。
- `${LANTAI_SKILL_DIR}` 展开为该技能所在目录的绝对路径。

## 它怎么被用起来

- Agent **每一步**收到一份技能目录摘要（`name` + `description`）；**内容没变不重发**（sha256 digest 控增量），空目录 = 零注入、不占 token。
- 技能**正文**只在 Agent 真调用 `Skill` 工具时读入——所以 `description` 写得好不好，直接决定它会不会被想起来。
- 改完文件**即时生效**（调用时重扫 + 目录缓存），不需要重启，也不需要重装插件。
- 坏文件（YAML 解析失败 / 缺必填 / 名字不合规）**只跳过该技能并给出原因**，不影响其它技能被发现。
- 设置面板「技能」tab 是管理面（列出 / 新建 / 删除）。

## 守卫与联动

- 相关测试：`src-ui/tests/`（技能扫描与发现注入面）；设置面板面见 `SkillsPage`。
- 技能与**插件**是两条独立加面路径：技能是"给 Agent 的说明书"，插件是"给兰台的代码能力"（见 [`adding-a-dynamic-plugin.md`](adding-a-dynamic-plugin.md) 与 [`../plugins/README.md`](../plugins/README.md)）。
