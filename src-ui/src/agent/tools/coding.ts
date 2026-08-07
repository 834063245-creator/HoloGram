// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════
// MCP 动态工具工厂 — Step 1: 从 MCP tools/list 自动生成
// ═══════════════════════════════════════════════════════
// Coding Tools — 文件 / Shell / 搜索 / Git / Web
// ═══════════════════════════════════════════════════════

import { z } from 'zod';
import type { Tool, ToolExecutor } from '../tool';
import { defineTool } from './define-tool';

/** ask_user 工具的 UI 请求 — 由 workspace 注入的回调转发到 UI 总线。
 *  保持 agent 层不 import ui/ 模块。 */
export interface AskUserRequest {
  id: string;
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  callback: (answer: string[] | null) => void;
}

export interface CodingToolsUI {
  askUser?: (req: AskUserRequest) => void;
}

export function createCodingTools(exec: ToolExecutor, ui?: CodingToolsUI): Tool[] {
  return [
    // ── 用户交互 ──
    defineTool({
      name: 'ask_user',
      description:
        "Ask the user a question when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Returns the user's answer.",
      schema: z.object({
        question: z.string().describe('The question to ask the user. Be specific about what you need to know.'),
        header: z
          .string()
          .describe('Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File"'),
        options: z
          .array(
            z.object({
              label: z.string().describe('Display text (1-5 words)'),
              description: z.string().describe('Explanation of what this option means'),
            }),
          )
          .describe(
            '2-4 predefined choices the user can pick from. Each option has a label and optional description.',
          ),
        multiSelect: z
          .boolean()
          .optional()
          .default(false)
          .describe('Set to true to allow selecting multiple options (default: false)'),
      }),
      readOnly: true,
      execute: async (args) => {
        const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (!ui?.askUser) {
          return JSON.stringify({ answer: null, error: 'ask_user 不可用：UI 未接线' });
        }
        return new Promise((resolve) => {
          ui.askUser?.({
            id,
            question: args.question,
            header: args.header,
            options: args.options,
            multiSelect: args.multiSelect,
            callback: (answer: string[] | null) => {
              if (answer === null) {
                resolve(JSON.stringify({ answer: null }));
              } else if (args.multiSelect) {
                resolve(JSON.stringify({ answers: answer }));
              } else {
                resolve(JSON.stringify({ answer: answer[0] || null }));
              }
            },
          });
        });
      },
    }),

    // ── 文件操作 ──
    defineTool({
      name: 'read_file_content',
      description:
        'Read the content of a file on disk. Returns text in cat -n format (6-digit line number + tab + content). Use offset and limit to read a specific range of lines (0-indexed). Use to inspect source code files when analyzing dependencies or investigating violations.',
      schema: z.object({
        filePath: z.string().describe('Absolute path to the file to read'),
        offset: z.number().int().optional().describe('Line number to start reading from (0-indexed, default: 0)'),
        limit: z.number().int().optional().describe('Maximum number of lines to return (default: all lines)'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('read_file_content', args, onProgress),
    }),
    defineTool({
      name: 'write_file',
      description:
        'Create or overwrite a file with the given content. Creates parent directories if needed. Use to write new files or modify existing ones.',
      schema: z.object({
        filePath: z.string().describe('Absolute path to the file to create or overwrite'),
        content: z.string().describe('Full file content to write'),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) => exec('write_file_content', args, onProgress),
    }),
    defineTool({
      name: 'edit_file',
      description:
        'Perform exact string replacement in a file. The old_string must match exactly (including indentation and whitespace) and must be unique in the file (unless replace_all is true). This is the preferred way to modify code — safer and cheaper than rewriting the entire file.',
      schema: z.object({
        filePath: z.string().describe('Absolute path to the file to modify'),
        oldString: z
          .string()
          .describe('The exact text to find and replace (must match the file exactly, including whitespace)'),
        newString: z.string().describe('The text to replace it with (must be different from oldString)'),
        replaceAll: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times.',
          ),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) =>
        exec(
          'edit_file',
          {
            filePath: args.filePath,
            oldString: args.oldString,
            newString: args.newString,
            replaceAll: args.replaceAll,
          },
          onProgress,
        ),
    }),
    defineTool({
      name: 'list_directory',
      description:
        'List files and subdirectories in a directory (recursive up to 4 levels deep). Returns name, path, type (file/dir), and size for each entry.',
      schema: z.object({
        path: z.string().describe('Absolute path to the directory to list'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('list_directory', args, onProgress),
    }),
    defineTool({
      name: 'read_constraints',
      description:
        'Read the current constraint configuration (hologram.constraints.yaml) for the project. Returns the YAML content. Use to check routing rules, thresholds, and allowlist/denylist settings.',
      schema: z.object({
        projectPath: z.string().describe('Project root directory path'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('read_constraints', args, onProgress),
    }),

    // ── 代码搜索 ──
    defineTool({
      name: 'search_content',
      description:
        'Search for a text pattern across all source files. Supports literal substring (default, case-insensitive) and regex. Returns matching lines with optional context lines, file lists, or counts. Skips binary files, hidden dirs, and build artifacts. Prefer this over run_shell grep — it is faster and respects .gitignore-style exclusions.',
      schema: z.object({
        directory: z.string().describe('Absolute path to the directory to search in'),
        pattern: z.string().describe('Text or regex pattern to search for (case-insensitive)'),
        fileTypes: z
          .string()
          .optional()
          .describe('Optional comma-separated file extensions to filter (e.g. ".ts,.py,.rs")'),
        maxResults: z
          .coerce
          .number()
          .int()
          .max(200)
          .optional()
          .default(50)
          .describe('Maximum number of results to return (default: 50, max: 200)'),
        useRegex: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Set to true to interpret pattern as a regex (e.g. "function\\\\s+\\\\w+"). Default: false (literal substring)',
          ),
        contextLines: z
          .coerce
          .number()
          .int()
          .optional()
          .default(0)
          .describe('Number of context lines before and after each match (like grep -C). Default: 0. Max: 10.'),
        outputMode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .default('content')
          .describe(
            'Output mode: "content" = matching lines with context, "files_with_matches" = just file paths, "count" = match counts per file. Default: content.',
          ),
        showLineNumbers: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include line numbers in output (default: true)'),
        headLimit: z
          .coerce
          .number()
          .int()
          .optional()
          .default(250)
          .describe('Max results/files to return (default: 250, 0 = unlimited)'),
        offset: z
          .coerce
          .number()
          .int()
          .optional()
          .default(0)
          .describe('Skip first N results for pagination (default: 0)'),
        globFilter: z
          .string()
          .optional()
          .describe('Additional glob filter on file paths (e.g. "**/*.rs", "src/**/*.ts")'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('search_content', args, onProgress),
    }),

    // ── Glob 文件匹配 ──
    defineTool({
      name: 'glob',
      description:
        'Fast file pattern matching using glob patterns. Returns matching file paths sorted by modification time. Supports ** for recursive matching (e.g. "**/*.rs", "src/**/*.ts", "*.json"). Use this instead of run_shell to find files by name pattern — it is faster and respects .gitignore-style exclusions.',
      schema: z.object({
        pattern: z
          .string()
          .describe('Glob pattern to match file paths against (e.g. "**/*.rs", "src/**/agent*.ts", "*.json")'),
        path: z.string().optional().describe('Directory to search in. Defaults to the current workspace root.'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('glob', args, onProgress),
    }),

    // ── Shell ──
    defineTool({
      name: 'run_shell',
      description:
        'Execute a shell command and return stdout + stderr. Default timeout 5 min (max 10 min). For long-running commands (builds, servers, watch modes), set runInBackground: true and use bash_output to check progress, bash_wait to wait for completion, or bash_kill to stop. Commands run in the current workspace root by default. IMPORTANT: Do NOT use run_shell for file search, code search, or git operations — use glob (file patterns), search_content (text search), list_directory (directory listing), and the dedicated git_* tools (git_status, git_diff, git_stage, git_commit, git_push, git_pull, git_log, git_checkout, git_create_branch, etc.) instead. run_shell is ONLY for building and testing commands (npm test, cargo build, pytest, etc.).',
      schema: z.object({
        command: z.string().describe('The shell command to run (e.g. "npm test", "cargo build", "pytest -x")'),
        cwd: z
          .string()
          .optional()
          .describe('Optional working directory for the command. Defaults to the current workspace root.'),
        timeoutMs: z
          .coerce
          .number()
          .int()
          .max(600000)
          .optional()
          .default(300000)
          .describe('Timeout in milliseconds (default: 300000 = 5 min, max: 600000 = 10 min)'),
        runInBackground: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Set to true to run in background (returns job ID immediately). Use bash_output(id) to check progress, bash_wait(id) to wait for completion, bash_kill(id) to stop.',
          ),
      }),
      execute: (args, onProgress) => exec('exec_command', args, onProgress),
    }),

    // ── Shell: 后台任务管理 ──
    defineTool({
      name: 'bash_output',
      description:
        'Check the output of a background shell job. Returns accumulated stdout/stderr and whether the job is still running or has completed.',
      schema: z.object({
        jobId: z
          .coerce
          .number()
          .int()
          .describe('The job ID returned by run_shell with runInBackground: true'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('bash_output', { jobId: args.jobId }, onProgress),
    }),
    defineTool({
      name: 'bash_kill',
      description: 'Kill a running background shell job and return any accumulated output.',
      schema: z.object({
        jobId: z
          .coerce
          .number()
          .int()
          .describe('The job ID returned by run_shell with runInBackground: true'),
      }),
      execute: (args, onProgress) => exec('bash_kill', { jobId: args.jobId }, onProgress),
    }),
    defineTool({
      name: 'bash_wait',
      description:
        'Block until a background shell job completes (or timeout), then return full output + exit code. Use after run_shell with runInBackground: true to wait for a long-running task.',
      schema: z.object({
        jobId: z
          .coerce
          .number()
          .int()
          .describe('The job ID returned by run_shell with runInBackground: true'),
        timeoutMs: z
          .coerce
          .number()
          .int()
          .optional()
          .describe('Maximum wait time in milliseconds (default: 60000 = 60s, max: 600000 = 10min)'),
      }),
      readOnly: true,
      execute: (args, onProgress) =>
        exec('bash_wait', { jobId: args.jobId, timeoutMs: args.timeoutMs }, onProgress),
    }),

    // ── Git ──
    defineTool({
      name: 'git_status',
      description:
        'Get the current git status — branch name, ahead/behind count, and list of changed files with their status (modified, added, deleted, untracked).',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository root'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('git_status', args, onProgress),
    }),
    defineTool({
      name: 'git_diff',
      description:
        'Show the git diff for changed files. Returns unified diff output. Use to review changes before committing.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository root'),
        file: z
          .string()
          .optional()
          .default('.')
          .describe('Optional: specific file to diff. If omitted, shows all unstaged changes.'),
        staged: z
          .boolean()
          .optional()
          .default(false)
          .describe('Set to true to show staged changes instead of unstaged'),
      }),
      readOnly: true,
      execute: async (args, onProgress) => {
        const staged = args.staged;
        return exec(
          staged ? 'git_diff_staged' : 'git_diff_unstaged',
          {
            path: args.path,
            file: args.file,
          },
          onProgress,
        );
      },
    }),
    defineTool({
      name: 'git_log',
      description:
        'Show recent git commit history. Returns structured JSON with commit hash, message, author, and date for each commit.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository root'),
        count: z
          .coerce.number()
          .int()
          .optional()
          .default(10)
          .describe('Number of recent commits to show (default: 10)'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('git_log', { path: args.path, count: args.count }, onProgress),
    }),
    defineTool({
      name: 'git_stage',
      description: 'Stage files for commit. Use before git_commit to add changes to the staging area.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository root'),
        files: z
          .string()
          .describe('File path(s) to stage, separated by commas. Use "." to stage all.'),
      }),
      execute: async (args, onProgress) => {
        const files = args.files.trim();
        if (files === '.' || files === 'all') {
          return exec('git_stage_all', { path: args.path }, onProgress);
        }
        // 暂存单个文件
        const fileList = files.split(',').map((f) => f.trim());
        const results: string[] = [];
        for (const f of fileList) {
          const r = await exec('git_stage', { path: args.path, files: [f] }, onProgress);
          results.push(r);
        }
        return results.join('\n');
      },
    }),
    defineTool({
      name: 'git_commit',
      description:
        'Commit staged changes with a message. Files must be staged first with git_stage. Returns the commit hash.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository root'),
        message: z.string().describe('Commit message (conventional commits format recommended)'),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) => exec('git_commit', { path: args.path, message: args.message }, onProgress),
    }),
    defineTool({
      name: 'git_push',
      description: 'Push committed changes to the remote repository.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository root'),
      }),
      execute: (args, onProgress) => exec('git_push', { path: args.path }, onProgress),
    }),
    defineTool({
      name: 'git_pull',
      description: 'Pull latest changes from the remote repository (fast-forward only, no merge conflicts).',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository root'),
      }),
      execute: (args, onProgress) => exec('git_pull', { path: args.path }, onProgress),
    }),

    // ── Web Search — 已禁用 (2026-07)
    // DDG HTML scrape 被反爬封锁，Bing 中文结果不可用，国内无免费搜索 API。
    // 保留代码骨架，待有可用后端时恢复。
    // 启用步骤: 1) 取消注释 2) Rust 端接 Brave/Tavily/SearXNG API

    // ── Web 抓取 ──
    defineTool({
      name: 'web_fetch',
      description:
        'Fetch a URL and return its text content. HTML pages are reduced to readable text (scripts, styles, tags stripped). JSON / plain text / markdown pass through verbatim. Use to read documentation, API responses, or source files hosted on the web. 15s timeout, 1 MiB max.',
      schema: z.object({
        url: z.string().describe('The URL to fetch (HTTPS or HTTP only)'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('web_fetch', args, onProgress),
    }),

    // ── Phase 2a: 文件操作（Tauri 命令已存在） ──
    defineTool({
      name: 'delete_file',
      description:
        'Delete a file or directory at the specified path. Use to clean up temporary files or remove unwanted code. DANGEROUS — cannot be undone. Verify with user if deleting important files.',
      schema: z.object({
        path: z.string().describe('Absolute path to the file or directory to delete'),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) => exec('delete_file_or_dir', args, onProgress),
    }),
    defineTool({
      name: 'create_directory',
      description:
        'Create a new directory (and any missing parent directories). Use before writing new files into a directory that may not exist yet.',
      schema: z.object({
        path: z.string().describe('Absolute path to the directory to create'),
      }),
      execute: (args, onProgress) => exec('create_directory', args, onProgress),
    }),
    defineTool({
      name: 'move_file',
      description: 'Move or rename a file or directory. The destination path determines the new name/location.',
      schema: z.object({
        from: z.string().describe('Source path'),
        to: z.string().describe('Destination path'),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) => exec('move_file', args, onProgress),
    }),
    defineTool({
      name: 'rename_file',
      description:
        'Rename a file or directory (keep it in the same parent directory). For moving to a different directory, use move_file instead.',
      schema: z.object({
        path: z.string().describe('Absolute path to the file/directory to rename'),
        new_name: z.string().describe('New name (not path, just the name)'),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) =>
        exec('rename_file_or_dir', { filePath: args.path, newName: args.new_name }, onProgress),
    }),

    // ── Phase 2b: Git 操作（Tauri 命令已存在） ──
    defineTool({
      name: 'git_init',
      description: 'Initialize a new git repository in the given directory.',
      schema: z.object({
        path: z.string().describe('Absolute path to the directory'),
      }),
      execute: (args, onProgress) => exec('git_init', args, onProgress),
    }),
    defineTool({
      name: 'git_checkout',
      description: 'Switch to a different branch. Use git_create_branch first if the branch does not exist.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository'),
        branch: z.string().describe('Branch name to switch to'),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) => exec('git_checkout', args, onProgress),
    }),
    defineTool({
      name: 'git_create_branch',
      description:
        'Create a new git branch from the current HEAD. Does NOT switch to it — use git_checkout after.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository'),
        branch: z.string().describe('New branch name'),
      }),
      execute: (args, onProgress) => exec('git_create_branch', args, onProgress),
    }),
    defineTool({
      name: 'git_discard',
      description:
        'Discard unstaged changes to a file (git checkout -- <file>). Loses all uncommitted modifications.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository'),
        file: z.string().describe('File path to discard changes for (relative to repo root)'),
        _forceGate: z
          .boolean()
          .optional()
          .describe('Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.'),
      }),
      execute: (args, onProgress) => exec('git_discard', args, onProgress),
    }),
    defineTool({
      name: 'git_stash_push',
      description: 'Stash current uncommitted changes. Use before switching branches with dirty working tree.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository'),
        message: z.string().optional().describe('Optional stash message for identification'),
      }),
      execute: (args, onProgress) => exec('git_stash_push', args, onProgress),
    }),
    defineTool({
      name: 'git_stash_pop',
      description:
        'Restore the most recently stashed changes. Pops the stash — the changes are applied and the stash entry is removed.',
      schema: z.object({
        path: z.string().describe('Absolute path to the git repository'),
      }),
      execute: (args, onProgress) => exec('git_stash_pop', args, onProgress),
    }),

    // ── Phase 2c: Agent Worktree 隔离（Tauri 命令已存在） ──
    defineTool({
      name: 'agent_isolation_create',
      description:
        'Create an isolated git worktree for a sub-agent to work in. Returns the isolation path. Use before spawning a sub-agent that mutates files — prevents conflicts when multiple agents modify the same repo concurrently.',
      schema: z.object({
        agent_id: z.string().describe('Identifier for this isolation workspace'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_create', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_diff',
      description: 'Show the diff of changes made in an isolation workspace.',
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to diff'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('agent_isolation_diff', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_merge',
      description: 'Merge changes from an isolation workspace back into the main repository.',
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to merge'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_merge', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_discard',
      description:
        "Discard an isolation workspace and delete its worktree. Use when the sub-agent's changes are no longer needed.",
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to discard'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_discard', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_status',
      description: 'List all isolation workspaces and their current status.',
      schema: z.object({}),
      readOnly: true,
      execute: (args, onProgress) => exec('agent_isolation_status', args, onProgress),
    }),
  ];
}
