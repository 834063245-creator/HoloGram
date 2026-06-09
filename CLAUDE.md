# CLAUDE.md

**先读 [PROJECT.md](PROJECT.md) — 那是项目施工图。**

## 用户

外行 vibe coder。不看代码。Agent 高速迭代。交互质感对标 Blender。不关心技术实现，关心"改了会不会炸"。跟他沟通用"这个改动很危险"而非术语。

## 项目

代码库依赖拓扑图生成器。Tauri 2 + Python 引擎 + Three.js 3D 星图。引擎 633+ 测试已稳定。

## 约定

- Windows 路径：`location` 用 `\`，提取文件用 `rsplit(":", 1)` 避免破坏 drive letter
- 枚举兼容：`from_json()` 后 type 变字符串，代码同时处理 enum 和 str
- 程序层不做：不解释、不推断、不自动推断因果、不声称找到 bug 根源
- 每完成一个阶段的任务，更新 [PROJECT.md](PROJECT.md) — 它是唯一真相源
- `docs_archive/` 是历史文档，不再维护，不要引
