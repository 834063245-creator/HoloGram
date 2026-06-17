// Mock data — realistic dependency graph for browser dev mode
// Models a made-up "Nebula" web framework project with ~40 nodes

// ── Graph nodes ──
const MOCK_NODES = [
  // Core — SYMBOL (blue)
  { id: "router", name: "Router", type: "class", location: "nebula/core/router.ts:12", properties: {} },
  { id: "middleware", name: "MiddlewareChain", type: "class", location: "nebula/core/middleware.ts:8", properties: {} },
  { id: "request", name: "Request", type: "class", location: "nebula/core/request.ts:5", properties: {} },
  { id: "response", name: "Response", type: "class", location: "nebula/core/response.ts:5", properties: {} },
  { id: "server", name: "Server", type: "class", location: "nebula/core/server.ts:20", properties: {} },
  { id: "config_loader", name: "ConfigLoader", type: "class", location: "nebula/core/config.ts:15", properties: {} },
  { id: "plugin_registry", name: "PluginRegistry", type: "class", location: "nebula/core/plugins.ts:22", properties: {} },
  { id: "error_handler", name: "ErrorHandler", type: "class", location: "nebula/core/errors.ts:10", properties: {} },
  { id: "route_parser", name: "route_parser", type: "function", location: "nebula/core/parser.ts:3", properties: {} },
  { id: "mime_resolver", name: "mime_resolver", type: "function", location: "nebula/core/mime.ts:7", properties: {} },
  { id: "auth_provider", name: "AuthProvider", type: "interface", location: "nebula/core/auth.ts:4", properties: {} },
  { id: "session_store", name: "SessionStore", type: "interface", location: "nebula/core/session.ts:6", properties: {} },

  // Data layer — MEDIUM (amber)
  { id: "database", name: "DatabasePool", type: "database", location: "nebula/data/database.ts:30", properties: {} },
  { id: "query_builder", name: "QueryBuilder", type: "class", location: "nebula/data/query.ts:18", properties: {} },
  { id: "model_base", name: "Model", type: "class", location: "nebula/data/model.ts:12", properties: {} },
  { id: "migration_runner", name: "MigrationRunner", type: "class", location: "nebula/data/migrations.ts:25", properties: {} },
  { id: "cache_store", name: "CacheStore", type: "cache", location: "nebula/data/cache.ts:14", properties: {} },
  { id: "redis_adapter", name: "RedisAdapter", type: "class", location: "nebula/data/redis.ts:20", properties: {} },
  { id: "file_storage", name: "FileStorage", type: "medium", location: "nebula/data/storage.ts:8", properties: {} },
  { id: "queue_broker", name: "QueueBroker", type: "queue", location: "nebula/data/queue.ts:22", properties: {} },

  // Utils & helpers — SYMBOL (blue)
  { id: "logger", name: "Logger", type: "class", location: "nebula/utils/logger.ts:10", properties: {} },
  { id: "validator", name: "Validator", type: "class", location: "nebula/utils/validate.ts:16", properties: {} },
  { id: "serializer", name: "Serializer", type: "class", location: "nebula/utils/serialize.ts:8", properties: {} },
  { id: "tokenizer", name: "tokenizer", type: "function", location: "nebula/utils/token.ts:4", properties: {} },
  { id: "rate_limiter", name: "RateLimiter", type: "class", location: "nebula/utils/ratelimit.ts:14", properties: {} },
  { id: "crypto_utils", name: "crypto_utils", type: "function", location: "nebula/utils/crypto.ts:6", properties: {} },
  { id: "email_sender", name: "EmailSender", type: "class", location: "nebula/utils/email.ts:20", properties: {} },

  // Temporal / Thread — TEMPORAL (purple)
  { id: "scheduler", name: "TaskScheduler", type: "temporal", location: "nebula/temporal/scheduler.ts:18", properties: {} },
  { id: "job_worker", name: "JobWorker", type: "thread", location: "nebula/temporal/worker.ts:22", properties: {} },
  { id: "cron_trigger", name: "CronTrigger", type: "trigger", location: "nebula/temporal/cron.ts:12", properties: {} },
  { id: "event_bus_internal", name: "EventBus", type: "class", location: "nebula/temporal/events.ts:15", properties: {} },
  { id: "timer_pool", name: "TimerPool", type: "timer", location: "nebula/temporal/timer.ts:28", properties: {} },
  { id: "worker_pool", name: "WorkerPool", type: "thread", location: "nebula/temporal/pool.ts:30", properties: {} },

  // External adapters — MEDIUM (amber)
  { id: "payment_gateway", name: "PaymentGateway", type: "medium", location: "nebula/adapters/payment.ts:15", properties: {} },
  { id: "s3_uploader", name: "S3Uploader", type: "medium", location: "nebula/adapters/s3.ts:22", properties: {} },
  { id: "smtp_client", name: "SMTPClient", type: "medium", location: "nebula/adapters/smtp.ts:18", properties: {} },
  { id: "oauth_flow", name: "OAuthFlow", type: "class", location: "nebula/adapters/oauth.ts:12", properties: {} },
  { id: "websocket_hub", name: "WebSocketHub", type: "class", location: "nebula/adapters/ws.ts:25", properties: {} },
];

// ── Edges ──
function makeEdge(id: string, source: string, target: string, type: string, depth = 1): any {
  return { id, source, target, type, properties: { coupling_depth: depth } };
}

const MOCK_EDGES = [
  // Core internal
  makeEdge("e1", "server", "router", "import", 1),
  makeEdge("e2", "server", "middleware", "import", 1),
  makeEdge("e3", "server", "config_loader", "import", 1),
  makeEdge("e4", "server", "plugin_registry", "import", 2),
  makeEdge("e5", "server", "error_handler", "import", 1),
  makeEdge("e6", "router", "route_parser", "import", 1),
  makeEdge("e7", "router", "request", "import", 1),
  makeEdge("e8", "router", "response", "import", 1),
  makeEdge("e9", "middleware", "request", "import", 2),
  makeEdge("e10", "middleware", "response", "import", 2),
  makeEdge("e11", "middleware", "auth_provider", "import", 2),
  makeEdge("e12", "middleware", "session_store", "import", 2),
  makeEdge("e13", "error_handler", "logger", "import", 1),
  makeEdge("e14", "error_handler", "response", "data", 2),
  makeEdge("e15", "mime_resolver", "response", "import", 1),
  makeEdge("e16", "config_loader", "file_storage", "import", 2),

  // Data layer
  makeEdge("e17", "model_base", "database", "import", 1),
  makeEdge("e18", "model_base", "query_builder", "import", 1),
  makeEdge("e19", "query_builder", "database", "data", 1),
  makeEdge("e20", "migration_runner", "database", "data", 1),
  makeEdge("e21", "migration_runner", "file_storage", "import", 2),
  makeEdge("e22", "cache_store", "redis_adapter", "import", 1),
  makeEdge("e23", "cache_store", "serializer", "import", 2),
  makeEdge("e24", "queue_broker", "redis_adapter", "import", 1),
  makeEdge("e25", "queue_broker", "serializer", "import", 2),
  makeEdge("e26", "file_storage", "s3_uploader", "import", 1),
  makeEdge("e27", "email_sender", "smtp_client", "import", 1),

  // Auth & sessions
  makeEdge("e28", "auth_provider", "crypto_utils", "import", 1),
  makeEdge("e29", "auth_provider", "database", "data", 2),
  makeEdge("e30", "session_store", "cache_store", "data", 1),
  makeEdge("e31", "session_store", "crypto_utils", "import", 2),
  makeEdge("e32", "auth_provider", "oauth_flow", "import", 2),
  makeEdge("e33", "oauth_flow", "payment_gateway", "import", 3),

  // Utils
  makeEdge("e34", "rate_limiter", "cache_store", "data", 1),
  makeEdge("e35", "rate_limiter", "tokenizer", "import", 2),
  makeEdge("e36", "validator", "serializer", "import", 1),
  makeEdge("e37", "validator", "logger", "import", 1),

  // Temporal
  makeEdge("e38", "scheduler", "job_worker", "temporal", 1),
  makeEdge("e39", "scheduler", "cron_trigger", "temporal", 1),
  makeEdge("e40", "scheduler", "queue_broker", "data", 2),
  makeEdge("e41", "job_worker", "database", "data", 2),
  makeEdge("e42", "job_worker", "logger", "import", 1),
  makeEdge("e43", "event_bus_internal", "job_worker", "temporal", 1),
  makeEdge("e44", "event_bus_internal", "websocket_hub", "temporal", 1),
  makeEdge("e45", "worker_pool", "job_worker", "temporal", 1),
  makeEdge("e46", "worker_pool", "timer_pool", "temporal", 1),
  makeEdge("e47", "timer_pool", "cache_store", "data", 2),

  // Cross-community
  makeEdge("e48", "server", "cache_store", "import", 2),
  makeEdge("e49", "router", "validator", "import", 2),
  makeEdge("e50", "middleware", "rate_limiter", "import", 2),
  makeEdge("e51", "server", "websocket_hub", "import", 2),
  makeEdge("e52", "scheduler", "email_sender", "import", 3),
  makeEdge("e53", "payment_gateway", "database", "data", 3),
  makeEdge("e54", "websocket_hub", "event_bus_internal", "temporal", 2),
  makeEdge("e55", "plugin_registry", "file_storage", "import", 3),

  // Some L3/L4 coupling edges (deeper coupling depth)
  { id: "e56", source: "router", target: "cache_store", type: "data", properties: { coupling_depth: 3 } },
  { id: "e57", source: "middleware", target: "database", type: "data", properties: { coupling_depth: 4 } },
  { id: "e58", source: "scheduler", target: "payment_gateway", type: "temporal", properties: { coupling_depth: 3 } },
  { id: "e59", source: "job_worker", target: "payment_gateway", type: "temporal", properties: { coupling_depth: 4 } },
  { id: "e60", source: "response", target: "serializer", type: "data", properties: { coupling_depth: 1 } },
];

// ── Communities ──
const MOCK_COMMUNITIES = [
  { id: "comm_core", label: "Core/HTTP Layer", node_ids: ["router", "middleware", "request", "response", "server", "route_parser", "mime_resolver", "error_handler", "auth_provider", "session_store"] },
  { id: "comm_data", label: "Data & Storage", node_ids: ["database", "query_builder", "model_base", "migration_runner", "cache_store", "redis_adapter", "file_storage", "queue_broker"] },
  { id: "comm_utils", label: "Utilities", node_ids: ["logger", "validator", "serializer", "tokenizer", "rate_limiter", "crypto_utils", "email_sender"] },
  { id: "comm_temporal", label: "Temporal & Async", node_ids: ["scheduler", "job_worker", "cron_trigger", "event_bus_internal", "timer_pool", "worker_pool"] },
  { id: "comm_adapters", label: "External Adapters", node_ids: ["payment_gateway", "s3_uploader", "smtp_client", "oauth_flow", "websocket_hub"] },
  { id: "comm_config", label: "Configuration", node_ids: ["config_loader", "plugin_registry"] },
];

// ── Build graph JSON ──
function buildMockGraph() {
  return {
    nodes: MOCK_NODES.map(n => ({ ...n })),
    edges: MOCK_EDGES.map(e => ({ ...e })),
    meta: {
      source_root: "/mock/nebula-project",
      language: "typescript",
      total_nodes: MOCK_NODES.length,
      total_edges: MOCK_EDGES.length,
      communities: MOCK_COMMUNITIES,
    },
  };
}

// ── Mock check result ──
function buildMockCheck(passed: boolean) {
  return {
    passed,
    timestamp: new Date().toISOString(),
    commit_hash: "a1b2c3d",
    changed_files: [
      "/mock/nebula-project/nebula/core/middleware.ts",
      "/mock/nebula-project/nebula/data/cache.ts",
      "/mock/nebula-project/nebula/temporal/scheduler.ts",
      "/mock/nebula-project/nebula/utils/ratelimit.ts",
    ],
    total_changed_files: 4,
    l5_violations: passed ? [] : [
      { signal: { description: "API签名变更: MiddlewareChain.process() 返回值类型变化", file_path: "nebula/core/middleware.ts", line: 42, level: 5, affected_nodes: ["middleware", "server"], graph_node_ids: ["middleware", "server"], old_value: "Promise<Response>", new_value: "Promise<Response | null>" } },
    ],
    l4_violations: [
      { signal: { description: "CacheStore 直接访问 DatabasePool 内部状态（跨层穿透）", file_path: "nebula/data/cache.ts", line: 88, level: 4, affected_nodes: ["cache_store", "database"], graph_node_ids: ["cache_store", "database"] } },
    ],
    l3_violations: [
      { signal: { description: "TaskScheduler 新增对 PaymentGateway 的延迟依赖", file_path: "nebula/temporal/scheduler.ts", line: 120, level: 3, affected_nodes: ["scheduler", "payment_gateway"], graph_node_ids: ["scheduler", "payment_gateway"] } },
    ],
    l2_violations: [
      { signal: { description: "RateLimiter 修改后波及 3 个模块", file_path: "nebula/utils/ratelimit.ts", line: 55, level: 2, affected_nodes: ["rate_limiter", "middleware", "cache_store", "tokenizer"], graph_node_ids: ["rate_limiter", "middleware", "cache_store", "tokenizer"] } },
    ],
    passed_checks: ["L1 可见破坏", "文件格式一致性", "类型检查通过", "导入排序正确"],
    blast_radius: 7,
    cross_community_edges: 3,
    new_cycles: 1,
    new_thread_conflicts: 0,
    api_signature_changes: 1,
  };
}

// ── Mock timeline events ──
const MOCK_TIMELINE = {
  events: [
    { id: 1, timestamp: new Date(Date.now() - 3600000).toISOString(), event_type: "commit", file: "", changed_by: "HoloGram", related_nodes: [], summary: "feat: 添加 WebSocket 实时推送支持" },
    { id: 2, timestamp: new Date(Date.now() - 3500000).toISOString(), event_type: "file_changed", file: "nebula/adapters/ws.ts", changed_by: "HoloGram", related_nodes: ["websocket_hub", "event_bus_internal"], summary: "新增 WebSocketHub 类" },
    { id: 3, timestamp: new Date(Date.now() - 3400000).toISOString(), event_type: "file_changed", file: "nebula/temporal/events.ts", changed_by: "HoloGram", related_nodes: ["event_bus_internal"], summary: "EventBus 增加广播通道" },
    { id: 4, timestamp: new Date(Date.now() - 1800000).toISOString(), event_type: "file_changed", file: "nebula/core/middleware.ts", changed_by: "HoloGram", related_nodes: ["middleware", "server", "rate_limiter"], summary: "重构中间件链执行逻辑" },
    { id: 5, timestamp: new Date(Date.now() - 1700000).toISOString(), event_type: "blindspot_detected", file: "nebula/data/cache.ts", changed_by: "system", related_nodes: ["cache_store", "database"], summary: "检测到 L4 封装穿透: CacheStore → DatabasePool" },
    { id: 6, timestamp: new Date(Date.now() - 900000).toISOString(), event_type: "file_changed", file: "nebula/utils/ratelimit.ts", changed_by: "HoloGram", related_nodes: ["rate_limiter", "middleware", "cache_store"], summary: "限流算法从固定窗口改为滑动窗口" },
    { id: 7, timestamp: new Date(Date.now() - 120000).toISOString(), event_type: "user_action", file: "", changed_by: "HoloGram", related_nodes: [], summary: "运行 hologram check" },
  ],
};

// ── Mock diff ──
const MOCK_DIFF = {
  is_empty: false,
  added_nodes: [
    { id: "websocket_hub", name: "WebSocketHub", type: "class" },
  ],
  removed_nodes: [],
  modified_nodes: [
    { id: "middleware", name: "MiddlewareChain", type: "class" },
    { id: "cache_store", name: "CacheStore", type: "cache" },
  ],
  added_edges: [
    { id: "e_new1", source: "websocket_hub", target: "event_bus_internal", type: "temporal" },
  ],
  removed_edges: [],
  modified_edges: [
    { id: "e57", source: "middleware", target: "database", type: "data" },
  ],
};

// ── Agent tool mock responses ──
const MOCK_TOOL_RESPONSES: Record<string, any> = {
  hologram_analyze: JSON.stringify({ nodes: MOCK_NODES.length, edges: MOCK_EDGES.length, communities: MOCK_COMMUNITIES.length }),
  hologram_explore: JSON.stringify({
    query: 'explore result',
    flow: { path: ['router', 'middleware', 'auth', 'database'], depth: 4 },
    blast_radius: { affected_nodes: 7, files: ['middleware.ts', 'auth.ts', 'cache.ts'], risk: 'medium' },
    relationships: { direct_deps: 5, indirect_deps: 12, coupling_score: 0.45 },
    source_code: '// See read_file_content for full source',
    architecture_alerts: [{ severity: 'info', message: 'Standard module pattern — no anomalies detected' }],
  }),
  hologram_neighbors: JSON.stringify({ node: "router", depth: 1, neighbors: ["request", "response", "route_parser", "server"], edge_count: 3 }),
  hologram_impact: JSON.stringify({ source: "router", max_depth: 3, reachable_count: 12, tree: { "router": ["request", "response"], "request": [], "response": ["serializer"] } }),
  hologram_path: JSON.stringify({ path: ["router", "response", "serializer"], length: 3 }),
  hologram_fragile: JSON.stringify([{ node: "database", fragility: 0.92, fan_in: 12, l4_count: 2 }, { node: "cache_store", fragility: 0.87, fan_in: 8, l4_count: 1 }, { node: "scheduler", fragility: 0.81, fan_in: 5, l4_count: 1 }]),
  hologram_cycle: JSON.stringify({ cycles: [{ nodes: ["cache_store", "redis_adapter", "serializer", "cache_store"], depth: 3 }], total: 1 }),
  hologram_coupling_report: JSON.stringify({ module: "router", l1: 12, l2: 5, l3: 2, l4: 0, fragility: 0.45, fan_in: 4, fan_out: 3 }),
  hologram_blindspots: JSON.stringify([{ pattern: "dynamic import", confidence: 0.75, location: "nebula/core/plugins.ts:35" }]),
  hologram_thread_conflicts: JSON.stringify([{ location: "nebula/temporal/worker.ts:45", severity: "high", description: "共享状态无锁写入" }]),
  hologram_timeline: JSON.stringify(MOCK_TIMELINE),
  hologram_community_report: JSON.stringify(MOCK_COMMUNITIES),
  hologram_graph_summary: JSON.stringify({ total_nodes: MOCK_NODES.length, total_edges: MOCK_EDGES.length, node_types: { class: 22, function: 8, database: 1, cache: 1, queue: 1, temporal: 1, thread: 2, trigger: 1, timer: 1, medium: 3, interface: 2 }, density: 0.042, communities: MOCK_COMMUNITIES.length }),
  hologram_run_check: JSON.stringify(buildMockCheck(false)),
  hologram_run_preflight: JSON.stringify({ risk: "medium", warnings: ["波及 7 个节点"], recommendations: ["建议拆分 middleware.ts"] }),
  hologram_run_health: JSON.stringify({ score: 72, trend: "declining", top_changed: ["middleware.ts", "cache.ts"], issues: ["L4 封装穿透增加"] }),
  read_file_content: `// nebula/core/middleware.ts (mock)
import { Request } from './request';
import { Response } from './response';
import { AuthProvider } from './auth';

export class MiddlewareChain {
  private handlers: Middleware[] = [];

  use(handler: Middleware): this {
    this.handlers.push(handler);
    return this;
  }

  async process(req: Request): Promise<Response | null> {
    let ctx = new RequestContext(req);
    for (const handler of this.handlers) {
      ctx = await handler(ctx);
      if (ctx.aborted) return null;
    }
    return ctx.response;
  }
}`,
  read_constraints: `# 全息仓约束配置 (mock)
constraints:
  routing:
    l5_irreversible: true
    l4_silent: true
    l3_delayed: true
    l2_blast: true
    l1_visible: false
  thresholds:
    blast_radius_max: 20
    cross_community_tolerance: 5
    api_signature_tolerance: 3
    l4_penetration_tolerance: 2
    l4_threshold_change_tolerance: 5
  allowlist:
    modules:
      - "nebula.utils.logger"
      - "nebula.utils.tokenizer"
    files:
      - "*.test.ts"
      - "*.spec.ts"
  denylist:
    keywords:
      - "deprecated"
      - "internal-only"
`,
  exec_command: `(mock terminal output)
C:\\mock\\nebula-project> echo hello
hello

C:\\mock\\nebula-project> dir
nebula/  package.json  tsconfig.json  README.md`,
  hologram_diff: JSON.stringify(MOCK_DIFF),

  // Write commands (no-op in mock)
  write_constraints: "(mock: constraints saved)",
  write_file_content: "(mock: file saved)",

  // ── File tree ──
  list_directory: [
    { name: "nebula", path: "/mock/nebula-project/nebula", is_dir: true, children: [
      { name: "core", path: "/mock/nebula-project/nebula/core", is_dir: true, children: [
        { name: "router.ts", path: "/mock/nebula-project/nebula/core/router.ts", is_dir: false, children: null },
        { name: "middleware.ts", path: "/mock/nebula-project/nebula/core/middleware.ts", is_dir: false, children: null },
        { name: "request.ts", path: "/mock/nebula-project/nebula/core/request.ts", is_dir: false, children: null },
        { name: "response.ts", path: "/mock/nebula-project/nebula/core/response.ts", is_dir: false, children: null },
        { name: "server.ts", path: "/mock/nebula-project/nebula/core/server.ts", is_dir: false, children: null },
        { name: "config.ts", path: "/mock/nebula-project/nebula/core/config.ts", is_dir: false, children: null },
        { name: "plugins.ts", path: "/mock/nebula-project/nebula/core/plugins.ts", is_dir: false, children: null },
        { name: "errors.ts", path: "/mock/nebula-project/nebula/core/errors.ts", is_dir: false, children: null },
        { name: "parser.ts", path: "/mock/nebula-project/nebula/core/parser.ts", is_dir: false, children: null },
        { name: "mime.ts", path: "/mock/nebula-project/nebula/core/mime.ts", is_dir: false, children: null },
        { name: "auth.ts", path: "/mock/nebula-project/nebula/core/auth.ts", is_dir: false, children: null },
        { name: "session.ts", path: "/mock/nebula-project/nebula/core/session.ts", is_dir: false, children: null },
      ]},
      { name: "data", path: "/mock/nebula-project/nebula/data", is_dir: true, children: [
        { name: "database.ts", path: "/mock/nebula-project/nebula/data/database.ts", is_dir: false, children: null },
        { name: "query.ts", path: "/mock/nebula-project/nebula/data/query.ts", is_dir: false, children: null },
        { name: "model.ts", path: "/mock/nebula-project/nebula/data/model.ts", is_dir: false, children: null },
        { name: "migrations.ts", path: "/mock/nebula-project/nebula/data/migrations.ts", is_dir: false, children: null },
        { name: "cache.ts", path: "/mock/nebula-project/nebula/data/cache.ts", is_dir: false, children: null },
        { name: "redis.ts", path: "/mock/nebula-project/nebula/data/redis.ts", is_dir: false, children: null },
        { name: "storage.ts", path: "/mock/nebula-project/nebula/data/storage.ts", is_dir: false, children: null },
        { name: "queue.ts", path: "/mock/nebula-project/nebula/data/queue.ts", is_dir: false, children: null },
      ]},
      { name: "utils", path: "/mock/nebula-project/nebula/utils", is_dir: true, children: [
        { name: "logger.ts", path: "/mock/nebula-project/nebula/utils/logger.ts", is_dir: false, children: null },
        { name: "validate.ts", path: "/mock/nebula-project/nebula/utils/validate.ts", is_dir: false, children: null },
        { name: "serialize.ts", path: "/mock/nebula-project/nebula/utils/serialize.ts", is_dir: false, children: null },
        { name: "token.ts", path: "/mock/nebula-project/nebula/utils/token.ts", is_dir: false, children: null },
        { name: "ratelimit.ts", path: "/mock/nebula-project/nebula/utils/ratelimit.ts", is_dir: false, children: null },
        { name: "crypto.ts", path: "/mock/nebula-project/nebula/utils/crypto.ts", is_dir: false, children: null },
        { name: "email.ts", path: "/mock/nebula-project/nebula/utils/email.ts", is_dir: false, children: null },
      ]},
      { name: "temporal", path: "/mock/nebula-project/nebula/temporal", is_dir: true, children: [
        { name: "scheduler.ts", path: "/mock/nebula-project/nebula/temporal/scheduler.ts", is_dir: false, children: null },
        { name: "worker.ts", path: "/mock/nebula-project/nebula/temporal/worker.ts", is_dir: false, children: null },
        { name: "cron.ts", path: "/mock/nebula-project/nebula/temporal/cron.ts", is_dir: false, children: null },
        { name: "events.ts", path: "/mock/nebula-project/nebula/temporal/events.ts", is_dir: false, children: null },
        { name: "timer.ts", path: "/mock/nebula-project/nebula/temporal/timer.ts", is_dir: false, children: null },
        { name: "pool.ts", path: "/mock/nebula-project/nebula/temporal/pool.ts", is_dir: false, children: null },
      ]},
      { name: "adapters", path: "/mock/nebula-project/nebula/adapters", is_dir: true, children: [
        { name: "payment.ts", path: "/mock/nebula-project/nebula/adapters/payment.ts", is_dir: false, children: null },
        { name: "s3.ts", path: "/mock/nebula-project/nebula/adapters/s3.ts", is_dir: false, children: null },
        { name: "smtp.ts", path: "/mock/nebula-project/nebula/adapters/smtp.ts", is_dir: false, children: null },
        { name: "oauth.ts", path: "/mock/nebula-project/nebula/adapters/oauth.ts", is_dir: false, children: null },
        { name: "ws.ts", path: "/mock/nebula-project/nebula/adapters/ws.ts", is_dir: false, children: null },
      ]},
    ]},
    { name: "package.json", path: "/mock/nebula-project/package.json", is_dir: false, children: null },
    { name: "tsconfig.json", path: "/mock/nebula-project/tsconfig.json", is_dir: false, children: null },
    { name: "README.md", path: "/mock/nebula-project/README.md", is_dir: false, children: null },
  ],
};

// ── Mock invoke dispatcher ──
export function mockInvoke(cmd: string, args?: Record<string, unknown>): string {
  // Commands that return the full graph
  if (cmd === 'analyze_and_load' || cmd === 'load_graph_json') {
    return JSON.stringify(buildMockGraph());
  }

  // Check
  if (cmd === 'hologram_run_check') {
    return JSON.stringify(buildMockCheck(false));
  }

  // Watcher (no-op)
  if (cmd === 'start_watching' || cmd === 'stop_watching') {
    return '(mock: watcher not available in browser)';
  }

  // Look up in mock responses
  if (cmd in MOCK_TOOL_RESPONSES) {
    return MOCK_TOOL_RESPONSES[cmd];
  }

  // Fallback
  console.warn(`[mock] Unhandled command: ${cmd}`, args);
  return JSON.stringify({ mock: true, cmd, note: 'No mock data for this command' });
}
