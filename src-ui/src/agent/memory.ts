// Agent 持久化记忆系统 — 对标 Claude Code MEMORY.md
// 存储位置: .hologram/memory/*.md + MEMORY.md 索引
// 跨会话、跨 session tab 共享

import { invoke } from '../bridge';
import type { Tool } from './tool';

// ── Types ──

/** Parsed entry from MEMORY.md index */
export interface MemoryEntry {
  name: string;       // kebab-case slug, e.g. "user-prefers-concise"
  title: string;      // display title, e.g. "用户偏好简洁回复"
  file: string;       // file name with .md extension
  description: string; // one-line hook from index
}

/** Full memory with parsed frontmatter + body */
export interface MemoryFile {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;    // body only (without frontmatter)
  raw: string;        // full file text
}

// ── MemoryManager ──

export class MemoryManager {
  constructor(private projectPath: string) {}

  private get dir(): string {
    return this.projectPath.replace(/\\/g, '/') + '/.hologram/memory';
  }

  private indexPath(): string {
    return this.dir + '/MEMORY.md';
  }

  private filePath(name: string): string {
    return this.dir + '/' + name + '.md';
  }

  // ── Index ──

  /** Load the raw MEMORY.md text for injection into system prompt. */
  async loadIndexText(): Promise<string> {
    try {
      return await invoke<string>('read_file_content', { file_path: this.indexPath() });
    } catch {
      return '';
    }
  }

  /** Parse MEMORY.md into structured entries. */
  async list(): Promise<MemoryEntry[]> {
    const text = await this.loadIndexText();
    if (!text.trim()) return [];

    const entries: MemoryEntry[] = [];
    const re = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+[—–-]\s+(.+)$/gm;
    for (const m of text.matchAll(re)) {
      entries.push({
        title: m[1],
        file: m[2],
        name: m[2].replace(/\.md$/, ''),
        description: m[3],
      });
    }
    return entries;
  }

  /** Build a compact index line (for adding to MEMORY.md). */
  static formatIndexEntry(entry: MemoryEntry): string {
    return `- [${entry.title}](${entry.file}) — ${entry.description}`;
  }

  // ── Read ──

  /** Read a full memory file by name (without .md). Returns null if not found. */
  async read(name: string): Promise<MemoryFile | null> {
    try {
      const raw = await invoke<string>('read_file_content', { file_path: this.filePath(name) });
      return parseFrontmatter(raw);
    } catch {
      return null;
    }
  }

  // ── Write ──

  /** Save a memory (creates or updates). Also updates MEMORY.md index. */
  async save(
    name: string,
    description: string,
    type: 'user' | 'feedback' | 'project' | 'reference',
    content: string,
  ): Promise<void> {
    // Build frontmatter
    const frontmatter = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      'metadata:',
      `  type: ${type}`,
      '---',
      '',
      content,
    ].join('\n');

    // Write the memory file
    await invoke('write_file_content', {
      file_path: this.filePath(name),
      content: frontmatter,
    });

    // Use the description as the title in the index
    const title = description.length > 40 ? description.slice(0, 39) + '…' : description;

    // Update MEMORY.md index
    await this.upsertIndex(name, title + '.md', description);
  }

  // ── Delete ──

  /** Delete a memory by name. Returns true if deleted, false if not found. */
  async delete(name: string): Promise<boolean> {
    let index = await this.loadIndexText();
    if (!index.trim()) return false;

    // Remove matching line from index
    const pattern = new RegExp(
      `^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(name)}\\.md\\)\\s+[—–-]\\s+.+$\\n?`,
      'm',
    );
    if (!pattern.test(index)) return false;

    index = index.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (index) index += '\n';

    await invoke('write_file_content', {
      file_path: this.indexPath(),
      content: index,
    });

    return true;
  }

  // ── Internal ──

  /** Insert or update a line in MEMORY.md. */
  private async upsertIndex(name: string, file: string, description: string): Promise<void> {
    let index = await this.loadIndexText();
    const newLine = `- [${name}](${file}) — ${description}`;

    // Try to replace existing line for same file
    const pattern = new RegExp(
      `^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(name)}\\.md\\)\\s+[—–-]\\s+.+$`,
      'm',
    );
    if (pattern.test(index)) {
      index = index.replace(pattern, newLine);
    } else {
      // Append
      index = index.trimEnd();
      if (index) index += '\n';
      index += newLine + '\n';
    }

    await invoke('write_file_content', {
      file_path: this.indexPath(),
      content: index,
    });
  }
}

// ── Frontmatter parser ──

function parseFrontmatter(raw: string): MemoryFile {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat entire file as content
    return {
      name: 'unknown',
      description: '',
      type: 'reference',
      content: raw,
      raw,
    };
  }

  const fm = fmMatch[1];
  const body = fmMatch[2].trim();

  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || 'unknown';
  const desc = (fm.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '';
  const typeRaw = (fm.match(/^\s+type:\s*(.+)$/m) || [])[1]?.trim() || 'reference';
  const type = (
    ['user', 'feedback', 'project', 'reference'] as const
  ).includes(typeRaw as any) ? (typeRaw as MemoryFile['type']) : 'reference';

  return { name, description: desc, type, content: body, raw };
}

// ── Helpers ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// ── Agent Tools ──

/** Create Agent tools for memory operations. All operate on the given MemoryManager. */
export function createMemoryTools(mm: MemoryManager): Tool[] {
  return [
    {
      name: () => 'hologram_memory_list',
      description: () =>
        '列出所有已保存的记忆。保存新记忆前，先调用此工具检查是否已有类似记忆——已有则用 hologram_memory_save 更新而非新建。',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async () => {
        const entries = await mm.list();
        if (entries.length === 0) return '暂无已保存的记忆。';
        return entries
          .map((e) => `- **${e.title}** (\`${e.name}\`) — ${e.description}`)
          .join('\n');
      },
    },
    {
      name: () => 'hologram_memory_read',
      description: () =>
        '读取一条已保存的 Agent 记忆的完整内容。当你需要回忆某个具体事实、用户偏好或决策时使用。',
      parameters: () => ({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '记忆名称（不含 .md 扩展名），从 hologram_memory_list 获取',
          },
        },
        required: ['name'],
      }),
      readOnly: () => true,
      execute: async (args) => {
        const name = args.name as string;
        const mf = await mm.read(name);
        if (!mf) return `未找到记忆 "${name}"。用 hologram_memory_list 查看所有记忆。`;
        return `## ${mf.description || mf.name}\n类型: ${mf.type}\n\n${mf.content}`;
      },
    },
    {
      name: () => 'hologram_memory_save',
      description: () =>
        '保存或更新一条记忆。保守使用——只记代码库查不到且未来会话忘了会出错的东西（用户偏好、非显而易见的决策、反馈）。先 hologram_memory_list 检查是否已有类似记忆，有则更新而非新建。不要保存代码结构、文件路径等代码库本身记录的信息。',
      parameters: () => ({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '简短的 kebab-case 名称（只含小写字母数字和连字符），如 "user-prefers-concise"',
          },
          description: {
            type: 'string',
            description: '一句话摘要，用于快速判断是否相关。也是 MEMORY.md 索引的标题。',
          },
          type: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
            description: '记忆类型: user=用户画像, feedback=用户反馈/要求, project=项目决策/进展, reference=外部参考',
          },
          content: {
            type: 'string',
            description: '记忆正文。paragraph 或项目要点均可。对于 feedback/project 类型，应包含 **Why:** 和 **How to apply:** 段落。',
          },
        },
        required: ['name', 'description', 'type', 'content'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const type = args.type as string;
        if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
          return `错误: type 必须是 user/feedback/project/reference，收到了 "${type}"`;
        }
        await mm.save(
          args.name as string,
          args.description as string,
          type as MemoryFile['type'],
          args.content as string,
        );
        return `已保存记忆 "${args.name}"。`;
      },
    },
    {
      name: () => 'hologram_memory_delete',
      description: () =>
        '删除一条已保存的 Agent 记忆。当用户要求忘记某条信息，或某条记忆已过时/错误时使用。',
      parameters: () => ({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要删除的记忆名称（不含 .md 扩展名）',
          },
        },
        required: ['name'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const name = args.name as string;
        const ok = await mm.delete(name);
        return ok
          ? `已删除记忆 "${name}"。`
          : `未找到记忆 "${name}"，可能已被删除。用 hologram_memory_list 查看当前记忆列表。`;
      },
    },
  ];
}
