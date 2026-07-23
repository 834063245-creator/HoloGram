// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════
// MCP 动态工具工厂 — Step 1: 从 MCP tools/list 自动生成
// ═══════════════════════════════════════════════════════
// Coding Tools — 文件 / Shell / 搜索 / Git / Web
// ═══════════════════════════════════════════════════════

import type { Provider } from '../../provider/types';
import type { Tool, ToolExecutor } from '../tool';

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

export function createCodingTools(exec: ToolExecutor, _provider?: Provider, ui?: CodingToolsUI): Tool[] {
  return [
    // ── User Interaction ──
    {
      name: () => 'ask_user',
      description: () =>
        "Ask the user a question when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Returns the user's answer.",
      parameters: () => ({
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user. Be specific about what you need to know.',
          },
          header: {
            type: 'string',
            description: 'Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File"',
          },
          options: {
            type: 'array',
            description:
              '2-4 predefined choices the user can pick from. Each option has a label and optional description.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Display text (1-5 words)' },
                description: { type: 'string', description: 'Explanation of what this option means' },
              },
              required: ['label', 'description'],
            },
          },
          multiSelect: {
            type: 'boolean',
            description: 'Set to true to allow selecting multiple options (default: false)',
            default: false,
          },
        },
        required: ['question', 'header', 'options'],
      }),
      readOnly: () => true,
      execute: async (args) => {
        const question = args.question as string;
        const header = args.header as string;
        const options = (args.options || []) as { label: string; description: string }[];
        const multiSelect = args.multiSelect === true;
        const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (!ui?.askUser) {
          return JSON.stringify({ answer: null, error: 'ask_user 不可用：UI 未接线' });
        }
        return new Promise((resolve) => {
          ui.askUser?.({
            id,
            question,
            header,
            options,
            multiSelect,
            callback: (answer: string[] | null) => {
              if (answer === null) {
                resolve(JSON.stringify({ answer: null }));
              } else if (multiSelect) {
                resolve(JSON.stringify({ answers: answer }));
              } else {
                resolve(JSON.stringify({ answer: answer[0] || null }));
              }
            },
          });
        });
      },
    },

    // ── File Operations ──
    {
      name: () => 'read_file_content',
      description: () =>
        'Read the content of a file on disk. Returns text in cat -n format (6-digit line number + tab + content). Use offset and limit to read a specific range of lines (0-indexed). Use to inspect source code files when analyzing dependencies or investigating violations.',
      parameters: () => ({
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
          offset: {
            type: 'integer',
            description: 'Line number to start reading from (0-indexed, default: 0)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of lines to return (default: all lines)',
          },
        },
        required: ['filePath'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('read_file_content', args, onProgress),
    },
    {
      name: () => 'write_file',
      description: () =>
        'Create or overwrite a file with the given content. Creates parent directories if needed. Use to write new files or modify existing ones.',
      parameters: () => ({
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file to create or overwrite',
          },
          content: {
            type: 'string',
            description: 'Full file content to write',
          },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['filePath', 'content'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('write_file_content', args, onProgress),
    },
    {
      name: () => 'edit_file',
      description: () =>
        'Perform exact string replacement in a file. The old_string must match exactly (including indentation and whitespace) and must be unique in the file (unless replace_all is true). This is the preferred way to modify code — safer and cheaper than rewriting the entire file.',
      parameters: () => ({
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file to modify',
          },
          oldString: {
            type: 'string',
            description: 'The exact text to find and replace (must match the file exactly, including whitespace)',
          },
          newString: {
            type: 'string',
            description: 'The text to replace it with (must be different from oldString)',
          },
          replaceAll: {
            type: 'boolean',
            description:
              'Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times.',
            default: false,
          },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['filePath', 'oldString', 'newString'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) =>
        exec('edit_file', {
          filePath: args.filePath,
          oldString: args.oldString,
          newString: args.newString,
          replaceAll: args.replaceAll,
        }, onProgress),
    },
    {
      name: () => 'list_directory',
      description: () =>
        'List files and subdirectories in a directory (recursive up to 4 levels deep). Returns name, path, type (file/dir), and size for each entry.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory to list',
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('list_directory', args, onProgress),
    },
    {
      name: () => 'read_constraints',
      description: () =>
        'Read the current constraint configuration (hologram.constraints.yaml) for the project. Returns the YAML content. Use to check routing rules, thresholds, and allowlist/denylist settings.',
      parameters: () => ({
        type: 'object',
        properties: {
          projectPath: {
            type: 'string',
            description: 'Project root directory path',
          },
        },
        required: ['projectPath'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('read_constraints', args, onProgress),
    },

    // ── Code Search ──
    {
      name: () => 'search_content',
      description: () =>
        'Search for a text pattern across all source files. Supports literal substring (default, case-insensitive) and regex. Returns matching lines with optional context lines, file lists, or counts. Skips binary files, hidden dirs, and build artifacts. Prefer this over run_shell grep — it is faster and respects .gitignore-style exclusions.',
      parameters: () => ({
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Absolute path to the directory to search in',
          },
          pattern: {
            type: 'string',
            description: 'Text or regex pattern to search for (case-insensitive)',
          },
          fileTypes: {
            type: 'string',
            description: 'Optional comma-separated file extensions to filter (e.g. ".ts,.py,.rs")',
          },
          maxResults: {
            type: 'integer',
            description: 'Maximum number of results to return (default: 50, max: 200)',
            default: 50,
          },
          useRegex: {
            type: 'boolean',
            description:
              'Set to true to interpret pattern as a regex (e.g. "function\\\\s+\\\\w+"). Default: false (literal substring)',
            default: false,
          },
          contextLines: {
            type: 'integer',
            description: 'Number of context lines before and after each match (like grep -C). Default: 0. Max: 10.',
            default: 0,
          },
          outputMode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description:
              'Output mode: "content" = matching lines with context, "files_with_matches" = just file paths, "count" = match counts per file. Default: content.',
            default: 'content',
          },
          showLineNumbers: {
            type: 'boolean',
            description: 'Include line numbers in output (default: true)',
            default: true,
          },
          headLimit: {
            type: 'integer',
            description: 'Max results/files to return (default: 250, 0 = unlimited)',
            default: 250,
          },
          offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)', default: 0 },
          globFilter: {
            type: 'string',
            description: 'Additional glob filter on file paths (e.g. "**/*.rs", "src/**/*.ts")',
          },
        },
        required: ['directory', 'pattern'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('search_content', args, onProgress),
    },

    // ── Glob ──
    {
      name: () => 'glob',
      description: () =>
        'Fast file pattern matching using glob patterns. Returns matching file paths sorted by modification time. Supports ** for recursive matching (e.g. "**/*.rs", "src/**/*.ts", "*.json"). Use this instead of run_shell to find files by name pattern — it is faster and respects .gitignore-style exclusions.',
      parameters: () => ({
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match file paths against (e.g. "**/*.rs", "src/**/agent*.ts", "*.json")',
          },
          path: {
            type: 'string',
            description: 'Directory to search in. Defaults to the project root.',
          },
        },
        required: ['pattern'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('glob', args, onProgress),
    },

    // ── Shell ──
    {
      name: () => 'run_shell',
      description: () =>
        'Execute a shell command and return stdout + stderr. Default timeout 5 min (max 10 min). For long-running commands (builds, servers, watch modes), set runInBackground: true and use bash_output to check progress and bash_kill to stop. Commands run in the project directory by default. IMPORTANT: Do NOT use run_shell for file search, code search, or git operations — use glob (file patterns), search_content (text search), list_directory (directory listing), and the dedicated git_* tools (git_status, git_diff, git_stage, git_commit, git_push, git_pull, git_log, git_checkout, git_create_branch, etc.) instead. run_shell is ONLY for building and testing commands (npm test, cargo build, pytest, etc.).',
      parameters: () => ({
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run (e.g. "npm test", "cargo build", "pytest -x")',
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory for the command. Defaults to the HoloGram project root.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Timeout in milliseconds (default: 300000 = 5 min, max: 600000 = 10 min)',
            default: 300000,
          },
          runInBackground: {
            type: 'boolean',
            description:
              'Set to true to run in background (returns job ID immediately). Use bash_output(id) to check progress, bash_kill(id) to stop.',
            default: false,
          },
        },
        required: ['command'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('exec_command', args, onProgress),
    },

    // ── Shell: Background job management ──
    {
      name: () => 'bash_output',
      description: () =>
        'Check the output of a background shell job. Returns accumulated stdout/stderr and whether the job is still running or has completed.',
      parameters: () => ({
        type: 'object',
        properties: {
          jobId: {
            type: 'integer',
            description: 'The job ID returned by run_shell with runInBackground: true',
          },
        },
        required: ['jobId'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('bash_output', { jobId: args.jobId }, onProgress),
    },
    {
      name: () => 'bash_kill',
      description: () => 'Kill a running background shell job and return any accumulated output.',
      parameters: () => ({
        type: 'object',
        properties: {
          jobId: {
            type: 'integer',
            description: 'The job ID returned by run_shell with runInBackground: true',
          },
        },
        required: ['jobId'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('bash_kill', { jobId: args.jobId }, onProgress),
    },

    // ── Git ──
    {
      name: () => 'git_status',
      description: () =>
        'Get the current git status — branch name, ahead/behind count, and list of changed files with their status (modified, added, deleted, untracked).',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('git_status', args, onProgress),
    },
    {
      name: () => 'git_diff',
      description: () =>
        'Show the git diff for changed files. Returns unified diff output. Use to review changes before committing.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          file: {
            type: 'string',
            description: 'Optional: specific file to diff. If omitted, shows all unstaged changes.',
            default: '.',
          },
          staged: {
            type: 'boolean',
            description: 'Set to true to show staged changes instead of unstaged',
            default: false,
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: async (args, onProgress) => {
        const staged = args.staged === true;
        return exec(staged ? 'git_diff_staged' : 'git_diff_unstaged', {
          path: args.path,
          file: args.file || '.',
        }, onProgress);
      },
    },
    {
      name: () => 'git_log',
      description: () =>
        'Show recent git commit history. Returns structured JSON with commit hash, message, author, and date for each commit.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          count: {
            type: 'integer',
            description: 'Number of recent commits to show (default: 10)',
            default: 10,
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('git_log', { path: args.path, count: args.count || 10 }, onProgress),
    },
    {
      name: () => 'git_stage',
      description: () => 'Stage files for commit. Use before git_commit to add changes to the staging area.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          files: {
            type: 'string',
            description: 'File path(s) to stage, separated by commas. Use "." to stage all.',
          },
        },
        required: ['path', 'files'],
      }),
      readOnly: () => false,
      execute: async (args, onProgress) => {
        const filesRaw = args.files as string | undefined;
        if (!filesRaw) return 'error: files argument is required';
        const files = filesRaw.trim();
        if (files === '.' || files === 'all') {
          return exec('git_stage_all', { path: args.path }, onProgress);
        }
        // Stage individual files
        const fileList = files.split(',').map((f) => f.trim());
        const results: string[] = [];
        for (const f of fileList) {
          const r = await exec('git_stage', { path: args.path, files: [f] }, onProgress);
          results.push(r);
        }
        return results.join('\n');
      },
    },
    {
      name: () => 'git_commit',
      description: () =>
        'Commit staged changes with a message. Files must be staged first with git_stage. Returns the commit hash.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          message: {
            type: 'string',
            description: 'Commit message (conventional commits format recommended)',
          },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['path', 'message'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_commit', { path: args.path, message: args.message }, onProgress),
    },
    {
      name: () => 'git_push',
      description: () => 'Push committed changes to the remote repository.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_push', { path: args.path }, onProgress),
    },
    {
      name: () => 'git_pull',
      description: () => 'Pull latest changes from the remote repository (fast-forward only, no merge conflicts).',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_pull', { path: args.path }, onProgress),
    },

    // ── Web Search — 已禁用 (2026-07)
    // DDG HTML scrape 被反爬封锁，Bing 中文结果不可用，国内无免费搜索 API。
    // 保留代码骨架，待有可用后端时恢复。
    // 启用步骤: 1) 取消注释 2) Rust 端接 Brave/Tavily/SearXNG API

    // ── Web Fetch ──
    {
      name: () => 'web_fetch',
      description: () =>
        'Fetch a URL and return its text content. HTML pages are reduced to readable text (scripts, styles, tags stripped). JSON / plain text / markdown pass through verbatim. Use to read documentation, API responses, or source files hosted on the web. 15s timeout, 1 MiB max.',
      parameters: () => ({
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch (HTTPS or HTTP only)',
          },
        },
        required: ['url'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('web_fetch', args, onProgress),
    },

    // ── Phase 2a: File Operations (Tauri commands already exist) ──
    {
      name: () => 'delete_file',
      description: () =>
        'Delete a file or directory at the specified path. Use to clean up temporary files or remove unwanted code. DANGEROUS — cannot be undone. Verify with user if deleting important files.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file or directory to delete' },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('delete_file_or_dir', args, onProgress),
    },
    {
      name: () => 'create_directory',
      description: () =>
        'Create a new directory (and any missing parent directories). Use before writing new files into a directory that may not exist yet.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory to create' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('create_directory', args, onProgress),
    },
    {
      name: () => 'move_file',
      description: () => 'Move or rename a file or directory. The destination path determines the new name/location.',
      parameters: () => ({
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path' },
          to: { type: 'string', description: 'Destination path' },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['from', 'to'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('move_file', args, onProgress),
    },
    {
      name: () => 'rename_file',
      description: () =>
        'Rename a file or directory (keep it in the same parent directory). For moving to a different directory, use move_file instead.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file/directory to rename' },
          new_name: { type: 'string', description: 'New name (not path, just the name)' },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['path', 'new_name'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('rename_file_or_dir', { filePath: args.path, newName: args.new_name }, onProgress),
    },

    // ── Phase 2b: Git Operations (Tauri commands already exist) ──
    {
      name: () => 'git_init',
      description: () => 'Initialize a new git repository in the given directory.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_init', args, onProgress),
    },
    {
      name: () => 'git_checkout',
      description: () => 'Switch to a different branch. Use git_create_branch first if the branch does not exist.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          branch: { type: 'string', description: 'Branch name to switch to' },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['path', 'branch'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_checkout', args, onProgress),
    },
    {
      name: () => 'git_create_branch',
      description: () =>
        'Create a new git branch from the current HEAD. Does NOT switch to it — use git_checkout after.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          branch: { type: 'string', description: 'New branch name' },
        },
        required: ['path', 'branch'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_create_branch', args, onProgress),
    },
    {
      name: () => 'git_discard',
      description: () =>
        'Discard unstaged changes to a file (git checkout -- <file>). Loses all uncommitted modifications.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          file: { type: 'string', description: 'File path to discard changes for (relative to repo root)' },
          _forceGate: {
            type: 'boolean',
            description:
              'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
          },
        },
        required: ['path', 'file'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_discard', args, onProgress),
    },
    {
      name: () => 'git_stash_push',
      description: () => 'Stash current uncommitted changes. Use before switching branches with dirty working tree.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          message: { type: 'string', description: 'Optional stash message for identification' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_stash_push', args, onProgress),
    },
    {
      name: () => 'git_stash_pop',
      description: () =>
        'Restore the most recently stashed changes. Pops the stash — the changes are applied and the stash entry is removed.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('git_stash_pop', args, onProgress),
    },

    // ── Phase 2c: Agent Worktree Isolation (Tauri commands already exist) ──
    {
      name: () => 'agent_isolation_create',
      description: () =>
        'Create an isolated git worktree for a sub-agent to work in. Returns the isolation path. Use before spawning a sub-agent that mutates files — prevents conflicts when multiple agents modify the same repo concurrently.',
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Identifier for this isolation workspace' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('agent_isolation_create', args, onProgress),
    },
    {
      name: () => 'agent_isolation_diff',
      description: () => 'Show the diff of changes made in an isolation workspace.',
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Isolation workspace to diff' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('agent_isolation_diff', args, onProgress),
    },
    {
      name: () => 'agent_isolation_merge',
      description: () => 'Merge changes from an isolation workspace back into the main repository.',
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Isolation workspace to merge' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('agent_isolation_merge', args, onProgress),
    },
    {
      name: () => 'agent_isolation_discard',
      description: () =>
        "Discard an isolation workspace and delete its worktree. Use when the sub-agent's changes are no longer needed.",
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Isolation workspace to discard' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => false,
      execute: (args, onProgress) => exec('agent_isolation_discard', args, onProgress),
    },
    {
      name: () => 'agent_isolation_status',
      description: () => 'List all isolation workspaces and their current status.',
      parameters: () => ({
        type: 'object',
        properties: {},
      }),
      readOnly: () => true,
      execute: (args, onProgress) => exec('agent_isolation_status', args, onProgress),
    },
  ];
}
