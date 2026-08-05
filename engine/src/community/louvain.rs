// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use rand::seq::SliceRandom;
use rand::SeedableRng;

use crate::graph::Graph;
use crate::storage::MemoryIndex;

/// 社区 = 一组节点 ID。
pub type Community = Vec<String>;

/// 带层次元数据（层级 + 父节点）的社区。
#[derive(Debug, Clone)]
pub struct HierarchicalCommunity {
    pub id: String,
    pub label: String,
    pub node_ids: Vec<String>,      // leaf graph node IDs (all levels)
    pub level: usize,               // 0 = base, 1 = super, …
    pub parent_id: Option<String>,  // community ID one level up, None if top
}

// ═══════════════════════════════════════════════════════════════
// Graph → 邻接表辅助函数
// ═══════════════════════════════════════════════════════════════

fn build_adjacency(graph: &Graph) -> Option<(Vec<String>, Vec<Vec<(usize, f64)>>, Vec<f64>, f64)> {
    let mut node_ids: Vec<&str> = graph.node_ids().collect();
    node_ids.sort();
    let n = node_ids.len();
    if n == 0 { return None; }

    let id_to_idx: HashMap<&str, usize> = node_ids.iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();

    let m: f64 = graph.edge_count() as f64;
    if m == 0.0 {
        let owned_ids: Vec<String> = node_ids.iter().map(|id| id.to_string()).collect();
        return Some((owned_ids, vec![vec![]; n], vec![0.0; n], 0.0));
    }

    let mut degrees = vec![0.0f64; n];
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];

    for edge in graph.edges_iter().map(|(_, e)| e) {
        if let (Some(&s), Some(&t)) = (id_to_idx.get(edge.source.as_str()), id_to_idx.get(edge.target.as_str())) {
            let w = 1.0;
            adj[s].push((t, w));
            adj[t].push((s, w));
            degrees[s] += w;
            degrees[t] += w;
        }
    }

    let owned_ids: Vec<String> = node_ids.iter().map(|id| id.to_string()).collect();
    Some((owned_ids, adj, degrees, m))
}

fn build_adjacency_from_index(idx: &MemoryIndex) -> Option<(Vec<String>, Vec<Vec<(usize, f64)>>, Vec<f64>, f64)> {
    let mut node_ids: Vec<String> = idx.nodes_iter().map(|n| n.id.clone()).collect();
    node_ids.sort();
    let n = node_ids.len();
    if n == 0 { return None; }

    let id_to_idx: HashMap<&str, usize> = node_ids.iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    let mut degrees = vec![0.0f64; n];
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];
    let mut m: f64 = 0.0;

    for (source, targets) in idx.edges_iter() {
        if let Some(&si) = id_to_idx.get(source.as_str()) {
            for (target, _, _, _) in targets {
                if let Some(&ti) = id_to_idx.get(target.as_str()) {
                    let w = 1.0;
                    adj[si].push((ti, w));
                    adj[ti].push((si, w));
                    degrees[si] += w;
                    degrees[ti] += w;
                    m += w;
                }
            }
        }
    }

    if m == 0.0 {
        return Some((node_ids, vec![vec![]; n], vec![0.0; n], 0.0));
    }
    Some((node_ids, adj, degrees, m))
}

// ═══════════════════════════════════════════════════════════════
// Louvain 核心局部移动（阶段 1）
// ═══════════════════════════════════════════════════════════════

/// 在加权无向图上运行 Louvain 局部移动。
/// 返回按大小排序的社区（最大的在前）。
///
/// ponytail: 基于 Vec 的社区存储，带可复用的权重缓冲区。
/// 热循环中无 HashMap。比基于 HashMap 的 Louvain 快 2-3 倍。
fn run_louvain(
    node_ids: &[String],
    n: usize,
    adj: &[Vec<(usize, f64)>],
    degrees: &[f64],
    m: f64,
    rng: &mut rand::rngs::StdRng,
) -> Vec<Community> {
    let (comm_nodes, _node_to_comm) = local_moving_core(n, adj, degrees, m, rng);
    build_community_result(node_ids, &comm_nodes)
}

/// 核心局部移动循环。返回 (comm_nodes, node_to_comm)。
fn local_moving_core(
    n: usize,
    adj: &[Vec<(usize, f64)>],
    degrees: &[f64],
    m: f64,
    rng: &rand::rngs::StdRng,
) -> (Vec<Vec<usize>>, Vec<usize>) {
    let mut rng = rng.clone();
    let mut node_to_comm: Vec<usize> = (0..n).collect();
    let mut comm_nodes: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut sigma_tot: Vec<f64> = degrees.to_vec();
    // 可复用的权重缓冲区 — 避免每个节点每次迭代分配 HashMap
    let mut weight_buf: Vec<f64> = vec![0.0; n + n / 4];
    let mut touched: Vec<usize> = Vec::new();

    let tc = 2.0 * m * m; // 预计算分母常数

    let mut improved = true;
    let mut iter = 0;
    let max_iter = 100;
    while improved && iter < max_iter {
        improved = false;
        iter += 1;
        let mut order: Vec<usize> = (0..n).collect();
        order.shuffle(&mut rng);
        for &i in &order {
            let old_comm = node_to_comm[i];
            let ki = degrees[i];

            // 清除权重缓冲区（仅 touched 条目 — O(degree)，非 O(n)）
            for &c in &touched {
                weight_buf[c] = 0.0;
            }
            touched.clear();

            // 累加邻居社区权重
            for &(neighbor, w) in &adj[i] {
                let c = node_to_comm[neighbor];
                if weight_buf[c] == 0.0 {
                    touched.push(c);
                }
                weight_buf[c] += w;
            }

            let ki_in_old = weight_buf[old_comm];
            let sigma_tot_old = sigma_tot[old_comm];
            let mut best_comm = old_comm;
            let mut best_gain = 0.0f64;

            // 对 touched 排序以实现确定性平局打破
            touched.sort();
            for &c in &touched {
                if c == old_comm {
                    continue;
                }
                let ki_in = weight_buf[c];
                let sigma_tot_c = sigma_tot[c];
                let gain = (ki_in - ki_in_old) / m - ki * (sigma_tot_c - (sigma_tot_old - ki)) / tc;
                if gain > best_gain {
                    best_gain = gain;
                    best_comm = c;
                }
            }

            let gain_isolated = -ki_in_old / m + ki * (sigma_tot_old - ki) / tc;
            if gain_isolated > best_gain && gain_isolated > 0.0 {
                best_gain = gain_isolated;
                best_comm = i;
                if i >= comm_nodes.len() {
                    comm_nodes.resize(i + 1, Vec::new());
                    sigma_tot.resize(i + 1, 0.0);
                }
                if weight_buf.len() <= i {
                    weight_buf.resize(i + n / 4, 0.0);
                }
                comm_nodes[i].clear();
                sigma_tot[i] = 0.0;
            }

            if best_comm != old_comm && best_gain > 0.0 {
                comm_nodes[old_comm].retain(|&x| x != i);
                comm_nodes[best_comm].push(i);
                node_to_comm[i] = best_comm;
                sigma_tot[old_comm] -= ki;
                sigma_tot[best_comm] += ki;
                improved = true;
            }
        }

        // 重新编号：压缩非空社区
        compact_communities(n, &mut comm_nodes, &mut sigma_tot, &mut node_to_comm);
    }

    (comm_nodes, node_to_comm)
}

/// 在局部移动迭代后压缩非空社区。
fn compact_communities(
    n: usize,
    comm_nodes: &mut Vec<Vec<usize>>,
    sigma_tot: &mut Vec<f64>,
    node_to_comm: &mut Vec<usize>,
) {
    let mut live_comms: Vec<usize> = Vec::new();
    for c in 0..comm_nodes.len() {
        if !comm_nodes[c].is_empty() {
            live_comms.push(c);
        }
    }
    let live_count = live_comms.len();
    let mut map: Vec<usize> = vec![0; comm_nodes.len()];
    for (new, &old) in live_comms.iter().enumerate() {
        map[old] = new;
    }
    // 压缩
    let mut new_comm_nodes: Vec<Vec<usize>> = Vec::with_capacity(live_count);
    let mut new_sigma_tot: Vec<f64> = Vec::with_capacity(live_count);
    for &old in &live_comms {
        new_comm_nodes.push(std::mem::take(&mut comm_nodes[old]));
        new_sigma_tot.push(sigma_tot[old]);
    }
    *comm_nodes = new_comm_nodes;
    *sigma_tot = new_sigma_tot;
    for i in 0..n {
        node_to_comm[i] = map[node_to_comm[i]];
    }
}

fn build_community_result(node_ids: &[String], comm_nodes: &[Vec<usize>]) -> Vec<Community> {
    let mut result: Vec<Community> = comm_nodes.iter()
        .filter(|c| !c.is_empty())
        .map(|nodes| nodes.iter().map(|&idx| node_ids[idx].clone()).collect())
        .collect();
    result.sort_by_key(|c| -(c.len() as i64));
    result
}

// ═══════════════════════════════════════════════════════════════
// 层次 Louvain（在每个压缩层级使用纯 Louvain）
// ═══════════════════════════════════════════════════════════════

/// 构建 Level 0（Louvain），然后迭代压缩以生成更高层级。
///
/// 使用纯 Louvain（仅局部移动）— 无 Leiden 精化。
/// L1+ 在压缩后的超图上使用相同算法。
///
/// M2 (2026-08-06)：leaf_edges 改借用 (&str,&str)（调用方零克隆，
/// 全内核 14M 边时消除 ~2.3GB 字符串对拷贝）；并在层级循环前
/// 一次性预映射为 dense 索引对，每层循环从 O(E) HashMap 查找降为数组下标。
fn detect_hierarchical_from_base(
    base: &[Community],
    seed: u64,
    leaf_edges: &[(&str, &str)],
) -> Vec<HierarchicalCommunity> {
    let mut result: Vec<HierarchicalCommunity> = Vec::new();
    if base.is_empty() { return result; }

    // Level 0：基础社区
    for (i, nodes) in base.iter().enumerate() {
        result.push(HierarchicalCommunity {
            id: format!("l0_comm_{}", i),
            label: format!("社区 {}", i + 1),
            node_ids: nodes.clone(),
            level: 0,
            parent_id: None,
        });
    }

    if base.len() <= 1 { return result; }

    // 仅构建一次 dense node-ID → index 映射。
    let mut all_node_ids: Vec<&str> = base.iter()
        .flat_map(|c| c.iter().map(|s| s.as_str()))
        .collect();
    all_node_ids.sort();
    all_node_ids.dedup();
    let node_count = all_node_ids.len();
    let node_to_dense: HashMap<&str, usize> = all_node_ids.iter()
        .enumerate()
        .map(|(i, &id)| (id, i))
        .collect();

    // M2：leaf_edges 一次性预映射为 dense 索引对（端点缺失 → usize::MAX，循环内跳过）。
    // 原实现每层循环对 9M+ 条边做 2 次 HashMap<&str> 查找，最多重复 MAX_LEVELS 轮。
    let dense_edges: Vec<(usize, usize)> = leaf_edges
        .iter()
        .map(|(src, dst)| {
            let d = node_to_dense.get(src).copied().unwrap_or(usize::MAX);
            let e = node_to_dense.get(dst).copied().unwrap_or(usize::MAX);
            (d, e)
        })
        .collect();

    // 迭代压缩
    let mut current_communities: Vec<Vec<String>> = base.to_vec();
    let mut level = 0usize;

    // result 的 id → 下标索引：父节点回写用 O(1) 查找,替代逐层 O(K²) 线性扫描
    let mut result_index: HashMap<String, usize> = result
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.clone(), i))
        .collect();

    // 层次上限：防止退化输入(大量孤立社区/缓慢合并)下无限造层
    const MAX_LEVELS: usize = 8;

    loop {
        if level >= MAX_LEVELS { break; }
        let n = current_communities.len();

        // 构建 node → community-index 映射
        let mut node_to_ci: Vec<usize> = vec![usize::MAX; node_count];
        for (ci, members) in current_communities.iter().enumerate() {
            for nid in members {
                if let Some(&dense) = node_to_dense.get(nid.as_str()) {
                    node_to_ci[dense] = ci;
                }
            }
        }

        // 压缩：累加跨社区边 — 通过排序合并实现 O(E)
        let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];
        let mut degrees = vec![0.0f64; n];
        let mut m = 0.0f64;

        let mut edge_pairs: Vec<((usize, usize), f64)> = Vec::new();
        for &(ds, dt) in &dense_edges {
            if ds == usize::MAX || dt == usize::MAX { continue; }
            let ci = node_to_ci[ds];
            let cj = node_to_ci[dt];
            if ci != usize::MAX && cj != usize::MAX && ci != cj {
                let (a, b) = if ci < cj { (ci, cj) } else { (cj, ci) };
                edge_pairs.push(((a, b), 1.0));
            }
        }
        edge_pairs.sort_by(|(a, _), (b, _)| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

        // 合并相邻条目
        let mut sorted_edges: Vec<((usize, usize), f64)> = Vec::new();
        for ((a, b), w) in edge_pairs {
            if let Some(last) = sorted_edges.last_mut() {
                if last.0 == (a, b) { last.1 += w; continue; }
            }
            sorted_edges.push(((a, b), w));
        }
        for ((a, b), w) in sorted_edges {
            adj[a].push((b, w));
            adj[b].push((a, w));
            degrees[a] += w;
            degrees[b] += w;
            m += w;
        }

        if m == 0.0 { break; }

        // 在压缩图上运行 Louvain（非 Leiden — 精化在此处作用不大）
        let condensed_ids: Vec<String> = (0..n)
            .map(|i| format!("l{}_comm_{}", level, i))
            .collect();
        let mut rng = rand::rngs::StdRng::seed_from_u64(seed.wrapping_add((level + 1) as u64));
        let super_comms = run_louvain(&condensed_ids, n, &adj, &degrees, m, &mut rng);

        if super_comms.len() >= n { break; }

        let parent_level = level + 1;
        let mut next_communities: Vec<Vec<String>> = Vec::new();

        for (sc_idx, sc) in super_comms.iter().enumerate() {
            // 孤立社区(压缩图中度数为 0 的单成员超社区)永远不会合并,
            // 不为它创建父层节点、也不带入下一层 — 否则每个孤立社区
            // 每层都白造一个超节点,大量孤立节点时层次完全退化
            if sc.len() == 1 {
                let is_isolated = sc[0]
                    .rsplit("_comm_")
                    .next()
                    .and_then(|s| s.parse::<usize>().ok())
                    .map(|ci| ci >= n || degrees[ci] == 0.0)
                    .unwrap_or(false);
                if is_isolated { continue; }
            }

            let parent_id = format!("l{}_comm_{}", parent_level, sc_idx);
            let mut leaf_nodes: Vec<String> = Vec::new();

            for cid_str in sc {
                if let Some(idx_str) = cid_str.rsplit("_comm_").next() {
                    if let Ok(ci) = idx_str.parse::<usize>() {
                        if ci < n {
                            leaf_nodes.extend(current_communities[ci].iter().cloned());
                            let child_id = format!("l{}_comm_{}", level, ci);
                            if let Some(&ri) = result_index.get(&child_id) {
                                result[ri].parent_id = Some(parent_id.clone());
                            }
                        }
                    }
                }
            }
            leaf_nodes.sort();
            leaf_nodes.dedup();
            let leaf_clone = leaf_nodes.clone();
            next_communities.push(leaf_nodes);

            result_index.insert(parent_id.clone(), result.len());
            result.push(HierarchicalCommunity {
                id: parent_id,
                label: format!("L{}·{}", parent_level, sc_idx + 1),
                node_ids: leaf_clone,
                level: parent_level,
                parent_id: None,
            });
        }

        if next_communities.len() <= 1 { break; }
        current_communities = next_communities;
        level = parent_level;
    }

    result
}

// ═══════════════════════════════════════════════════════════════
// Leiden 精化（阶段 2）
// ═══════════════════════════════════════════════════════════════

/// 对 Louvain 分区运行 Leiden 阶段 2 精化。
///
/// 算法：
///   1. 对阶段 1 的每个社区 C，在 C 的诱导子图内运行局部移动，
///      将 C 拆分为分离良好的子社区。
///   2. 所有社区拆分后，尝试将每个子社区合并到相邻的
///      阶段 1 社区中（如果能改善模块度）。
///
/// 返回精化后的社区。结果可能比输入有更多社区，
/// 但分离度更好。
fn leiden_refinement(
    node_ids: &[String],
    n: usize,
    adj: &[Vec<(usize, f64)>],
    degrees: &[f64],
    m: f64,
    rng: &mut rand::rngs::StdRng,
    p1_comms: &[Vec<usize>],  // Phase 1: community → node indices
) -> Vec<Community> {
    // ── 步骤 1：从阶段 1 构建 node→community 映射 ──
    let mut node_to_p1: Vec<usize> = vec![0; n];
    for (ci, comm) in p1_comms.iter().enumerate() {
        for &v in comm {
            node_to_p1[v] = ci;
        }
    }

    // ── 步骤 2：在 P1 社区内部拆分 ──
    // sub_comms：所有子社区的扁平列表，每个为 Vec<usize>
    // sub_parent：每个子社区来自哪个 P1 社区
    let mut sub_comms: Vec<Vec<usize>> = Vec::new();
    let mut sub_parent: Vec<usize> = Vec::new();
    let mut node_to_sub: Vec<usize> = vec![usize::MAX; n];

    for (p1_idx, comm) in p1_comms.iter().enumerate() {
        if comm.len() <= 2 {
            // 太小无法拆分 — 保持原样
            let mut members = comm.clone();
            members.sort();
            sub_comms.push(members);
            sub_parent.push(p1_idx);
            for &v in comm {
                node_to_sub[v] = sub_comms.len() - 1;
            }
            continue;
        }

        // 为此社区构建诱导子图
        let k = comm.len();
        let old_to_new: HashMap<usize, usize> = comm.iter().enumerate()
            .map(|(new, &old)| (old, new))
            .collect();
        let mut sub_adj: Vec<Vec<(usize, f64)>> = vec![vec![]; k];
        let mut sub_deg = vec![0.0f64; k];
        let mut sub_m = 0.0f64;
        for &v in comm {
            let vi = old_to_new[&v];
            for &(nb, w) in &adj[v] {
                if let Some(&nbi) = old_to_new.get(&nb) {
                    sub_adj[vi].push((nbi, w));
                    sub_deg[vi] += w;
                    sub_m += w;
                }
            }
        }
        sub_m /= 2.0;
        if sub_m == 0.0 {
            let mut members = comm.clone();
            members.sort();
            sub_comms.push(members);
            sub_parent.push(p1_idx);
            for &v in comm {
                node_to_sub[v] = sub_comms.len() - 1;
            }
            continue;
        }

        // 在此社区的子图内运行局部移动
        let (split_nodes, _split_map) = local_moving_core(k, &sub_adj, &sub_deg, sub_m, rng);

        // 将子索引转换回全局索引
        for split in &split_nodes {
            if split.is_empty() { continue; }
            let mut members: Vec<usize> = split.iter().map(|&si| comm[si]).collect();
            members.sort();
            let sub_idx = sub_comms.len();
            for &v in &members {
                node_to_sub[v] = sub_idx;
            }
            sub_comms.push(members);
            sub_parent.push(p1_idx);
        }
    }

    // ── 步骤 3：合并子社区 ──
    // 每个子社区可以留在其父 P1 社区，或切换到
    // 相邻的 P1 社区（如果能改善模块度）。
    let tc = 2.0 * m * m;
    let p1_count = p1_comms.len();
    let mut p1_sigma: Vec<f64> = vec![0.0; p1_count]; // 每个 P1 社区的总度数
    for (ci, comm) in p1_comms.iter().enumerate() {
        p1_sigma[ci] = comm.iter().map(|&v| degrees[v]).sum();
    }

    let sub_count = sub_comms.len();
    if sub_count == 0 {
        return vec![];
    }
    // 每个子社区初始分配到其父 P1 社区
    let mut sub_comm: Vec<usize> = sub_parent.clone();
    let sub_sigma: Vec<f64> = sub_comms.iter()
        .map(|sc| sc.iter().map(|&v| degrees[v]).sum())
        .collect();

    // 对每个子社区，尝试移动到相邻的 P1 社区
    let mut improved = true;
    let mut iter = 0;
    while improved && iter < 10 {
        improved = false;
        iter += 1;
        for si in 0..sub_count {
            let old_p1 = sub_comm[si];
            // 累加此子社区到每个 P1 社区的边权重
            let mut p1_weight: Vec<f64> = vec![0.0; p1_count];
            let mut touched: Vec<usize> = Vec::new();
            for &v in &sub_comms[si] {
                for &(nb, w) in &adj[v] {
                    let p1 = node_to_p1[nb];
                    if p1_weight[p1] == 0.0 {
                        touched.push(p1);
                    }
                    p1_weight[p1] += w;
                }
            }

            let sigma_sub = sub_sigma[si];
            let sigma_old = p1_sigma[old_p1];
            let ki_in_old = p1_weight[old_p1];

            let mut best_p1 = old_p1;
            let mut best_gain = 0.0f64;

            for &p1 in &touched {
                if p1 == old_p1 { continue; }
                let ki_in = p1_weight[p1];
                let sigma_new = p1_sigma[p1];
                let gain = (ki_in - ki_in_old) / m
                    - sigma_sub * (sigma_new - (sigma_old - sigma_sub)) / tc;
                if gain > best_gain {
                    best_gain = gain;
                    best_p1 = p1;
                }
            }

            if best_p1 != old_p1 && best_gain > 0.0 {
                sub_comm[si] = best_p1;
                p1_sigma[old_p1] -= sigma_sub;
                p1_sigma[best_p1] += sigma_sub;
                improved = true;
            }
        }
    }

    // ── 步骤 4：组装最终社区 ──
    let mut final_comms: Vec<Vec<usize>> = vec![vec![]; p1_count];
    for si in 0..sub_count {
        let p1 = sub_comm[si];
        final_comms[p1].extend(sub_comms[si].iter().cloned());
    }
    for fc in final_comms.iter_mut() {
        fc.sort();
        fc.dedup();
    }

    let mut result: Vec<Community> = final_comms.iter()
        .filter(|c| !c.is_empty())
        .map(|nodes| nodes.iter().map(|&idx| node_ids[idx].clone()).collect())
        .collect();
    result.sort_by_key(|c| -(c.len() as i64));
    result
}

// ═══════════════════════════════════════════════════════════════
// 公共 API
// ═══════════════════════════════════════════════════════════════

/// 在 graph 上运行 Leiden 社区检测（扁平，单层）。
///
/// 完整 Leiden 算法：阶段 1 局部移动 + 阶段 2 精化。
/// 精化步骤拆分社区以改善模块度，然后
/// 合并在其父社区内连接良好的子社区。
/// 这比纯 Louvain 产生分离度更好的社区。
///
/// 注意：层次压缩使用纯 Louvain 作为基础
/// （见 detect_communities_louvain），因为精化产生过多
/// 基础社区，O(K²) 压缩步骤无法高效处理。
pub fn detect_communities(graph: &Graph, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let Some((owned_ids, adj, degrees, m)) = build_adjacency(graph) else {
        return vec![];
    };
    let n = owned_ids.len();
    if m == 0.0 {
        let mut ids = owned_ids;
        ids.sort();
        return ids.into_iter().map(|id| vec![id]).collect();
    }
    // 阶段 1：Louvain 局部移动
    let (comm_nodes, _) = local_moving_core(n, &adj, &degrees, m, &rng);
    let p1_comms: Vec<Vec<usize>> = comm_nodes.into_iter().filter(|c| !c.is_empty()).collect();
    // 阶段 2：Leiden 精化
    leiden_refinement(&owned_ids, n, &adj, &degrees, m, &mut rng, &p1_comms)
}

/// 纯 Louvain（无精化）— 供层次压缩内部使用，
/// 精化的额外社区会导致 O(K²) 超图步骤爆炸。
fn detect_communities_louvain(graph: &Graph, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let Some((owned_ids, adj, degrees, m)) = build_adjacency(graph) else {
        return vec![];
    };
    let n = owned_ids.len();
    if m == 0.0 {
        let mut ids = owned_ids;
        ids.sort();
        return ids.into_iter().map(|id| vec![id]).collect();
    }
    run_louvain(&owned_ids, n, &adj, &degrees, m, &mut rng)
}

/// 从 MemoryIndex 检测社区（Leiden）。
pub fn detect_communities_from_index(idx: &MemoryIndex, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let Some((owned_ids, adj, degrees, m)) = build_adjacency_from_index(idx) else {
        return vec![];
    };
    let n = owned_ids.len();
    if m == 0.0 {
        return owned_ids.into_iter().map(|id| vec![id]).collect();
    }
    let (comm_nodes, _) = local_moving_core(n, &adj, &degrees, m, &rng);
    let p1_comms: Vec<Vec<usize>> = comm_nodes.into_iter().filter(|c| !c.is_empty()).collect();
    leiden_refinement(&owned_ids, n, &adj, &degrees, m, &mut rng, &p1_comms)
}

/// 从 MemoryIndex 运行纯 Louvain — 供层次压缩路径使用。
fn detect_communities_from_index_louvain(idx: &MemoryIndex, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let Some((owned_ids, adj, degrees, m)) = build_adjacency_from_index(idx) else {
        return vec![];
    };
    let n = owned_ids.len();
    if m == 0.0 {
        return owned_ids.into_iter().map(|id| vec![id]).collect();
    }
    run_louvain(&owned_ids, n, &adj, &degrees, m, &mut rng)
}

// ── 层次化 ──────────────────────────────────────────────

/// 层次 Louvain 社区检测。
/// L0 使用纯 Louvain（无精化）以实现高效压缩。
/// 如需 Leiden 精化的扁平社区，请改用 detect_communities()。
pub fn detect_hierarchical_communities(graph: &Graph, seed: u64) -> Vec<HierarchicalCommunity> {
    let base = detect_communities_louvain(graph, seed);
    let leaf_edges: Vec<(&str, &str)> = graph.edges_iter()
        .map(|(_, e)| (e.source.as_str(), e.target.as_str()))
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}

/// 使用预计算基础社区的层次 Leiden。
pub fn detect_hierarchical_communities_with_base(
    graph: &Graph,
    base: Vec<Community>,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let leaf_edges: Vec<(&str, &str)> = graph.edges_iter()
        .map(|(_, e)| (e.source.as_str(), e.target.as_str()))
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}

/// 从 MemoryIndex 运行层次 Louvain。
pub fn detect_hierarchical_communities_from_index(
    idx: &MemoryIndex,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let base = detect_communities_from_index_louvain(idx, seed);
    // edges_iter 返回 owned String — 先持有再借用,语义不变
    let owned_edges: Vec<(String, String)> = idx.edges_iter()
        .into_iter()
        .flat_map(|(src, targets)| {
            let s = src;
            targets.into_iter().map(move |(tgt, _, _, _)| (s.clone(), tgt))
        })
        .collect();
    let leaf_edges: Vec<(&str, &str)> = owned_edges.iter()
        .map(|(s, t)| (s.as_str(), t.as_str()))
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}

/// 一次运行同时生成扁平（Leiden 精化）和层次（Louvain）社区。
///
/// 扁平社区使用完整 Leiden（局部移动 + 精化）。
/// 层次压缩使用纯 Louvain 以提高效率 —
/// 精化的额外社区会导致 O(K²) 超图步骤爆炸。
pub fn detect_communities_and_hierarchy(
    graph: &Graph,
    seed: u64,
) -> (Vec<Community>, Vec<HierarchicalCommunity>) {
    let base = detect_communities(graph, seed);  // Leiden 精化的扁平社区
    let hier_base = detect_communities_louvain(graph, seed);  // 用于层次化的 Louvain
    let leaf_edges: Vec<(&str, &str)> = graph.edges_iter()
        .map(|(_, e)| (e.source.as_str(), e.target.as_str()))
        .collect();
    let hierarchical = detect_hierarchical_from_base(&hier_base, seed, &leaf_edges);
    (base, hierarchical)
}

// ═══════════════════════════════════════════════════════════════
// 稳定社区 ID 匹配
// ═══════════════════════════════════════════════════════════════

/// 通过贪心最大重叠将新社区匹配到旧社区。
///
/// 给定新社区分区和旧的 `node_id → community_id`
/// 映射，为每个新社区返回一个稳定 ID。与旧社区
/// 重叠显著的新社区继承旧社区的 ID。真正的新社区
/// 获得新 ID（延续计数器）。
///
/// 算法：按重叠数降序贪心匹配（平局按
/// 旧 ID 然后 new index 打破 — 完全确定性）。每个旧 ID 最多
/// 被认领一次，确保 1:1 映射。
pub fn match_communities_to_previous(
    new_communities: &[Community],
    old_assignment: &HashMap<String, usize>,
) -> Vec<usize> {
    use std::collections::HashSet;

    // 构建重叠对：(overlap_count, new_idx, old_id)
    let mut pairs: Vec<(usize, usize, usize)> = Vec::new();
    for (new_idx, comm) in new_communities.iter().enumerate() {
        let mut overlap: HashMap<usize, usize> = HashMap::new();
        for node_id in comm {
            if let Some(&old_cid) = old_assignment.get(node_id) {
                *overlap.entry(old_cid).or_default() += 1;
            }
        }
        for (&old_id, &count) in &overlap {
            pairs.push((count, new_idx, old_id));
        }
    }

    // 贪心匹配：最高重叠优先。平局按
    // 旧 ID 然后 new index 确定性打破 — 相同重叠的合并总是继承
    // 最低的旧 ID，因此结果不依赖于 HashMap 迭代顺序。
    pairs.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));

    let mut result = vec![usize::MAX; new_communities.len()];
    let mut used_old: HashSet<usize> = HashSet::new();

    for &(_, new_idx, old_id) in &pairs {
        if result[new_idx] != usize::MAX || used_old.contains(&old_id) {
            continue;
        }
        result[new_idx] = old_id;
        used_old.insert(old_id);
    }

    // 为未匹配的社区分配新 ID
    let mut next_id = old_assignment.values().copied().max()
        .map(|m| m.saturating_add(1))
        .unwrap_or(0);
    for id in result.iter_mut() {
        if *id == usize::MAX {
            *id = next_id;
            next_id += 1;
        }
    }

    result
}

/// 为没有 community_id 的节点分配社区，基于邻居
/// 多数投票。用于增量更新路径，避免全量
/// 重新聚类导致已有社区 ID 不稳定。
///
/// 已有 `community_id` 的节点保持不变。新节点
/// （community_id = None）继承其 graph 邻居中最常见的社区。
/// 没有带社区邻居的节点保持
/// 未分配 — 它们将在下次全量分析时获得社区。
///
/// 返回被分配社区的节点 ID，以便调用方
/// 持久化变更（swap_index 仅替换内存中的索引）。
pub fn assign_communities_to_new_nodes(graph: &mut crate::graph::Graph) -> Vec<String> {
    use std::collections::{HashMap, HashSet};

    let new_ids: HashSet<String> = graph.nodes_iter()
        .filter(|(_, n)| n.community_id.is_none())
        .map(|(id, _)| id.to_string())
        .collect();

    if new_ids.is_empty() { return Vec::new(); }

    // 单次遍历边 — 为每个新节点累加社区投票
    let mut votes: HashMap<String, HashMap<usize, usize>> = HashMap::new();
    for (_, edge) in graph.edges_iter() {
        if new_ids.contains(&edge.source) {
            if let Some(nbr) = graph.get_node(&edge.target) {
                if let Some(cid) = nbr.community_id {
                    *votes.entry(edge.source.clone()).or_default().entry(cid).or_default() += 1;
                }
            }
        }
        if new_ids.contains(&edge.target) {
            if let Some(nbr) = graph.get_node(&edge.source) {
                if let Some(cid) = nbr.community_id {
                    *votes.entry(edge.target.clone()).or_default().entry(cid).or_default() += 1;
                }
            }
        }
    }

    let mut assigned = Vec::new();
    for (nid, v) in &votes {
        // 选择投票最多的社区；平局按较低 ID 打破（更老 = 更稳定）
        if let Some(&best_cid) = v.iter()
            .max_by(|(cid_a, cnt_a), (cid_b, cnt_b)| {
                cnt_a.cmp(cnt_b).then(cid_b.cmp(cid_a))
            })
            .map(|(cid, _)| cid)
        {
            if let Some(node) = graph.nodes.get_mut(nid) {
                node.community_id = Some(best_cid);
                assigned.push(nid.clone());
            }
        }
    }
    assigned
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use crate::storage::MemoryIndex;

    fn build_test_graph() -> Graph {
        let mut g = Graph::new();
        for i in 0..6 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        // 簇 1：n0-n1-n2
        g.add_edge_unchecked(Edge::new("e01", "n0", "n1", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e12", "n1", "n2", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e02", "n0", "n2", EdgeKind::Calls));
        // 簇 2：n3-n4-n5
        g.add_edge_unchecked(Edge::new("e34", "n3", "n4", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e45", "n4", "n5", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e35", "n3", "n5", EdgeKind::Calls));
        // 桥接边
        g.add_edge_unchecked(Edge::new("e23", "n2", "n3", EdgeKind::Calls));
        g
    }

    fn build_sparse_large_graph(node_count: usize, community_size: usize) -> Graph {
        let mut g = Graph::new();
        let n_communities = node_count / community_size;

        for i in 0..node_count {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }

        for c in 0..n_communities {
            let base = c * community_size;
            for i in 0..(community_size - 1) {
                g.add_edge_unchecked(Edge::new(
                    format!("intra_{}_{}", base + i, base + i + 1),
                    format!("n{}", base + i),
                    format!("n{}", base + i + 1),
                    EdgeKind::Calls,
                ));
            }
        }

        for c in 0..(n_communities - 1) {
            g.add_edge_unchecked(Edge::new(
                format!("bridge_{}_{}", c, c + 1),
                format!("n{}", c * community_size),
                format!("n{}", (c + 1) * community_size),
                EdgeKind::Calls,
            ));
        }

        g
    }

    // ── 扁平检测测试 ──────────────────────────────────────────

    #[test]
    fn test_louvain_two_clusters() {
        let g = build_test_graph();
        let communities = detect_communities(&g, 42);
        assert!(communities.len() >= 2, "should find at least 2 communities, got {}", communities.len());
        assert!(communities[0].len() >= 3, "largest community should have 3+ nodes, got {}", communities[0].len());
    }

    #[test]
    fn test_empty_graph() {
        let g = Graph::new();
        let communities = detect_communities(&g, 42);
        assert_eq!(communities.len(), 0);
    }

    #[test]
    fn test_no_edges() {
        let mut g = Graph::new();
        for i in 0..5 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        let communities = detect_communities(&g, 42);
        assert_eq!(communities.len(), 5, "each isolated node = own community");
    }

    // ── 层次化测试 ────────────────────────────────────────────

    #[test]
    fn test_hierarchy_well_formed() {
        let g = build_test_graph();
        let hierarchical = detect_hierarchical_communities(&g, 42);

        let ids: std::collections::HashSet<&str> =
            hierarchical.iter().map(|c| c.id.as_str()).collect();
        for c in &hierarchical {
            if let Some(ref pid) = c.parent_id {
                assert!(ids.contains(pid.as_str()),
                    "parent '{}' of '{}' not found", pid, c.id);
            }
        }

        let level0: Vec<_> = hierarchical.iter().filter(|c| c.level == 0).collect();
        let mut covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        covered.sort();
        let mut expected: Vec<String> = g.node_ids().map(str::to_string).collect();
        expected.sort();
        assert_eq!(covered, expected,
            "Level 0 communities should cover all nodes exactly once");
    }

    #[test]
    fn test_hierarchy_single_community() {
        let mut g = Graph::new();
        for i in 0..5 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        for i in 0..5 {
            for j in (i + 1)..5 {
                g.add_edge_unchecked(Edge::new(
                    format!("e{}{}", i, j),
                    format!("n{}", i),
                    format!("n{}", j),
                    EdgeKind::Calls,
                ));
            }
        }

        let hierarchical = detect_hierarchical_communities(&g, 42);
        assert!(!hierarchical.is_empty());
        let level0: Vec<_> = hierarchical.iter().filter(|c| c.level == 0).collect();
        assert!(!level0.is_empty());
        let covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        assert_eq!(covered.len(), 5, "all nodes covered");
    }

    #[test]
    fn test_condensation_performance_no_regression() {
        let g = build_sparse_large_graph(2000, 4);
        let start = std::time::Instant::now();
        let result = detect_hierarchical_communities(&g, 42);
        let elapsed = start.elapsed();

        assert!(!result.is_empty(), "should find communities in non-empty graph");
        assert!(
            elapsed.as_millis() < 500,
            "hierarchical too slow: {}ms ({} nodes, {} edges)",
            elapsed.as_millis(),
            g.node_count(),
            g.edge_count(),
        );
    }

    #[test]
    fn test_sparse_graph_condensation_fast() {
        let mut g = Graph::new();
        for i in 0..100 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        for i in 0..10 {
            g.add_edge_unchecked(Edge::new(
                format!("e{}", i),
                format!("n{}", i),
                format!("n{}", i + 10),
                EdgeKind::Calls,
            ));
        }

        let start = std::time::Instant::now();
        let result = detect_hierarchical_communities(&g, 42);
        let elapsed = start.elapsed();

        assert!(!result.is_empty());
        assert!(
            elapsed.as_millis() < 200,
            "sparse hierarchical too slow: {}ms ({} nodes, {} edges)",
            elapsed.as_millis(),
            g.node_count(),
            g.edge_count(),
        );
    }

    // ── with_base 向后兼容 ────────────────────────────────────

    #[test]
    fn test_hierarchical_with_base_equals_direct() {
        let g = build_test_graph();
        let base = detect_communities(&g, 42);
        let direct = detect_hierarchical_communities(&g, 42);
        let with_base = detect_hierarchical_communities_with_base(&g, base, 42);

        assert_eq!(direct.len(), with_base.len(),
            "with_base and direct should produce same community count");

        for result in &[&direct, &with_base] {
            let level0: Vec<_> = result.iter().filter(|c| c.level == 0).collect();
            let mut covered: Vec<String> = level0.iter()
                .flat_map(|c| c.node_ids.clone())
                .collect();
            covered.sort();
            let mut expected: Vec<String> = g.node_ids().map(str::to_string).collect();
            expected.sort();
            assert_eq!(covered, expected);
        }
    }

    #[test]
    fn test_hierarchical_with_base_well_formed() {
        let g = build_sparse_large_graph(200, 4);
        let base = detect_communities(&g, 42);
        let result = detect_hierarchical_communities_with_base(&g, base, 42);

        assert!(!result.is_empty());
        let level0: Vec<_> = result.iter().filter(|c| c.level == 0).collect();
        let mut covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        covered.sort();
        let mut expected: Vec<String> = g.node_ids().map(str::to_string).collect();
        expected.sort();
        assert_eq!(covered, expected);

        let ids: std::collections::HashSet<&str> =
            result.iter().map(|c| c.id.as_str()).collect();
        for c in &result {
            if let Some(ref pid) = c.parent_id {
                assert!(ids.contains(pid.as_str()),
                    "parent '{}' of '{}' not found", pid, c.id);
            }
        }
    }

    #[test]
    fn test_hierarchical_phase2_well_formed() {
        let g = build_sparse_large_graph(100, 4);

        let r1 = detect_hierarchical_communities(&g, 42);
        let r2 = detect_hierarchical_communities(&g, 42);

        for r in &[&r1, &r2] {
            let level0: Vec<_> = r.iter().filter(|c| c.level == 0).collect();
            let mut covered: Vec<String> = level0.iter()
                .flat_map(|c| c.node_ids.clone())
                .collect();
            covered.sort();
            let mut expected: Vec<String> = g.node_ids().map(str::to_string).collect();
            expected.sort();
            assert_eq!(covered, expected, "Level 0 should cover all nodes");

            let ids: std::collections::HashSet<&str> =
                r.iter().map(|c| c.id.as_str()).collect();
            for c in *r {
                if let Some(ref pid) = c.parent_id {
                    assert!(ids.contains(pid.as_str()),
                        "parent '{}' of '{}' not found", pid, c.id);
                }
            }
        }
    }

    // ── MemoryIndex 路径 ─────────────────────────────────────────────

    #[test]
    fn test_hierarchical_from_index_matches_graph() {
        let g = build_test_graph();
        let g_clone_nodes = g.nodes.clone();
        let g_clone_edges = g.edges.clone();
        let idx = MemoryIndex::from_existing_graph(g_clone_nodes, g_clone_edges);
        let from_idx = detect_hierarchical_communities_from_index(&idx, 42);
        let from_graph = detect_hierarchical_communities(&g, 42);

        let idx_l0: Vec<String> = from_idx.iter()
            .filter(|c| c.level == 0)
            .flat_map(|c| c.node_ids.clone())
            .collect();
        let graph_l0: Vec<String> = from_graph.iter()
            .filter(|c| c.level == 0)
            .flat_map(|c| c.node_ids.clone())
            .collect();
        assert_eq!(idx_l0.len(), graph_l0.len());
    }

    // ── 边界情况 ───────────────────────────────────────────────────

    #[test]
    fn test_condensation_all_singletons() {
        let mut g = Graph::new();
        for i in 0..20 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        let hierarchical = detect_hierarchical_communities(&g, 42);
        let level0: Vec<_> = hierarchical.iter().filter(|c| c.level == 0).collect();
        assert_eq!(level0.len(), 20, "20 singletons");
        let supers: Vec<_> = hierarchical.iter().filter(|c| c.level > 0).collect();
        assert_eq!(supers.len(), 0, "no super-communities when all singletons");
    }

    #[test]
    fn test_hierarchy_isolated_majority_no_super_explosion() {
        // 回归:大量孤立节点 + 少量强连通簇(di_syn 垃圾节点事故的退化形态)。
        // 孤立社区不得每层各造一个超节点 —— 修复前此处高层社区数 ≈ 孤立节点数 × 层数
        let mut g = Graph::new();
        for i in 0..200 {
            g.add_node(Node::new(format!("iso{}", i), format!("Iso{}", i), NodeKind::Symbol));
        }
        // 两个 K5 团 + 一条弱桥(保证基线产出 2 个真实社区且有跨社区边)
        for c in 0..2 {
            for i in 0..5 {
                g.add_node(Node::new(format!("c{}n{}", c, i), format!("C{}N{}", c, i), NodeKind::Symbol));
            }
            for i in 0..5 {
                for j in (i + 1)..5 {
                    g.add_edge_unchecked(Edge::new(
                        format!("c{}e{}{}", c, i, j),
                        format!("c{}n{}", c, i),
                        format!("c{}n{}", c, j),
                        EdgeKind::Calls,
                    ));
                }
            }
        }
        g.add_edge_unchecked(Edge::new("bridge", "c0n0", "c1n0", EdgeKind::Calls));

        let hierarchical = detect_hierarchical_communities(&g, 42);
        let supers: Vec<_> = hierarchical.iter().filter(|c| c.level > 0).collect();
        assert!(supers.len() <= 8,
            "孤立社区不应造超节点:高层社区数 {} 应有界(≤ 最大层数)", supers.len());
        for sc in &supers {
            assert!(sc.node_ids.len() >= 2,
                "高层社区 {} 仅 {} 个叶节点,疑似孤立节点超节点", sc.id, sc.node_ids.len());
        }
    }

    // ── 确定性 ──────────────────────────────────────────────────

    #[test]
    fn test_deterministic_same_seed() {
        let g = build_test_graph();
        let r1 = detect_communities(&g, 42);
        let r2 = detect_communities(&g, 42);
        assert_eq!(r1.len(), r2.len());
        for (a, b) in r1.iter().zip(r2.iter()) {
            assert_eq!(a.len(), b.len());
        }
    }

    // ── communities_and_hierarchy 集成正确性 ────────────────

    #[test]
    fn test_communities_and_hierarchy_combined() {
        let g = build_test_graph();
        let (flat, hier) = detect_communities_and_hierarchy(&g, 42);

        let standalone = detect_communities(&g, 42);
        assert_eq!(flat.len(), standalone.len(),
            "combined flat should match standalone detect_communities");

        let level0: Vec<_> = hier.iter().filter(|c| c.level == 0).collect();
        let mut covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        covered.sort();
        let mut expected: Vec<String> = g.node_ids().map(str::to_string).collect();
        expected.sort();
        assert_eq!(covered, expected);
    }

    // ── 稳定社区 ID 匹配 ─────────────────────────────────

    #[test]
    fn test_match_first_run_empty_old() {
        // 首次运行：无旧分配 → 顺序 ID 0, 1, 2, ...
        let comms = vec![
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["d".to_string(), "e".to_string()],
        ];
        let old: HashMap<String, usize> = HashMap::new();
        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids, vec![0, 1]);
    }

    #[test]
    fn test_match_same_graph_rerun_preserves_ids() {
        // 相同社区，重新运行 → 相同 ID
        let comms = vec![
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["d".to_string(), "e".to_string()],
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 5);
        old.insert("b".into(), 5);
        old.insert("c".into(), 5);
        old.insert("d".into(), 3);
        old.insert("e".into(), 3);

        let ids = match_communities_to_previous(&comms, &old);
        // 社区 {a,b,c} 应获得 ID 5，社区 {d,e} 应获得 ID 3
        assert!(ids.contains(&5));
        assert!(ids.contains(&3));
    }

    #[test]
    fn test_match_reordered_communities_preserve_ids() {
        // 相同内容，不同排序 → 相同 ID
        let comms_v1 = vec![
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["d".to_string(), "e".to_string()],
        ];
        let comms_v2 = vec![
            vec!["d".to_string(), "e".to_string()],
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 0);
        old.insert("b".into(), 0);
        old.insert("c".into(), 0);
        old.insert("d".into(), 1);
        old.insert("e".into(), 1);

        let ids_v1 = match_communities_to_previous(&comms_v1, &old);
        let ids_v2 = match_communities_to_previous(&comms_v2, &old);

        // 社区 {a,b,c} 在两种情况下都应获得 ID 0
        // 社区 {d,e} 在两种情况下都应获得 ID 1
        assert_eq!(ids_v1[0], 0); // {a,b,c} 在 v1 中排第一
        assert_eq!(ids_v1[1], 1); // {d,e} 在 v1 中排第二
        assert_eq!(ids_v2[0], 1); // {d,e} 在 v2 中排第一
        assert_eq!(ids_v2[1], 0); // {a,b,c} 在 v2 中排第二
    }

    #[test]
    fn test_match_new_community_gets_fresh_id() {
        let comms = vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["c".to_string(), "d".to_string()],
            vec!["e".to_string(), "f".to_string()],  // 新社区
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 0);
        old.insert("b".into(), 0);
        old.insert("c".into(), 1);
        old.insert("d".into(), 1);
        // e, f 是新节点 — 不在旧分配中

        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids[0], 0); // {a,b} → 0
        assert_eq!(ids[1], 1); // {c,d} → 1
        assert_eq!(ids[2], 2); // {e,f} → 新 ID 2
    }

    #[test]
    fn test_match_community_disappears_others_stable() {
        let comms = vec![
            vec!["a".to_string(), "b".to_string()],
            // 社区 {c,d} 已消失
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 0);
        old.insert("b".into(), 0);
        old.insert("c".into(), 7);
        old.insert("d".into(), 7);

        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids[0], 0); // {a,b} 保留 ID 0
        // ID 7 现在是孤立的，但没关系 — 只是未使用
    }

    // ── 增量路径的邻居投票 ─────────────────────────

    #[test]
    fn test_assign_communities_to_new_nodes_basic() {
        let mut g = Graph::new();
        // 已有 community_id 的节点
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(0);
        let mut n1 = Node::new("n1", "B", NodeKind::Symbol);
        n1.community_id = Some(0);
        let mut n2 = Node::new("n2", "C", NodeKind::Symbol);
        n2.community_id = Some(1);
        // 新节点 — 无 community_id
        let n3 = Node::new("n3", "D", NodeKind::Symbol);

        g.add_node(n0);
        g.add_node(n1);
        g.add_node(n2);
        g.add_node(n3);

        // n3 连接到 n0（社区 0）、n1（社区 0）和 n2（社区 1）
        g.add_edge_unchecked(Edge::new("e1", "n3", "n0", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "n3", "n1", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e3", "n3", "n2", EdgeKind::Calls));

        assign_communities_to_new_nodes(&mut g);

        // n3 应加入社区 0（2 票对 1 票）
        assert_eq!(g.get_node("n3").unwrap().community_id, Some(0));
    }

    #[test]
    fn test_assign_communities_no_neighbors_keeps_none() {
        let mut g = Graph::new();
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(0);
        let n1 = Node::new("n1", "B", NodeKind::Symbol); // 新节点，无社区

        g.add_node(n0);
        g.add_node(n1);
        // n0 和 n1 之间无边

        assign_communities_to_new_nodes(&mut g);

        // n1 没有带 community_id 的邻居 → 保持 None
        assert_eq!(g.get_node("n1").unwrap().community_id, None);
    }

    #[test]
    fn test_assign_communities_preserves_existing() {
        let mut g = Graph::new();
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(5);
        let n1 = Node::new("n1", "B", NodeKind::Symbol); // 新节点

        g.add_node(n0);
        g.add_node(n1);
        g.add_edge_unchecked(Edge::new("e1", "n0", "n1", EdgeKind::Calls));

        assign_communities_to_new_nodes(&mut g);

        // n0 保留其 community_id = 5
        assert_eq!(g.get_node("n0").unwrap().community_id, Some(5));
        // n1 从 n0 继承社区 5
        assert_eq!(g.get_node("n1").unwrap().community_id, Some(5));
    }

    #[test]
    fn test_match_merge_equal_overlap_deterministic() {
        // 两个旧社区合并为一个新社区，重叠数相等
        // — 最低旧 ID 必须总是获胜，不论 HashMap
        // 迭代顺序如何。
        let comms = vec![
            vec!["x".to_string(), "y".to_string(), "z".to_string(), "w".to_string()],
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("x".into(), 0);
        old.insert("y".into(), 0);
        old.insert("z".into(), 1);
        old.insert("w".into(), 1);

        // 与旧 ID 0 重叠为 2，与旧 ID 1 重叠为 2 → 平局 → 最低获胜
        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids, vec![0]);
    }

    #[test]
    fn test_match_split_competition_exclusive() {
        // 旧社区 5 拆分为两个新社区 — 只有较大的
        // 残余认领 ID 5；较小的获得新 ID（1:1 映射）。
        let comms = vec![
            vec!["a".to_string(), "b".to_string()],                     // 与 5 重叠 2
            vec!["c".to_string(), "d".to_string(), "e".to_string()],    // 与 5 重叠 3
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 5);
        old.insert("b".into(), 5);
        old.insert("c".into(), 5);
        old.insert("d".into(), 5);
        old.insert("e".into(), 5);

        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids[1], 5); // 较大残余保留 ID
        assert_eq!(ids[0], 6); // 较小残余获得新 ID（max old + 1）
    }

    #[test]
    fn test_assign_communities_returns_assigned_ids() {
        let mut g = Graph::new();
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(2);
        let n1 = Node::new("n1", "B", NodeKind::Symbol); // 新节点，将被分配
        let n2 = Node::new("n2", "C", NodeKind::Symbol); // 新节点，无邻居

        g.add_node(n0);
        g.add_node(n1);
        g.add_node(n2);
        g.add_edge_unchecked(Edge::new("e1", "n0", "n1", EdgeKind::Calls));

        let assigned = assign_communities_to_new_nodes(&mut g);

        // 仅 n1 被分配 — 调用方恰好持久化这些节点
        assert_eq!(assigned, vec!["n1".to_string()]);
    }
}