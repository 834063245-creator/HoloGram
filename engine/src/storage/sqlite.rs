// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SqliteDb — hologram.db 的持久化存储。
// 处理所有 SQLite 操作：schema 创建、批量 upsert、FTS5 搜索、
// 时间线事件、以及启动迁移。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use tracing::info;

use crate::graph::{EdgeKind, Node, NodeKind};

/// 包装单一 hologram.db 连接。
pub struct SqliteDb {
    conn: Connection,
    db_path: PathBuf,
}

impl SqliteDb {
    /// 在 `<project_root>/.hologram/hologram.db` 打开（或创建）数据库。
    /// 首次运行时创建 schema。
    pub fn open(project_root: &Path) -> Result<Self, String> {
        let hologram_dir = project_root.join(".hologram");
        std::fs::create_dir_all(&hologram_dir)
            .map_err(|e| format!("mkdir .hologram: {}", e))?;
        let db_path = hologram_dir.join("hologram.db");

        let conn = Connection::open(&db_path)
            .map_err(|e| format!("open hologram.db: {}", e))?;

        // 关键 pragma —— 连接打开时设置一次。
        // ponytail：WAL 模式下 synchronous=NORMAL 是安全的，且批量写入快约 2 倍。
        // SQLite 禁止在事务内修改 synchronous，所以在此设置。
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             PRAGMA auto_vacuum=INCREMENTAL;
             PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| format!("pragma: {}", e))?;

        let db = Self { conn, db_path };
        db.ensure_schema()?;
        db.migrate_fts5()?;
        Ok(db)
    }

    /// 检测并修复 v4.0 的 FTS5 schema 损坏（`node_id` 列与 `nodes.id` 不匹配）。
    /// 直接检查 FTS5 表定义；如果使用旧列名，则删除并重建 FTS5 索引及触发器，
    /// 然后从内容表重建。
    fn migrate_fts5(&self) -> Result<(), String> {
        // 检查 fts_nodes 是否存在且使用旧列名 `node_id`。
        let sql: String = self.conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_nodes'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();
        if !sql.contains("node_id") {
            return Ok(()); // 已正确或表尚未存在
        }
        info!("[sqlite] 正在迁移损坏的 FTS5 schema（node_id → id）");
        // 删除旧触发器（忽略错误 —— 可能不存在）
        for trig in &["nodes_ai", "nodes_ad", "nodes_au"] {
            let _ = self.conn.execute_batch(&format!("DROP TRIGGER {}", trig));
        }
        self.conn.execute_batch(
            "DROP TABLE IF EXISTS fts_nodes;
             CREATE VIRTUAL TABLE fts_nodes USING fts5(
                 id, name, location,
                 content=nodes,
                 content_rowid=rowid
             );
             CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
                 INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
             END;
             CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
                 INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
             END;
             CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
                 INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
                 INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
             END;
             INSERT INTO fts_nodes(fts_nodes) VALUES('rebuild');",
        )
            .map_err(|e| format!("fts5 migration: {}", e))?;
        info!("[sqlite] FTS5 迁移完成");
        Ok(())
    }

    /// 返回路径（用于诊断消息）。
    pub fn path(&self) -> &Path {
        &self.db_path
    }

    /// 用于时间线 I/O 的辅助连接 —— 避免阻塞图存储互斥锁。
    pub fn open_aux_connection(db_path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("open aux hologram.db: {}", e))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| format!("pragma aux: {}", e))?;
        Ok(conn)
    }

    /// 如果表不存在则创建。
    fn ensure_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS nodes (
                    rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
                    id          TEXT NOT NULL UNIQUE,
                    name        TEXT NOT NULL,
                    kind        TEXT NOT NULL,
                    location    TEXT,
                    properties  TEXT DEFAULT '{}',
                    out_degree  INTEGER DEFAULT 0,
                    in_degree   INTEGER DEFAULT 0,
                    position_x  REAL,
                    position_y  REAL,
                    position_z  REAL,
                    community_id INTEGER,
                    non_defines_in_degree INTEGER DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
                CREATE INDEX IF NOT EXISTS idx_nodes_location ON nodes(location);
                CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
                CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);

                CREATE TABLE IF NOT EXISTS edges (
                    id                  TEXT PRIMARY KEY,
                    source              TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    target              TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    kind                TEXT NOT NULL,
                    coupling_depth      INTEGER DEFAULT 0,
                    cross_file          INTEGER DEFAULT 0,
                    temporal_delay_sec  REAL
                );

                CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
                CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
                CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
                CREATE INDEX IF NOT EXISTS idx_edges_coupling ON edges(coupling_depth);
                CREATE INDEX IF NOT EXISTS idx_edges_source_target ON edges(source, target);

                CREATE TABLE IF NOT EXISTS timeline_events (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp   TEXT NOT NULL,
                    event_type  TEXT NOT NULL,
                    file        TEXT DEFAULT '',
                    summary     TEXT DEFAULT '',
                    properties  TEXT DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_timeline_ts ON timeline_events(timestamp);

                CREATE TABLE IF NOT EXISTS meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                );

                -- camelCase/PascalCase 分词搜索的名称段词汇表
                CREATE TABLE IF NOT EXISTS name_segment_vocab (
                    segment TEXT NOT NULL,
                    name TEXT NOT NULL,
                    PRIMARY KEY (segment, name)
                ) WITHOUT ROWID;

",
            )
            .map_err(|e| format!("ensure schema: {}", e))?;

        // 确保 FTS5 外部内容表存在
        self.conn
            .execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS fts_nodes USING fts5(
                    id,
                    name,
                    location,
                    content=nodes,
                    content_rowid=rowid
                );",
            )
            .map_err(|e| format!("fts5 table: {}", e))?;

        // FTS 同步触发器（通过类似 IF NOT EXISTS 的模式幂等 ——
        // rusqlite 不支持 CREATE TRIGGER IF NOT EXISTS，所以捕获 "already exists" 错误）。
        for trigger_sql in [
            "CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
                INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
            END;",
            "CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
                INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
            END;",
            "CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
                INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
                INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
            END;",
        ] {
            let _ = self.conn.execute_batch(trigger_sql);
            // 忽略 "already exists" —— 触发器在表创建时一次性创建。
        }

        // 如果不存在则初始化 schema 版本
        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')",
            [],
        );

        // 迁移：为 edges 表添加 metadata 列（v4.1）
        let _ = self.conn.execute(
            "ALTER TABLE edges ADD COLUMN metadata TEXT",
            [],
        );
        // 迁移：为 edges 表添加 lsp_resolved 列
        let _ = self.conn.execute(
            "ALTER TABLE edges ADD COLUMN lsp_resolved INTEGER DEFAULT 0",
            [],
        );

        // 迁移：为 nodes 表添加 non_defines_in_degree 列
        let _ = self.conn.execute(
            "ALTER TABLE nodes ADD COLUMN non_defines_in_degree INTEGER DEFAULT 0",
            [],
        );

        Ok(())
    }

    // ── 全表加载（用于 MemoryIndex 构建）──

    pub fn load_all_nodes(&self) -> Result<Vec<Node>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, kind, location, properties, out_degree, in_degree, position_x, position_y, position_z, community_id, non_defines_in_degree FROM nodes")
            .map_err(|e| format!("prepare nodes: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let kind_str: String = row.get(2)?;
                let kind = match kind_str.as_str() {
                    "symbol" => NodeKind::Symbol,
                    "function" => NodeKind::Function,
                    "class" => NodeKind::Class,
                    "module" => NodeKind::Module,
                    "file" => NodeKind::File,
                    "interface" => NodeKind::Interface,
                    "variable" => NodeKind::Variable,
                    "medium" => NodeKind::Medium,
                    "temporal" => NodeKind::Temporal,
                    _ => NodeKind::Symbol,
                };
                let props_str: String = row.get(4).unwrap_or_else(|_| "{}".into());
                let properties: serde_json::Value =
                    serde_json::from_str(&props_str).unwrap_or_default();
                let px: Option<f32> = row.get(7)?;
                let py: Option<f32> = row.get(8)?;
                let pz: Option<f32> = row.get(9)?;
                let position = match (px, py, pz) {
                    (Some(x), Some(y), Some(z)) => Some([x, y, z]),
                    _ => None,
                };
                Ok(Node {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind,
                    location: row.get(3)?,
                    snippet: None,
                    properties,
                    out_degree: row.get::<_, i64>(5).unwrap_or(0) as u32,
                    in_degree: row.get::<_, i64>(6).unwrap_or(0) as u32,
                    position,
                    community_id: row.get::<_, Option<i64>>(10).unwrap_or(None).map(|v| v as usize),
                    non_defines_in_degree: row.get::<_, i64>(11).unwrap_or(0) as u32,
                })
            })
            .map_err(|e| format!("query nodes: {}", e))?;
        let mut nodes = Vec::new();
        for row in rows {
            nodes.push(row.map_err(|e| format!("row error: {}", e))?);
        }
        Ok(nodes)
    }

    /// 返回 (source, target, kind, coupling_depth, temporal_delay_sec) 元组。
    pub fn load_all_edges(&self) -> Result<Vec<(String, String, EdgeKind, u8, Option<f64>)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT source, target, kind, coupling_depth, temporal_delay_sec FROM edges")
            .map_err(|e| format!("prepare edges: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let kind_str: String = row.get(2)?;
                let kind = edge_kind_from_str(&kind_str)
                    .unwrap_or_else(|msg| {
                        eprintln!("[hologram] {}", msg);
                        EdgeKind::Calls
                    });
                let depth: i64 = row.get(3)?;
                let delay: Option<f64> = row.get(4)?;
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, kind, depth as u8, delay))
            })
            .map_err(|e| format!("query edges: {}", e))?;
        let mut edges = Vec::new();
        for row in rows {
            edges.push(row.map_err(|e| format!("edge row: {}", e))?);
        }
        Ok(edges)
    }

    // ── 批量写入（全量分析 + 增量）──

    /// 用给定节点和边替换 SQLite 中的所有图数据。
    /// 使用分块多行 INSERT。批量加载优化：
    /// - 先删 FTS 触发器再 DELETE —— 否则删除阶段对每行旧节点
    ///   触发一次 FTS 'delete' 插入（155k 节点 ≈ 9s 的纯浪费）
    /// - 先删二级索引、插入后批量重建 —— CREATE INDEX 的排序构建
    ///   远快于逐行维护 B-tree（426k 边 × 5 索引曾是最大头）
    /// - 加载期间关闭外键检查 —— 输入来自 MemoryIndex，端点已保证存在；
    ///   FK 检查是每边 2 次 nodes(id) 查表
    /// - synchronous=OFF —— 派生缓存 DB，断电损坏重跑分析即可；提交后恢复
    /// SQLite 参数上限为 999；节点 12 列 → 66 行/块，边 6 列 → 150 行/块。
    pub fn bulk_replace_all(
        &self,
        nodes: &[&Node],
        edges: &[(&str, &str, EdgeKind, u8, Option<f64>)],
    ) -> Result<(), String> {
        let t_total = std::time::Instant::now();

        // foreign_keys 不能在事务内修改 —— 必须在 tx 开始前设置。
        self.conn
            .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA synchronous=OFF;")
            .map_err(|e| format!("pragma bulk: {}", e))?;

        let result = self.bulk_replace_inner(nodes, edges);

        // 无论成败都恢复连接级设置（失败时 tx 已随 drop 回滚）。
        let restore = self
            .conn
            .execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("pragma restore: {}", e));
        result?;
        restore?;
        eprintln!(
            "[sqlite] bulk_replace_all total={:.1}s ({} nodes, {} edges)",
            t_total.elapsed().as_secs_f64(),
            nodes.len(),
            edges.len()
        );
        Ok(())
    }

    /// bulk_replace_all 的事务主体。DDL（DROP/CREATE INDEX、DROP TRIGGER）
    /// 在 SQLite 中是事务性的，任何失败都随 tx 回滚，不留半残 schema。
    fn bulk_replace_inner(
        &self,
        nodes: &[&Node],
        edges: &[(&str, &str, EdgeKind, u8, Option<f64>)],
    ) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction()
            .map_err(|e| format!("tx: {}", e))?;

        tx.execute_batch("PRAGMA cache_size=-50000;")
            .map_err(|e| format!("pragma cache: {}", e))?;

        // 先删 FTS 触发器（保住 DELETE 阶段），再删二级索引（保住 INSERT 阶段）。
        tx.execute_batch("DROP TRIGGER IF EXISTS nodes_ai;
                          DROP TRIGGER IF EXISTS nodes_ad;
                          DROP TRIGGER IF EXISTS nodes_au;
                          DROP INDEX IF EXISTS idx_nodes_kind;
                          DROP INDEX IF EXISTS idx_nodes_location;
                          DROP INDEX IF EXISTS idx_nodes_name;
                          DROP INDEX IF EXISTS idx_nodes_community;
                          DROP INDEX IF EXISTS idx_edges_source;
                          DROP INDEX IF EXISTS idx_edges_target;
                          DROP INDEX IF EXISTS idx_edges_kind;
                          DROP INDEX IF EXISTS idx_edges_coupling;
                          DROP INDEX IF EXISTS idx_edges_source_target;")
            .map_err(|e| format!("drop triggers/indexes: {}", e))?;

        // 清除旧数据
        let t = std::time::Instant::now();
        tx.execute_batch("DELETE FROM edges; DELETE FROM nodes;")
            .map_err(|e| format!("delete: {}", e))?;
        let t_delete = t.elapsed().as_secs_f64();

        // ── 分块插入节点 ──
        let t = std::time::Instant::now();
        const NODE_CHUNK: usize = 66; // 12 列 × 66 = 792 参数，安全在 999 以内
        let node_sql = "INSERT INTO nodes (id, name, kind, location, properties, out_degree, in_degree, position_x, position_y, position_z, community_id, non_defines_in_degree) VALUES ";
        for chunk in nodes.chunks(NODE_CHUNK) {
            let mut sql = String::with_capacity(node_sql.len() + chunk.len() * 80);
            sql.push_str(node_sql);
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::with_capacity(chunk.len() * 12);
            for (i, node) in chunk.iter().enumerate() {
                if i > 0 { sql.push_str(", "); }
                let b = 1 + i * 12;
                sql.push_str(&format!("(?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{})",
                    b, b+1, b+2, b+3, b+4, b+5, b+6, b+7, b+8, b+9, b+10, b+11));
                let (px, py, pz) = match node.position {
                    Some([x, y, z]) => (Some(x as f64), Some(y as f64), Some(z as f64)),
                    None => (None, None, None),
                };
                let props = serde_json::to_string(&node.properties).unwrap_or_else(|_| "{}".into());
                params.push(Box::new(node.id.clone()));
                params.push(Box::new(node.name.clone()));
                params.push(Box::new(node.kind.as_str().to_string()));
                params.push(Box::new(node.location.clone()));
                params.push(Box::new(props));
                params.push(Box::new(node.out_degree as i64));
                params.push(Box::new(node.in_degree as i64));
                params.push(Box::new(px));
                params.push(Box::new(py));
                params.push(Box::new(pz));
                params.push(Box::new(node.community_id.map(|v| v as i64)));
                params.push(Box::new(node.non_defines_in_degree as i64));
            }
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            tx.execute(&sql, param_refs.as_slice())
                .map_err(|e| format!("insert node chunk: {}", e))?;
        }
        let t_nodes = t.elapsed().as_secs_f64();

        // ── 分块插入边 ──
        let t = std::time::Instant::now();
        const EDGE_CHUNK: usize = 150; // 6 列 × 150 = 900 参数
        let edge_sql = "INSERT INTO edges (id, source, target, kind, coupling_depth, temporal_delay_sec) VALUES ";
        for chunk in edges.chunks(EDGE_CHUNK) {
            let mut sql = String::with_capacity(edge_sql.len() + chunk.len() * 60);
            sql.push_str(edge_sql);
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::with_capacity(chunk.len() * 6);
            for (i, &(source, target, kind, coupling_depth, temporal_delay_sec)) in chunk.iter().enumerate() {
                if i > 0 { sql.push_str(", "); }
                let b = 1 + i * 6;
                sql.push_str(&format!("(?{}, ?{}, ?{}, ?{}, ?{}, ?{})", b, b+1, b+2, b+3, b+4, b+5));
                params.push(Box::new(format!("{}::{}::{}", source, target, kind.as_str())));
                params.push(Box::new(source.to_string()));
                params.push(Box::new(target.to_string()));
                params.push(Box::new(kind.as_str().to_string()));
                params.push(Box::new(coupling_depth as i64));
                params.push(Box::new(temporal_delay_sec));
            }
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            tx.execute(&sql, param_refs.as_slice())
                .map_err(|e| format!("insert edge chunk: {}", e))?;
        }
        let t_edges = t.elapsed().as_secs_f64();

        // ── 批量重建二级索引（定义与 ensure_schema 保持一致）──
        let t = std::time::Instant::now();
        tx.execute_batch(
            "CREATE INDEX idx_nodes_kind ON nodes(kind);
             CREATE INDEX idx_nodes_location ON nodes(location);
             CREATE INDEX idx_nodes_name ON nodes(name);
             CREATE INDEX idx_nodes_community ON nodes(community_id);
             CREATE INDEX idx_edges_source ON edges(source);
             CREATE INDEX idx_edges_target ON edges(target);
             CREATE INDEX idx_edges_kind ON edges(kind);
             CREATE INDEX idx_edges_coupling ON edges(coupling_depth);
             CREATE INDEX idx_edges_source_target ON edges(source, target);",
        ).map_err(|e| format!("recreate indexes: {}", e))?;
        let t_indexes = t.elapsed().as_secs_f64();

        // ── 重建 FTS 并重新创建触发器 ──
        let t = std::time::Instant::now();
        tx.execute_batch(
            "INSERT INTO fts_nodes(fts_nodes) VALUES('rebuild');
             CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
                 INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
             END;
             CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
                 INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
             END;
             CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
                 INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
                 INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
             END;",
        ).map_err(|e| format!("rebuild fts: {}", e))?;
        let t_fts = t.elapsed().as_secs_f64();

        tx.execute_batch("PRAGMA cache_size=-2000;")
            .map_err(|e| format!("pragma restore: {}", e))?;

        let t = std::time::Instant::now();
        tx.commit().map_err(|e| format!("commit: {}", e))?;
        let t_commit = t.elapsed().as_secs_f64();
        eprintln!("[sqlite] bulk_replace: delete={:.1}s nodes={:.1}s edges={:.1}s indexes={:.1}s fts={:.1}s commit={:.1}s",
            t_delete, t_nodes, t_edges, t_indexes, t_fts, t_commit);
        Ok(())
    }

    // ── 批量 upsert（增量更新）──

    /// 批量 upsert 节点。使用事务提升性能。
    pub fn batch_upsert_nodes(&self, nodes: &[&Node]) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("tx: {}", e))?;
        for node in nodes {
            let (px, py, pz) = match node.position {
                Some([x, y, z]) => (Some(x as f64), Some(y as f64), Some(z as f64)),
                None => (None, None, None),
            };
            let props = serde_json::to_string(&node.properties).unwrap_or_else(|_| "{}".into());
            tx.execute(
                "INSERT INTO nodes (id, name, kind, location, properties, out_degree, in_degree, position_x, position_y, position_z, community_id, non_defines_in_degree)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, kind=excluded.kind, location=excluded.location,
                    properties=excluded.properties, out_degree=excluded.out_degree,
                    in_degree=excluded.in_degree, position_x=excluded.position_x,
                    position_y=excluded.position_y, position_z=excluded.position_z,
                    community_id=excluded.community_id,
                    non_defines_in_degree=excluded.non_defines_in_degree",
                params![
                    node.id,
                    node.name,
                    node.kind.as_str(),
                    node.location,
                    props,
                    node.out_degree as i64,
                    node.in_degree as i64,
                    px,
                    py,
                    pz,
                    node.community_id.map(|v| v as i64),
                    node.non_defines_in_degree as i64,
                ],
            )
            .map_err(|e| format!("insert node {}: {}", node.id, e))?;
        }
        tx.commit().map_err(|e| format!("commit nodes: {}", e))?;
        Ok(())
    }

    /// 使用 (source, target, kind, coupling_depth, temporal_delay_sec) 元组批量 upsert 边。
    pub fn batch_upsert_edges(
        &self,
        edges: &[(&str, &str, EdgeKind, u8, Option<f64>)],
    ) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("tx: {}", e))?;
        for &(source, target, kind, coupling_depth, temporal_delay_sec) in edges {
            let id = format!("{}::{}::{}", source, target, kind.as_str());
            tx.execute(
                "INSERT INTO edges (id, source, target, kind, coupling_depth, temporal_delay_sec)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    coupling_depth=excluded.coupling_depth,
                    temporal_delay_sec=excluded.temporal_delay_sec",
                params![id, source, target, kind.as_str(), coupling_depth as i64, temporal_delay_sec],
            )
            .map_err(|e| format!("insert edge {}: {}", id, e))?;
        }
        tx.commit().map_err(|e| format!("commit edges: {}", e))?;
        Ok(())
    }

    // ── FTS5 搜索 ──

    pub fn fts_search(&self, query: &str, limit: usize) -> Result<Vec<String>, String> {
        // 清理：转义 FTS5 特殊字符，使用简单 MATCH
        let safe = query.replace(['"', '\''], "");
        let pattern = format!("\"{}\"", safe);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id FROM fts_nodes WHERE fts_nodes MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(|e| format!("fts prepare: {}", e))?;
        let rows = stmt
            .query_map(params![pattern, limit as i64], |row| row.get(0))
            .map_err(|e| format!("fts query: {}", e))?;
        let mut ids = Vec::new();
        for id in rows.flatten() {
            ids.push(id);
        }
        Ok(ids)
    }

    // ── 时间线事件 ──

    pub fn record_timeline(
        &self,
        event_type: &str,
        file: Option<&str>,
        summary: &str,
    ) -> Result<(), String> {
        timeline_record(&self.conn, event_type, file, summary)
    }

    /// 记录带自定义属性 JSON 的时间线事件。
    /// properties 必须是有效的 serde_json::Value —— 以 JSON 字符串存储。
    pub fn record_timeline_with_props(
        &self,
        event_type: &str,
        file: Option<&str>,
        summary: &str,
        properties: &serde_json::Value,
    ) -> Result<(), String> {
        timeline_record_with_props(&self.conn, event_type, file, summary, properties)
    }

    pub fn query_timeline(&self, limit: usize) -> Result<Vec<serde_json::Value>, String> {
        timeline_query(&self.conn, limit)
    }

    /// 运行增量 vacuum 以在大量增量更新后回收空间。
    pub fn incremental_vacuum(&self) -> Result<(), String> {
        self.conn
            .execute_batch("PRAGMA incremental_vacuum;")
            .map_err(|e| format!("vacuum: {}", e))
    }

    /// 获取底层连接（用于 Attach/detach 操作）。
    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}

const TIMELINE_KEEP: i64 = 10_000;

fn timeline_prune(conn: &Connection) {
    let _ = conn.execute(
        "DELETE FROM timeline_events WHERE id < (
            SELECT id FROM timeline_events ORDER BY id DESC LIMIT 1 OFFSET ?1
        )",
        params![TIMELINE_KEEP - 1],
    );
}

/// 在任意 hologram.db 连接上记录时间线事件（WAL 安全）。
pub fn timeline_record(
    conn: &Connection,
    event_type: &str,
    file: Option<&str>,
    summary: &str,
) -> Result<(), String> {
    let ts = chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    conn.execute(
        "INSERT INTO timeline_events (timestamp, event_type, file, summary, properties)
         VALUES (?1, ?2, ?3, ?4, '{}')",
        params![ts, event_type, file.unwrap_or(""), summary],
    )
    .map_err(|e| format!("timeline insert: {}", e))?;
    timeline_prune(conn);
    Ok(())
}

/// 在任意连接上记录带 JSON 属性的时间线事件。
pub fn timeline_record_with_props(
    conn: &Connection,
    event_type: &str,
    file: Option<&str>,
    summary: &str,
    properties: &serde_json::Value,
) -> Result<(), String> {
    let ts = chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let props_str = serde_json::to_string(properties).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO timeline_events (timestamp, event_type, file, summary, properties)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ts, event_type, file.unwrap_or(""), summary, props_str],
    )
    .map_err(|e| format!("timeline insert: {}", e))?;
    timeline_prune(conn);
    Ok(())
}

/// 在任意连接上查询最近的时间线事件。
pub fn timeline_query(conn: &Connection, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, event_type, file, summary, properties
             FROM timeline_events ORDER BY id DESC LIMIT ?",
        )
        .map_err(|e| format!("timeline prepare: {}", e))?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            let props_str: String = row.get(5).unwrap_or_else(|_| "{}".into());
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "timestamp": row.get::<_, String>(1)?,
                "event_type": row.get::<_, String>(2)?,
                "file": row.get::<_, String>(3).unwrap_or_default(),
                "summary": row.get::<_, String>(4).unwrap_or_default(),
                "properties": serde_json::from_str::<serde_json::Value>(&props_str).unwrap_or_default(),
            }))
        })
        .map_err(|e| format!("timeline query: {}", e))?;
    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("timeline row: {}", e))?);
    }
    Ok(events)
}

/// 从 SQLite 字符串解析边类型。
/// 未知类型返回错误，而非静默默认为 Calls。
fn edge_kind_from_str(s: &str) -> Result<EdgeKind, String> {
    match s {
        "imports" => Ok(EdgeKind::Imports),
        "calls" => Ok(EdgeKind::Calls),
        "inherits" => Ok(EdgeKind::Inherits),
        "defines" => Ok(EdgeKind::Defines),
        "reads" => Ok(EdgeKind::Reads),
        "writes" => Ok(EdgeKind::Writes),
        "shares" => Ok(EdgeKind::Shares),
        "triggers" => Ok(EdgeKind::Triggers),
        "awaits" => Ok(EdgeKind::Awaits),
        "sequences" => Ok(EdgeKind::Sequences),
        "usage" => Ok(EdgeKind::Usage),
        "throws" => Ok(EdgeKind::Throws),
        other => Err(format!("unknown edge kind: '{}'", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Node, NodeKind, EdgeKind};

    fn make_test_node(id: &str, kind: NodeKind) -> Node {
        let mut n = Node::new(id, id, kind);
        n.location = Some(format!("src/{}.rs:1", id));
        n.out_degree = 1;
        n.in_degree = 0;
        n.position = Some([1.0, 2.0, 3.0]);
        n.community_id = Some(42);
        n
    }

    #[test]
    fn test_all_node_kinds_survive_sqlite_roundtrip() {
        let tmp = std::env::temp_dir().join("hologram_test_node_kinds");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let db = SqliteDb::open(&tmp).unwrap();

        // 写入每种 NodeKind 变体各一个节点
        let all_kinds = [NodeKind::Symbol,
            NodeKind::Function,
            NodeKind::Class,
            NodeKind::Module,
            NodeKind::File,
            NodeKind::Interface,
            NodeKind::Medium,
            NodeKind::Temporal];
        let nodes: Vec<Node> = all_kinds.iter()
            .map(|k| make_test_node(k.as_str(), *k))
            .collect();
        let edges = vec![
            ("symbol", "function", EdgeKind::Calls, 1u8, None::<f64>),
        ];

        db.bulk_replace_all(&nodes.iter().collect::<Vec<_>>(), &edges).unwrap();

        // 读回并验证每种类型都被保留
        let loaded = db.load_all_nodes().unwrap();
        assert_eq!(loaded.len(), 8, "全部 8 个节点应在往返后保留");

        for node in &loaded {
            let expected_kind_str = node.id.as_str(); // we named nodes by their kind string
            let expected_kind = match expected_kind_str {
                "symbol" => NodeKind::Symbol,
                "function" => NodeKind::Function,
                "class" => NodeKind::Class,
                "module" => NodeKind::Module,
                "file" => NodeKind::File,
                "interface" => NodeKind::Interface,
                "medium" => NodeKind::Medium,
                "temporal" => NodeKind::Temporal,
                _ => panic!("意外的节点 id: {}", node.id),
            };
            assert_eq!(std::mem::discriminant(&node.kind), std::mem::discriminant(&expected_kind),
                "节点 '{}' 加载为 {:?}, 期望 {:?}", node.id, node.kind, expected_kind);
            // 验证其他字段也已保留
            assert_eq!(node.out_degree, 1);
            assert_eq!(node.in_degree, 0);
            assert_eq!(node.position, Some([1.0, 2.0, 3.0]));
            assert_eq!(node.community_id, Some(42));
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_edge_fields_survive_sqlite_roundtrip() {
        let tmp = std::env::temp_dir().join("hologram_test_edge_fields");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let db = SqliteDb::open(&tmp).unwrap();

        let nodes: Vec<Node> = vec![
            make_test_node("a", NodeKind::Symbol),
            make_test_node("b", NodeKind::Symbol),
        ];
        let edges: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = vec![
            ("a", "b", EdgeKind::Calls, 3u8, Some(0.5)),
            ("a", "b", EdgeKind::Reads, 2u8, None),
        ];

        db.bulk_replace_all(&nodes.iter().collect::<Vec<_>>(), &edges).unwrap();

        let loaded = db.load_all_edges().unwrap();
        assert_eq!(loaded.len(), 2);

        let calls = loaded.iter().find(|(_, _, k, _, _)| *k == EdgeKind::Calls).unwrap();
        assert_eq!(calls.3, 3); // coupling_depth
        assert_eq!(calls.4, Some(0.5)); // temporal_delay_sec

        let reads = loaded.iter().find(|(_, _, k, _, _)| *k == EdgeKind::Reads).unwrap();
        assert_eq!(reads.3, 2);
        assert!(reads.4.is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 批量加载优化的回归测试：二次 bulk_replace_all（走 DELETE 旧数据路径）后，
    /// 数据必须正确替换，FTS 触发器/二级索引/外键与 synchronous pragma 全部恢复。
    #[test]
    fn test_bulk_replace_all_twice_restores_schema() {
        let tmp = std::env::temp_dir().join("hologram_test_bulk_twice");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let db = SqliteDb::open(&tmp).unwrap();

        let nodes1: Vec<Node> = vec![
            make_test_node("alpha", NodeKind::Function),
            make_test_node("beta", NodeKind::Function),
        ];
        let edges1: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = vec![
            ("alpha", "beta", EdgeKind::Calls, 1u8, None),
        ];
        db.bulk_replace_all(&nodes1.iter().collect::<Vec<_>>(), &edges1).unwrap();

        // 第二次替换 —— 旧数据存在，走触发器/索引先删后建路径
        let nodes2: Vec<Node> = vec![
            make_test_node("gamma", NodeKind::Class),
            make_test_node("delta", NodeKind::Class),
        ];
        let edges2: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = vec![
            ("gamma", "delta", EdgeKind::Inherits, 2u8, None),
        ];
        db.bulk_replace_all(&nodes2.iter().collect::<Vec<_>>(), &edges2).unwrap();

        // 数据被完整替换
        let loaded_nodes = db.load_all_nodes().unwrap();
        assert_eq!(loaded_nodes.len(), 2);
        assert!(loaded_nodes.iter().all(|n| n.id == "gamma" || n.id == "delta"));
        let loaded_edges = db.load_all_edges().unwrap();
        assert_eq!(loaded_edges.len(), 1);
        assert_eq!(loaded_edges[0].2, EdgeKind::Inherits);

        // FTS 索引已重建且可搜索
        let hits = db.fts_search("gamma", 10).unwrap();
        assert_eq!(hits, vec!["gamma".to_string()]);

        // FTS 触发器已恢复 —— upsert 新节点后立即可搜到
        let extra = make_test_node("epsilon", NodeKind::Symbol);
        db.batch_upsert_nodes(&[&extra]).unwrap();
        let hits = db.fts_search("epsilon", 10).unwrap();
        assert_eq!(hits, vec!["epsilon".to_string()]);

        // 二级索引已重建
        for idx in [
            "idx_nodes_kind", "idx_nodes_location", "idx_nodes_name", "idx_nodes_community",
            "idx_edges_source", "idx_edges_target", "idx_edges_kind",
            "idx_edges_coupling", "idx_edges_source_target",
        ] {
            let count: i64 = db.conn()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    params![idx],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "索引 {} 应在 bulk_replace_all 后恢复", idx);
        }

        // pragma 已恢复
        let fk: i64 = db.conn().query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "foreign_keys 应恢复为 ON");
        let sync: i64 = db.conn().query_row("PRAGMA synchronous", [], |r| r.get(0)).unwrap();
        assert_eq!(sync, 1, "synchronous 应恢复为 NORMAL(1)");

        // 外键约束真实生效 —— 插入悬挂边必须失败
        let dangling: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = vec![
            ("gamma", "no_such_node", EdgeKind::Calls, 1u8, None),
        ];
        assert!(db.batch_upsert_edges(&dangling).is_err(),
            "FK 恢复后悬挂边插入应被拒绝");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[allow(dead_code)]
    fn _removed_dataflow_test() {
        // ponytail：数据流追踪存储已移除 —— 引擎现在只查询
    }
}
