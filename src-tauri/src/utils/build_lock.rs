// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// BuildLock — 多 Agent 构建锁互斥（从 utils.rs 拆出）

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::utils::ipc_guard::lock_or_recover;

// ══════════════════════════════════════════════════════════════════════
// BuildLock — 多 Agent 构建锁互斥（替代前端 shell 队列的互斥职责）。
//
// 设计（2026-08-10，退役前端全局串行队列的替代方案）：
//   - 互斥粒度是"锁资源"不是"命令"：同一 (cwd, lock_name) 上同时只能
//     有一个 job，不同资源互不阻塞——冲突面从时间线收窄到资源交集。
//   - 原子检查+注册：Tauri 单进程 + Mutex 临界区，无 TOCTOU 窗口。
//   - 锁生命周期 = job 生命周期：锁随 BG_JOBS 移除自动释放（remove_job）。
//   - 打回而非排队：冲突时返回带路径的错误（重试 / bash_wait），
//     由 LLM 决策；OS 文件锁（cargo/npm/git 自带）兜底竞态外冲突。
//   - 局限性（接受）：用户手动命令不注册 ledger → 锁表不可见 →
//     冲突由 OS 锁兜底；cargo workspace root 场景锁键按 cwd 判定可能漏判。
pub(crate) type LockKey = (String, String); // (cwd, lock_name)

pub(crate) struct LockHolder {
    pub(crate) job_id: u32,
    pub(crate) cmd: String,
    pub(crate) owner: Option<String>,
    pub(crate) started_at: std::time::Instant,
}

pub(crate) static BUILD_LOCKS: std::sync::LazyLock<Arc<Mutex<HashMap<LockKey, LockHolder>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 测试串行锁 — build_lock 相关测试共享全局 BUILD_LOCKS 且并行执行，
/// 各测试末尾的 clear() 会互踩；此 Mutex 串行化所有触及 BUILD_LOCKS 的测试
/// （utils.rs 与 bg_jobs.rs 的内嵌 tests 共用，避免并发互踩）。
#[cfg(test)]
pub(crate) static BUILD_LOCK_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 命令 → 锁名映射（种子抄前端 cmd-class.ts 的 HEAVY_SUB / GIT_WRITE_SUB）。
/// 只覆盖会抢构建锁的命令：cargo→target/，npm/pnpm/yarn→node_modules/，git 写→index。
/// 其余命令无锁，不检查不注册（互斥交给 OS/工具自带锁）。
pub(crate) fn lock_name_for_command(cmd: &str) -> Option<&'static str> {
    let mut it = cmd.split_whitespace();
    let tool = it.next()?;
    let sub = it.next().unwrap_or("");
    let heavy = |set: &[&str]| set.contains(&sub);
    match tool {
        "cargo" => heavy(&["build", "test", "check", "clippy", "run", "install", "bench", "audit"]).then_some("target"),
        "npm" | "pnpm" | "yarn" => heavy(&["install", "ci", "build", "test", "run", "exec", "audit", "start"]).then_some("node_modules"),
        "git" => {
            let write = [
                "add", "commit", "push", "pull", "fetch", "checkout", "switch", "create-branch",
                "init", "reset", "merge", "rebase", "cherry-pick", "revert", "clean",
                "restore", "rm", "mv", "stage", "unstage", "stash", "tag", "apply", "am",
            ];
            write.contains(&sub).then_some("git_index")
        }
        _ => None,
    }
}

fn lock_label(lock_name: &str) -> &str {
    match lock_name {
        "target" => "target/ 构建目录",
        "node_modules" => "node_modules/ 目录",
        "git_index" => ".git/index 索引",
        _ => lock_name,
    }
}

/// 原子检查+注册构建锁（同一 Mutex 临界区，无 TOCTOU）。
/// 冲突 → Err(带路径的打回信息)；成功 → Ok(锁键，None=无锁命令)。
/// job_id 须由调用方先用 next_job_id() 预留（与后续 spawn 使用同一 id）。
pub(crate) fn acquire_build_lock(
    cmd: &str,
    cwd: &str,
    job_id: u32,
    owner: Option<String>,
) -> Result<Option<LockKey>, String> {
    let Some(lock_name) = lock_name_for_command(cmd) else {
        return Ok(None);
    };
    let key = (cwd.to_string(), lock_name.to_string());
    let mut locks = lock_or_recover(&BUILD_LOCKS);
    if let Some(h) = locks.get(&key) {
        let secs = h.started_at.elapsed().as_secs();
        let holder = h.owner.as_deref().unwrap_or("用户手动命令");
        return Err(format!(
            "⚠️ 构建锁冲突：{label} 被 job #{id} 持有（{cmd}，已运行 {secs}s，持有者：{holder}）。\
             本命令未执行。可稍后重试，或 bash_wait({id}) 等它完成。",
            label = lock_label(lock_name),
            id = h.job_id,
            cmd = h.cmd,
        ));
    }
    locks.insert(
        key.clone(),
        LockHolder { job_id, cmd: cmd.to_string(), owner, started_at: std::time::Instant::now() },
    );
    Ok(Some(key))
}