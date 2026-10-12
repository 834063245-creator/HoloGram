// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// fs 域收口（2026-09-04）的测试 mock 共享层——内存文件系统实现站到
// rpc-contract 的具名 fs helper 上（不再拦 bridge + legacyRpcShim 翻信封）。
import { vi } from 'vitest';
//
// 背景：业务模块（goal-manager / board-persistence / spill / canvas-store /
// chat-session / message-store …）统一经 rpc-contract 的 kernel* 具名 helper
// 读盘。helper 内部直呼 fs_cap 能力口（typedRpc('fs_cap', {action,…})），
// 是模块内闭包真绑定——vi.mock bridge 的 typedRpc 拦不住，只有把 mock 面站到
// 具名 helper 导出上才能让业务 I/O 命中内存实现。
//
// 用法（vi.mock 工厂内）：
//   vi.mock('../src/rpc-contract', async (importOriginal) => {
//     const actual = await importOriginal<typeof import('../src/rpc-contract')>();
//     const kernelFs = createKernelFsMock();
//     return { ...actual, ...kernelFs.overrides };
//   });
//
// 工厂体内不得解引用任何模块顶层 const（TDZ——vi.mock 工厂在 import 期
// 执行，引用晚声明的 const 会抛 ReferenceError）；也不能引用本模块顶层
// 的 let/const。全部状态（内存 Map / 捕获记录 / 失败注入）都放在返回的
// MockFs 实例上，由 createKernelFsMock() 每次调用新建。
//
// 跨用例访问/断言：测试用 vi.hoisted 建载体，工厂把实例挂上去：
//   const H = vi.hoisted(() => ({ kernelFs: null as null | ReturnType<typeof createKernelFsMock> }));
//   vi.mock('../src/rpc-contract', async (importOriginal) => {
//     const actual = await importOriginal<typeof import('../src/rpc-contract')>();
//     H.kernelFs = createKernelFsMock();
//     return { ...actual, ...H.kernelFs.overrides };
//   });
// 用例内（mock 已注册后）经 H.kernelFs 访问 fs/files/捕获。
//
// helper 契约（与 rpc-contract 实现逐字对齐）：
//   kernelWriteFile(filePath, content)      → path
//   kernelCreateDirectory(path)             → path
//   kernelDeleteFile(path)                  → path
//   kernelReadFile(p, opts?)                → 原文（mock 不做行号格式）
//   kernelReadFileRaw(p)                    → 原文
//   kernelListDirectory(p, filterIgnored?)  → DirEntry[]
//   kernelListDirectoryFlat(p)              → DirEntry[]
//   kernelLogAppend(p, content)             → p（content 追加）
//   kernelReadMemoryBatch(paths)            → Record<path, content|null>
//   kernelGlobalMemoryDir()                 → '~/.lantai/global_memory'
//   kernelReadFileBase64(p)                 → base64(UTF-8 p 内容)
//
// 缺失语义：read/delete 对不存在路径抛错（与 fs_cap 真实现一致——消费方
// 各自 catch 降级）；kernelReadMemoryBatch 对缺失路径记 null；list 对不存在
// 目录返回 []（真实现 read_dir Err → 空）。

/** DirEntry 形状（与 rpc-contract 的 dirEntrySchema 对齐）。 */
export interface MockDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: MockDirEntry[] | null;
}

/** 写调用捕获记录（供断言——键名 = fs_cap/manifest 的 file_path+content）。 */
export interface WriteCapture {
  file_path: string;
  content: string;
}

/** list_directory 调用捕获（供断言 filterIgnored 等参数）。 */
export interface ListCapture {
  path: string;
  filterIgnored: boolean;
}

/** 内存文件系统（平铺 Map + 目录集合 + 写调用捕获）。 */
export class MockFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  /** 全部写调用（kernelWriteFile）记录——断言面在 helper 层读记录。 */
  writes: WriteCapture[] = [];
  /** 全部 list 调用（kernelListDirectory/Flat）记录。 */
  lists: ListCapture[] = [];
  /** 全部日志轮转调用（kernelLogRotate）记录——批 4 断言面。 */
  logRotates: string[] = [];
  /** 可编程失败注入：返回错误字符串则抛错。缺省 = 成功。 */
  fail: { createDir?: string; write?: string; read?: string; delete?: string; list?: string; rotate?: string } = {};

  /** 目录确保存在（含父级）。幂等。 */
  private ensureDir(p: string): void {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (this.dirs.has(norm) || norm === '') return;
    const parent = norm.slice(0, norm.lastIndexOf('/'));
    if (parent) this.ensureDir(parent);
    this.dirs.add(norm);
  }

  /** 写文件前确保父目录存在（真后端 create_dir_all 语义）。 */
  private touchParents(filePath: string): void {
    const norm = filePath.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    if (idx > 0) this.ensureDir(norm.slice(0, idx));
  }

  /** 目录的一层条目（对应 list_dir_flat）。隐藏 VCS 目录。 */
  listFlat(dir: string): MockDirEntry[] {
    const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    const seen = new Map<string, MockDirEntry>();
    for (const f of this.files.keys()) {
      const norm = f.replace(/\\/g, '/');
      if (!norm.startsWith(d + '/')) continue;
      const rest = norm.slice(d.length + 1);
      if (rest === '') continue;
      const seg = rest.split('/')[0];
      if (!seen.has(seg)) {
        const isDir = rest.includes('/');
        seen.set(seg, { name: seg, path: `${d}/${seg}`, is_dir: isDir, children: null });
      }
    }
    for (const dd of this.dirs) {
      const norm = dd.replace(/\\/g, '/');
      if (!norm.startsWith(d + '/')) continue;
      const seg = norm.slice(d.length + 1).split('/')[0];
      if (seg === '' || seg === '.git' || seg === '.hg' || seg === '.svn') continue;
      if (!seen.has(seg)) {
        seen.set(seg, { name: seg, path: `${d}/${seg}`, is_dir: true, children: null });
      }
    }
    const out = [...seen.values()];
    out.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
    return out;
  }

  /** 预置一个文件（自动建父目录）。测试夹具用。 */
  setFile(filePath: string, content: string): void {
    const p = String(filePath).replace(/\\/g, '/');
    this.touchParents(p);
    this.files.set(p, String(content));
  }
}

/** 构建 rpc-contract 覆写层。每次调用新建独立 MockFs（规避 TDZ）。
 *  wrapWithSpies=true（chat-session 等队列喂数场景用）：helper 包成
 *  vi.fn(async (...args) => impl)，支持用例期 mockResolvedValueOnce 出队
 *  （vitest vi.fn 出队优先，无队回落默认 impl）——内存盘语义不变。 */
export function createKernelFsMock(opts?: { wrapWithSpies?: boolean }): {
  fs: MockFs;
  overrides: Record<string, unknown>;
} {
  const wrap = opts?.wrapWithSpies ?? false;
  const fs = new MockFs();

  const kernelWriteFile = async (filePath: string, content: string): Promise<string> => {
    if (fs.fail.write) throw new Error(fs.fail.write);
    const p = String(filePath).replace(/\\/g, '/');
    fs.touchParents(p);
    fs.files.set(p, String(content));
    fs.writes.push({ file_path: p, content: String(content) });
    return p;
  };

  const kernelCreateDirectory = async (path: string): Promise<string> => {
    if (fs.fail.createDir) throw new Error(fs.fail.createDir);
    const p = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
    fs.ensureDir(p);
    return p;
  };

  const kernelDeleteFile = async (path: string): Promise<string> => {
    if (fs.fail.delete) throw new Error(fs.fail.delete);
    const p = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
    for (const k of [...fs.files.keys()]) {
      if (k === p || k.startsWith(p + '/')) fs.files.delete(k);
    }
    for (const d of [...fs.dirs]) {
      if (d === p || d.startsWith(p + '/')) fs.dirs.delete(d);
    }
    return p;
  };

  const kernelReadFile = async (filePath: string, _opts?: { raw?: boolean }): Promise<string> => {
    if (fs.fail.read) throw new Error(fs.fail.read);
    const p = String(filePath).replace(/\\/g, '/');
    const v = fs.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${filePath}`);
    return v;
  };

  const kernelReadFileRaw = async (filePath: string): Promise<string> => kernelReadFile(filePath, { raw: true });

  const kernelListDirectory = async (path: string, filterIgnored = true): Promise<MockDirEntry[]> => {
    fs.lists.push({ path: String(path), filterIgnored });
    if (fs.fail.list) throw new Error(fs.fail.list);
    return fs.listFlat(String(path));
  };

  const kernelListDirectoryFlat = async (path: string): Promise<MockDirEntry[]> => {
    fs.lists.push({ path: String(path), filterIgnored: true });
    if (fs.fail.list) throw new Error(fs.fail.list);
    return fs.listFlat(String(path));
  };

  const kernelLogAppend = async (path: string, content: string): Promise<string> => {
    if (fs.fail.write) throw new Error(fs.fail.write);
    const p = String(path).replace(/\\/g, '/');
    fs.touchParents(p);
    fs.files.set(p, (fs.files.get(p) ?? '') + String(content));
    return p;
  };

  /** 日志轮转（批 4）：记录“被要求过轮转”（断言面）+ 可注入失败。真实现的
   *  滚代在壳侧（大小判据/代数都在那里的单一真源），内存 mock 不模拟文件滚动。 */
  const kernelLogRotate = async (path: string): Promise<{ rotated: boolean; size_before: number }> => {
    if (fs.fail.rotate) throw new Error(fs.fail.rotate);
    fs.logRotates.push(String(path).replace(/\\/g, '/'));
    return { rotated: false, size_before: 0 };
  };

  /** 事件日志写面（Phase 1 换轨）：durable append——与 kernelWriteFile 同记账，
   *  但语义是**追加**（真实现 = O_APPEND + fsync，失败回滚到写入前 size）。 */
  const kernelAppendFileDurable = async (filePath: string, content: string): Promise<string> => {
    if (fs.fail.write) throw new Error(fs.fail.write);
    const p = String(filePath).replace(/\\/g, '/');
    fs.touchParents(p);
    fs.files.set(p, (fs.files.get(p) ?? '') + String(content));
    fs.writes.push({ file_path: p, content: String(content) });
    return p;
  };

  /** 断尾修复原语：截到**字节**偏移（与 Rust `truncate_file` 同语义——生产按字节，
   *  故这里按 UTF-8 编解码切片，不能用 String.slice 的 UTF-16 单位；扫描器只在
   *  行边界截断，因此不会切进多字节字符中间）。 */
  const kernelTruncateFile = async (filePath: string, offset: number): Promise<string> => {
    if (fs.fail.write) throw new Error(fs.fail.write);
    const p = String(filePath).replace(/\\/g, '/');
    const cur = fs.files.get(p) ?? '';
    const bytes = new TextEncoder().encode(cur);
    if (offset > bytes.length) throw new Error(`truncate: offset ${offset} exceeds length ${bytes.length}`);
    fs.files.set(p, new TextDecoder().decode(bytes.slice(0, offset)));
    return p;
  };

  const kernelReadMemoryBatch = async (paths: string[]): Promise<Record<string, string | null>> => {
    const out: Record<string, string | null> = {};
    for (const p of paths) {
      out[p] = fs.files.get(String(p).replace(/\\/g, '/')) ?? null;
    }
    return out;
  };

  const kernelGlobalMemoryDir = async (): Promise<string> => '~/.lantai/global_memory';

  const kernelReadFileBase64 = async (filePath: string): Promise<string> => {
    if (fs.fail.read) throw new Error(fs.fail.read);
    const v = fs.files.get(String(filePath).replace(/\\/g, '/'));
    if (v === undefined) throw new Error(`ENOENT: ${filePath}`);
    return btoa(v); // jsdom 有 btoa
  };

  const overrides: Record<string, unknown> = {
    kernelWriteFile,
    kernelCreateDirectory,
    kernelDeleteFile,
    kernelReadFile,
    kernelReadFileRaw,
    kernelListDirectory,
    kernelListDirectoryFlat,
    kernelLogAppend,
    kernelLogRotate,
    kernelAppendFileDurable,
    kernelTruncateFile,
    kernelReadMemoryBatch,
    kernelGlobalMemoryDir,
    kernelReadFileBase64,
  };
  if (wrap) {
    // vi.fn(async (...args)) 包装：默认实现 = 上方内存 impl；用例期可
    // mockResolvedValueOnce/mockImplementation 覆写（出队/路由优先）。
    for (const key of Object.keys(overrides)) {
      const impl = overrides[key] as (...args: unknown[]) => unknown;
      overrides[key] = vi.fn(async (...args: unknown[]) => impl(...args));
    }
  }
  return { fs, overrides };
}
