import Database from "better-sqlite3";
import { assertEnvValid, immediateRiskLevelsFromEnv, isLongRunMode, isSchemaMigrationAllowed, runModeFromEnv } from "./config/env";
import { redactSensitiveData, redactSensitiveText } from "./security/redact";
import { assertDecisionBriefPayload } from "./decisionBrief";
import type {
  Project, Cycle, Agent, Task, FeedbackItem, Prediction, Observation,
  KnowledgeItem, HumanGateItem, DecisionLogItem, EventLogItem, LlmCall, AgentRun,
  ExternalFeedbackSource, TraceEventItem, ActionLedgerRow,
  KnowledgeReviewItem, ExternalBusinessSignal, OrgModule, ReviewSessionItem, NotificationDigestItem,
  SensorErrorAccumulator, PendingAttribution, DistillerProposal, GoldCase,
} from "@shared/schema";

assertEnvValid();

const sqlite = new Database(process.env.ALAYA_DB_PATH ?? "data.db");
sqlite.pragma("journal_mode = WAL");

export const rawDb = sqlite;

const REQUIRED_TABLES = [
  "projects",
  "cycles",
  "agents",
  "tasks",
  "feedback_items",
  "predictions",
  "observations",
  "knowledge_items",
  "human_gate_items",
  "review_sessions",
  "notification_digests",
  "decision_log",
  "event_log",
  "llm_calls",
  "agent_runs",
  "external_feedback_sources",
  "trace_events",
  "action_ledger",
  "knowledge_review_items",
  "external_business_signals",
  "sensor_error_accumulators",
  "pending_attributions",
  "distiller_proposals",
  "gold_cases",
  "org_modules",
];

const REQUIRED_COLUMNS: Record<string, string[]> = {
  cycles: [
    "speculative",
    "parent_cycle_id",
    "depends_on",
    "assumed_outcomes",
    "draft_status",
    "apply_scheduled_at",
    "applied_at",
    "co_applied_set",
  ],
  llm_calls: ["input_token_count", "output_token_count", "llm_failure_type", "token_source"],
  knowledge_items: ["usage_count", "last_injected_at", "last_verified_at", "last_decayed_at", "semantic_key"],
  external_feedback_sources: ["config", "status", "last_synced_at"],
  action_ledger: ["idempotency_key", "status", "payload"],
  trace_events: ["trace_id", "span_id", "attributes"],
  knowledge_review_items: ["status", "resolution"],
  external_business_signals: ["dedupe_key", "risk_level", "gate_id"],
  sensor_error_accumulators: ["event_timestamps_ms", "last_seen_at"],
  pending_attributions: ["status", "gate_id", "resolved_at"],
  distiller_proposals: ["regression_status", "regression_failed_cases", "gate_id", "status"],
  gold_cases: ["project_id", "active", "retired_reason", "last_confirmed_at", "source_proposal_id"],
  org_modules: ["version_label", "knowledge_id"],
  human_gate_items: [
    "notify_policy",
    "defer_until",
    "reject_reason_code",
    "review_dwell_ms",
    "evidence_revalidated_at",
    "evidence_changed",
    "missed_windows",
  ],
};

const REQUIRED_TABLE_SET = new Set(REQUIRED_TABLES);

function tableColumns(table: string): Set<string> {
  if (!REQUIRED_TABLE_SET.has(table)) {
    throw new Error(`Refusing PRAGMA table_info for unknown table: ${table}`);
  }
  return new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

for (const table of Object.keys(REQUIRED_COLUMNS)) {
  if (!REQUIRED_TABLE_SET.has(table)) {
    throw new Error(`REQUIRED_COLUMNS references unknown table: ${table}`);
  }
}

function shouldRunImportMigrations(): boolean {
  const mode = runModeFromEnv();
  return !isLongRunMode(mode) || isSchemaMigrationAllowed();
}

function assertSchemaReady() {
  const rows = sqlite.prepare(`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')
  `).all() as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));
  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) => {
    if (!existing.has(table)) return [];
    const columnsForTable = tableColumns(table);
    return columns.filter((column) => !columnsForTable.has(column)).map((column) => `${table}.${column}`);
  });
  if (missing.length > 0 || missingColumns.length > 0) {
    throw new Error(
      `Database schema is not initialized for ${runModeFromEnv()} mode. ` +
      `Missing tables: ${missing.join(", ") || "none"}; missing columns: ${missingColumns.join(", ") || "none"}. ` +
      "Run npm run ops:migrate with ALAYA_CAP_DATABASE_MIGRATION=true during a reviewed migration window.",
    );
  }
}

// ---------------- DDL ----------------
export function runSchemaMigrations() {
  if (isLongRunMode(runModeFromEnv()) && !isSchemaMigrationAllowed()) {
    throw new Error(
      `Database schema migration is disabled in ${runModeFromEnv()} mode. ` +
      "Run scripts/pre-upgrade-check.mjs, back up state, then run npm run ops:migrate with ALAYA_CAP_DATABASE_MIGRATION=true for the reviewed migration window.",
    );
  }
  sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, direction TEXT NOT NULL,
    target_user TEXT NOT NULL, redlines TEXT NOT NULL DEFAULT '[]',
    weekly_human_minutes INTEGER NOT NULL DEFAULT 150,
    weekly_llm_budget_cents INTEGER NOT NULL DEFAULT 100,
    first_claim_metric TEXT NOT NULL DEFAULT 'activation_rate',
    first_claim_operator TEXT NOT NULL DEFAULT '>=',
    first_claim_target REAL NOT NULL DEFAULT 0.3,
    seed_identity TEXT NOT NULL DEFAULT '', world_model TEXT NOT NULL DEFAULT '',
    current_cycle_idx INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS cycles (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idx INTEGER NOT NULL,
    goal TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planning',
    e_cycle REAL, worst_claim_error REAL, reasoning TEXT NOT NULL DEFAULT '',
    speculative INTEGER NOT NULL DEFAULT 0,
    parent_cycle_id TEXT,
    depends_on TEXT,
    assumed_outcomes TEXT,
    draft_status TEXT,
    apply_scheduled_at TEXT,
    applied_at TEXT,
    co_applied_set TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, agent TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', spec TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS feedback_items (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, text TEXT NOT NULL,
    category TEXT NOT NULL, sentiment TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'scenario',
    source_ref TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    topic_key TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    external_updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS predictions (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, belief TEXT NOT NULL DEFAULT '',
    prediction TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
    claims TEXT NOT NULL DEFAULT '[]', observation TEXT, prediction_error REAL,
    worst_claim_error REAL, error_type TEXT, update_target TEXT,
    status TEXT NOT NULL DEFAULT 'open', knowledge_refs TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, prediction_id TEXT NOT NULL,
    metric TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL, source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '', evidence_alpha REAL NOT NULL DEFAULT 1,
    evidence_beta REAL NOT NULL DEFAULT 1, confidence_score REAL NOT NULL DEFAULT 0.5,
    confidence_level TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL DEFAULT 'draft',
    human_approved_count INTEGER NOT NULL DEFAULT 0, external_verified_count INTEGER NOT NULL DEFAULT 0,
    valid_from TEXT NOT NULL DEFAULT '', valid_until TEXT,
    last_validated_cycle INTEGER NOT NULL DEFAULT 0, created_by_cycle INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT 'distiller', approved_by TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0, last_injected_at INTEGER, last_verified_at INTEGER,
    last_decayed_at INTEGER,
    gray_streak INTEGER NOT NULL DEFAULT 0,
    storage_strength REAL NOT NULL DEFAULT 1.0, novelty_score REAL, source_round INTEGER,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '', superseded_by TEXT, semantic_key TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS human_gate_items (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, type TEXT NOT NULL,
    blocking INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending', estimated_minutes INTEGER NOT NULL DEFAULT 10,
    decision TEXT,
    notify_policy TEXT NOT NULL DEFAULT 'next_window',
    defer_until TEXT,
    reject_reason_code TEXT,
    review_dwell_ms INTEGER,
    evidence_revalidated_at TEXT,
    evidence_changed INTEGER NOT NULL DEFAULT 0,
    missed_windows INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS review_sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'scheduled',
    opened_at TEXT NOT NULL, closed_at TEXT,
    gates_total INTEGER NOT NULL DEFAULT 0,
    gates_resolved INTEGER NOT NULL DEFAULT 0,
    gates_deferred INTEGER NOT NULL DEFAULT 0,
    digest_message_id TEXT, summary_message_id TEXT
  );
  CREATE TABLE IF NOT EXISTS notification_digests (
    project_id TEXT NOT NULL, window_date TEXT NOT NULL, window_label TEXT NOT NULL,
    sent_at TEXT NOT NULL, message_id TEXT,
    UNIQUE(project_id, window_date, window_label)
  );
  CREATE TABLE IF NOT EXISTS decision_log (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, gate_type TEXT NOT NULL,
    decision TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_idx INTEGER NOT NULL DEFAULT 0,
    actor TEXT NOT NULL, table_name TEXT NOT NULL, op TEXT NOT NULL,
    before TEXT, after TEXT, ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT NOT NULL, agent TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'mock', model TEXT NOT NULL DEFAULT 'mock',
    route_reason TEXT NOT NULL DEFAULT 'default',
    prompt_version TEXT NOT NULL, input_summary TEXT NOT NULL DEFAULT '',
    output_summary TEXT NOT NULL DEFAULT '', schema_valid INTEGER NOT NULL DEFAULT 1,
    retry_count INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
    input_token_count INTEGER NOT NULL DEFAULT 0, output_token_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0, token_source TEXT NOT NULL DEFAULT 'estimated',
    estimated_cost REAL NOT NULL DEFAULT 0, ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trace_events (
    id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
    parent_span_id TEXT, project_id TEXT NOT NULL, cycle_id TEXT, cycle_idx INTEGER,
    kind TEXT NOT NULL, name TEXT NOT NULL, agent TEXT, status TEXT NOT NULL DEFAULT 'ok',
    attributes TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL, ended_at TEXT,
    duration_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS action_ledger (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cycle_id TEXT,
    action_type TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', risk_level TEXT NOT NULL,
    requires_approval INTEGER NOT NULL DEFAULT 0, approval_gate_id TEXT,
    idempotency_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed',
    rollback_plan TEXT, audit_summary TEXT, payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT NOT NULL, cycle_idx INTEGER NOT NULL,
    agent TEXT NOT NULL, action TEXT NOT NULL, output_summary TEXT NOT NULL DEFAULT '',
    knowledge_refs_used TEXT NOT NULL DEFAULT '[]', ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS external_feedback_sources (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active',
    last_synced_at TEXT, created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS knowledge_review_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cycle_id TEXT,
    review_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'review_required',
    primary_knowledge_id TEXT NOT NULL, related_knowledge_id TEXT,
    reason TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '{}',
    recommended_action TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    resolved_at TEXT, resolved_by TEXT, resolution TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS external_business_signals (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
    project_id TEXT NOT NULL, signal_type TEXT NOT NULL, observed_at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}', sensitivity_level TEXT NOT NULL,
    dedupe_key TEXT NOT NULL, risk_level TEXT NOT NULL,
    feedback_id TEXT, gate_id TEXT, created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sensor_error_accumulators (
    fingerprint TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL,
    error_kind TEXT NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 0,
    event_timestamps_ms TEXT NOT NULL DEFAULT '[]',
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS pending_attributions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    error_type TEXT, claim_error REAL, context TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    gate_id TEXT, resolved_at TEXT, created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS distiller_proposals (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cycle_id TEXT NOT NULL,
    proposal_type TEXT NOT NULL, target_knowledge_id TEXT,
    proposed_content TEXT NOT NULL DEFAULT '{}',
    attribution_basis TEXT NOT NULL DEFAULT '{}',
    regression_status TEXT NOT NULL DEFAULT 'pending',
    regression_failed_cases TEXT,
    gate_id TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gold_cases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    expected_error_type TEXT,
    expected_route TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    retired_reason TEXT,
    last_confirmed_at TEXT,
    source_proposal_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS org_modules (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, module_name TEXT NOT NULL,
    problem_solved TEXT NOT NULL DEFAULT '', owner_role TEXT NOT NULL DEFAULT '',
    responsibility_boundaries TEXT NOT NULL DEFAULT '[]',
    upstream_dependencies TEXT NOT NULL DEFAULT '[]',
    downstream_consumers TEXT NOT NULL DEFAULT '[]',
    data_inputs TEXT NOT NULL DEFAULT '[]', data_outputs TEXT NOT NULL DEFAULT '[]',
    call_chain TEXT NOT NULL DEFAULT '[]', mvp_definition TEXT NOT NULL DEFAULT '',
    test_plan TEXT NOT NULL DEFAULT '', execution_plan TEXT NOT NULL DEFAULT '',
    known_pitfalls TEXT NOT NULL DEFAULT '[]', redlines TEXT NOT NULL DEFAULT '[]',
    version_label TEXT NOT NULL DEFAULT 'v1', knowledge_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  `);

  const projectColumns = tableColumns("projects");
  if (!projectColumns.has("weekly_llm_budget_cents")) {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN weekly_llm_budget_cents INTEGER NOT NULL DEFAULT 100`);
  }
  const projectColumnSpecs: Array<[string, string]> = [
    ["first_claim_metric", "TEXT NOT NULL DEFAULT 'activation_rate'"],
    ["first_claim_operator", "TEXT NOT NULL DEFAULT '>='"],
    ["first_claim_target", "REAL NOT NULL DEFAULT 0.3"],
  ];
  for (const [name, spec] of projectColumnSpecs) {
    if (!projectColumns.has(name)) sqlite.exec(`ALTER TABLE projects ADD COLUMN ${name} ${spec}`);
  }

  const cycleColumns = tableColumns("cycles");
  const cycleColumnSpecs: Array<[string, string]> = [
    ["speculative", "INTEGER NOT NULL DEFAULT 0"],
    ["parent_cycle_id", "TEXT"],
    ["depends_on", "TEXT"],
    ["assumed_outcomes", "TEXT"],
    ["draft_status", "TEXT"],
    ["apply_scheduled_at", "TEXT"],
    ["applied_at", "TEXT"],
    ["co_applied_set", "TEXT"],
  ];
  for (const [name, spec] of cycleColumnSpecs) {
    if (!cycleColumns.has(name)) sqlite.exec(`ALTER TABLE cycles ADD COLUMN ${name} ${spec}`);
  }

  const feedbackColumns = tableColumns("feedback_items");
  const feedbackColumnSpecs: Array<[string, string]> = [
    ["source_type", "TEXT NOT NULL DEFAULT 'scenario'"],
    ["source_ref", "TEXT NOT NULL DEFAULT ''"],
    ["source_url", "TEXT NOT NULL DEFAULT ''"],
    ["topic_key", "TEXT NOT NULL DEFAULT ''"],
    ["summary", "TEXT NOT NULL DEFAULT ''"],
    ["external_updated_at", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, spec] of feedbackColumnSpecs) {
    if (!feedbackColumns.has(name)) sqlite.exec(`ALTER TABLE feedback_items ADD COLUMN ${name} ${spec}`);
  }

  const knowledgeColumns = tableColumns("knowledge_items");
  const knowledgeColumnSpecs: Array<[string, string]> = [
    ["usage_count", "INTEGER NOT NULL DEFAULT 0"],
    ["last_injected_at", "INTEGER"],
    ["last_verified_at", "INTEGER"],
    ["last_decayed_at", "INTEGER"],
    ["gray_streak", "INTEGER NOT NULL DEFAULT 0"],
    ["storage_strength", "REAL NOT NULL DEFAULT 1.0"],
    ["novelty_score", "REAL"],
    ["source_round", "INTEGER"],
    ["superseded_by", "TEXT"],
    ["semantic_key", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, spec] of knowledgeColumnSpecs) {
    if (!knowledgeColumns.has(name)) sqlite.exec(`ALTER TABLE knowledge_items ADD COLUMN ${name} ${spec}`);
  }

  const gateColumns = tableColumns("human_gate_items");
  const gateColumnSpecs: Array<[string, string]> = [
    ["notify_policy", "TEXT NOT NULL DEFAULT 'next_window'"],
    ["defer_until", "TEXT"],
    ["reject_reason_code", "TEXT"],
    ["review_dwell_ms", "INTEGER"],
    ["evidence_revalidated_at", "TEXT"],
    ["evidence_changed", "INTEGER NOT NULL DEFAULT 0"],
    ["missed_windows", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, spec] of gateColumnSpecs) {
    if (!gateColumns.has(name)) sqlite.exec(`ALTER TABLE human_gate_items ADD COLUMN ${name} ${spec}`);
  }

  const llmColumns = tableColumns("llm_calls");
  const llmColumnSpecs: Array<[string, string]> = [
    ["provider", "TEXT NOT NULL DEFAULT 'mock'"],
    ["model", "TEXT NOT NULL DEFAULT 'mock'"],
    ["route_reason", "TEXT NOT NULL DEFAULT 'default'"],
    ["llm_failure_type", "TEXT"],
    ["input_token_count", "INTEGER NOT NULL DEFAULT 0"],
    ["output_token_count", "INTEGER NOT NULL DEFAULT 0"],
    ["token_source", "TEXT NOT NULL DEFAULT 'estimated'"],
  ];
  for (const [name, spec] of llmColumnSpecs) {
    if (!llmColumns.has(name)) sqlite.exec(`ALTER TABLE llm_calls ADD COLUMN ${name} ${spec}`);
  }
  sqlite.exec(`
    UPDATE llm_calls
    SET input_token_count = token_count, output_token_count = 0
    WHERE input_token_count = 0 AND output_token_count = 0 AND token_count > 0;
  `);

  const proposalColumns = tableColumns("distiller_proposals");
  const proposalColumnSpecs: Array<[string, string]> = [
    ["regression_status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["regression_failed_cases", "TEXT"],
    ["gate_id", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'proposed'"],
  ];
  for (const [name, spec] of proposalColumnSpecs) {
    if (!proposalColumns.has(name)) sqlite.exec(`ALTER TABLE distiller_proposals ADD COLUMN ${name} ${spec}`);
  }

  const goldColumns = tableColumns("gold_cases");
  const goldColumnSpecs: Array<[string, string]> = [
    ["project_id", "TEXT NOT NULL DEFAULT 'system'"],
    ["active", "INTEGER NOT NULL DEFAULT 1"],
    ["retired_reason", "TEXT"],
    ["last_confirmed_at", "TEXT"],
    ["source_proposal_id", "TEXT"],
  ];
  for (const [name, spec] of goldColumnSpecs) {
    if (!goldColumns.has(name)) sqlite.exec(`ALTER TABLE gold_cases ADD COLUMN ${name} ${spec}`);
  }

  // FTS5 virtual table mirroring knowledge_items + sync triggers
  sqlite.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    title, content, tags, content='knowledge_items', content_rowid='rowid'
  );
  `);
  // Triggers keep FTS in sync. knowledge_items uses TEXT id, so we use rowid.
  sqlite.exec(`
  CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_items BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_items BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_items BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
  END;
  `);
  sqlite.prepare(`INSERT INTO knowledge_fts(knowledge_fts) VALUES ('rebuild')`).run();

  sqlite.exec(`
  CREATE INDEX IF NOT EXISTS idx_cycles_project_idx ON cycles(project_id, idx);
  CREATE INDEX IF NOT EXISTS idx_cycles_project_draft ON cycles(project_id, draft_status, idx);
  CREATE INDEX IF NOT EXISTS idx_cycles_parent ON cycles(parent_cycle_id, draft_status);
  CREATE INDEX IF NOT EXISTS idx_tasks_cycle ON tasks(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_cycle ON feedback_items(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_predictions_cycle ON predictions(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_project_cycle ON knowledge_items(project_id, created_by_cycle, id);
  CREATE INDEX IF NOT EXISTS idx_gates_cycle ON human_gate_items(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_gates_notify_policy ON human_gate_items(status, notify_policy);
  CREATE INDEX IF NOT EXISTS idx_gates_missed_windows ON human_gate_items(status, blocking, missed_windows);
  CREATE INDEX IF NOT EXISTS idx_review_sessions_project_open ON review_sessions(project_id, closed_at, opened_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_digests_project_window ON notification_digests(project_id, window_date, window_label);
  CREATE INDEX IF NOT EXISTS idx_decisions_cycle_ts ON decision_log(cycle_id, ts);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_cycle_id ON agent_runs(cycle_id, id);
  CREATE INDEX IF NOT EXISTS idx_external_sources_project ON external_feedback_sources(project_id);
  CREATE INDEX IF NOT EXISTS idx_trace_cycle ON trace_events(cycle_id, started_at, id);
  CREATE INDEX IF NOT EXISTS idx_trace_project ON trace_events(project_id, started_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_action_ledger_idem ON action_ledger(idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_action_ledger_project ON action_ledger(project_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_project ON knowledge_review_items(project_id, status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_reviews_open_pair ON knowledge_review_items(
    project_id, review_type, primary_knowledge_id, COALESCE(related_knowledge_id, ''), status
  ) WHERE status = 'review_required';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_business_signals_dedupe ON external_business_signals(project_id, dedupe_key);
  CREATE INDEX IF NOT EXISTS idx_business_signals_project ON external_business_signals(project_id, observed_at);
  CREATE INDEX IF NOT EXISTS idx_sensor_accumulators_project ON sensor_error_accumulators(project_id, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_pending_attributions_fingerprint ON pending_attributions(project_id, fingerprint, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_distiller_proposals_project_status ON distiller_proposals(project_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_distiller_proposals_gate ON distiller_proposals(gate_id);
  CREATE INDEX IF NOT EXISTS idx_gold_cases_project_active ON gold_cases(project_id, active, created_at);
  CREATE INDEX IF NOT EXISTS idx_gold_cases_fingerprint ON gold_cases(project_id, fingerprint);
  CREATE INDEX IF NOT EXISTS idx_org_modules_project ON org_modules(project_id, module_name);
  `);
}

if (shouldRunImportMigrations()) {
  runSchemaMigrations();
} else {
  assertSchemaReady();
}

const now = () => new Date().toISOString();

function safeJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(redactSensitiveData(value));
  } catch {
    return JSON.stringify({ unstringifiable: true });
  }
}

function safeLogText(value: string | null | undefined): string | null {
  return value == null ? null : redactSensitiveText(value);
}

function parseJsonObject(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeGateNotifyPolicy(gate: HumanGateItem): "immediate" | "next_window" {
  if (gate.notifyPolicy === "immediate" || gate.notifyPolicy === "next_window") return gate.notifyPolicy;
  if (gate.type !== "risk") return "next_window";
  const payload = parseJsonObject(gate.payload);
  const riskLevel = String(payload.riskLevel ?? payload.risk_level ?? "").trim().toLowerCase();
  return riskLevel && immediateRiskLevelsFromEnv().has(riskLevel) ? "immediate" : "next_window";
}

function normalizeGate(gate: HumanGateItem): HumanGateItem {
  return {
    ...gate,
    notifyPolicy: normalizeGateNotifyPolicy(gate),
    deferUntil: gate.deferUntil ?? null,
    rejectReasonCode: gate.rejectReasonCode ?? null,
    reviewDwellMs: gate.reviewDwellMs ?? null,
    evidenceRevalidatedAt: gate.evidenceRevalidatedAt ?? null,
    evidenceChanged: gate.evidenceChanged ?? 0,
    missedWindows: gate.missedWindows ?? 0,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// ---------------- camel<->snake mapping helpers ----------------
// Tables map cleanly via aliased SELECT. We write explicit row mappers for type safety.

function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, direction: r.direction, targetUser: r.target_user,
    redlines: r.redlines, weeklyHumanMinutes: r.weekly_human_minutes,
    weeklyLlmBudgetCents: r.weekly_llm_budget_cents,
    firstClaimMetric: r.first_claim_metric ?? "activation_rate",
    firstClaimOperator: r.first_claim_operator ?? ">=",
    firstClaimTarget: typeof r.first_claim_target === "number" ? r.first_claim_target : 0.3,
    seedIdentity: r.seed_identity, worldModel: r.world_model,
    currentCycleIdx: r.current_cycle_idx, version: r.version,
  };
}
function rowToCycle(r: any): Cycle {
  return {
    id: r.id, projectId: r.project_id, idx: r.idx, goal: r.goal, status: r.status,
    eCycle: r.e_cycle,
    worstClaimError: r.worst_claim_error,
    reasoning: r.reasoning,
    speculative: r.speculative ?? 0,
    parentCycleId: r.parent_cycle_id ?? null,
    dependsOn: r.depends_on ?? null,
    assumedOutcomes: r.assumed_outcomes ?? null,
    draftStatus: r.draft_status ?? null,
    applyScheduledAt: r.apply_scheduled_at ?? null,
    appliedAt: r.applied_at ?? null,
    coAppliedSet: r.co_applied_set ?? null,
    version: r.version,
  };
}
function rowObject(value: unknown, table: string): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  throw new Error(`Invalid ${table} row`);
}

function rowToKnowledge(value: unknown): KnowledgeItem {
  const r = rowObject(value, "knowledge_items");
  return {
    id: r.id, projectId: r.project_id, type: r.type, title: r.title, content: r.content,
    sourceType: r.source_type, sourceRef: r.source_ref, evidenceAlpha: r.evidence_alpha,
    evidenceBeta: r.evidence_beta, confidenceScore: r.confidence_score, confidenceLevel: r.confidence_level,
    status: r.status, humanApprovedCount: r.human_approved_count, externalVerifiedCount: r.external_verified_count,
    validFrom: r.valid_from, validUntil: r.valid_until, lastValidatedCycle: r.last_validated_cycle,
    createdByCycle: r.created_by_cycle, createdBy: r.created_by, approvedBy: r.approved_by,
    usageCount: r.usage_count ?? 0,
    lastInjectedAt: r.last_injected_at ?? null,
    lastVerifiedAt: r.last_verified_at ?? null,
    lastDecayedAt: r.last_decayed_at ?? null,
    grayStreak: r.gray_streak ?? 0,
    storageStrength: r.storage_strength ?? 1,
    noveltyScore: r.novelty_score ?? null,
    sourceRound: r.source_round ?? null,
    tags: r.tags, notes: r.notes,
    supersededBy: r.superseded_by ?? null, semanticKey: r.semantic_key ?? "",
    version: r.version,
  };
}
function rowToPrediction(r: any): Prediction {
  return {
    id: r.id, cycleId: r.cycle_id, belief: r.belief, prediction: r.prediction, action: r.action,
    claims: r.claims, observation: r.observation, predictionError: r.prediction_error,
    worstClaimError: r.worst_claim_error, errorType: r.error_type, updateTarget: r.update_target,
    status: r.status, knowledgeRefs: r.knowledge_refs,
  };
}
function rowToGate(r: any): HumanGateItem {
  return {
    id: r.id, cycleId: r.cycle_id, type: r.type, blocking: r.blocking, title: r.title,
    payload: r.payload, status: r.status, estimatedMinutes: r.estimated_minutes,
    decision: r.decision,
    notifyPolicy: r.notify_policy ?? "next_window",
    deferUntil: r.defer_until ?? null,
    rejectReasonCode: r.reject_reason_code ?? null,
    reviewDwellMs: r.review_dwell_ms ?? null,
    evidenceRevalidatedAt: r.evidence_revalidated_at ?? null,
    evidenceChanged: r.evidence_changed ?? 0,
    missedWindows: r.missed_windows ?? 0,
    version: r.version,
  };
}
function rowToReviewSession(r: any): ReviewSessionItem {
  return {
    id: r.id,
    projectId: r.project_id,
    source: r.source,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    gatesTotal: r.gates_total,
    gatesResolved: r.gates_resolved,
    gatesDeferred: r.gates_deferred,
    digestMessageId: r.digest_message_id,
    summaryMessageId: r.summary_message_id,
  };
}
function rowToNotificationDigest(r: any): NotificationDigestItem {
  return {
    projectId: r.project_id,
    windowDate: r.window_date,
    windowLabel: r.window_label,
    sentAt: r.sent_at,
    messageId: r.message_id,
  };
}
function rowToFeedback(r: any): FeedbackItem {
  return {
    id: r.id, cycleId: r.cycle_id, text: r.text, category: r.category, sentiment: r.sentiment,
    sourceType: r.source_type, sourceRef: r.source_ref, sourceUrl: r.source_url,
    topicKey: r.topic_key, summary: r.summary, externalUpdatedAt: r.external_updated_at,
  };
}
function rowToAgent(r: any): Agent {
  return { id: r.id, projectId: r.project_id, name: r.name, role: r.role };
}
function rowToTask(r: any): Task {
  return { id: r.id, cycleId: r.cycle_id, agent: r.agent, kind: r.kind, status: r.status, spec: r.spec };
}
function rowToObservation(r: any): Observation {
  return { id: r.id, cycleId: r.cycle_id, predictionId: r.prediction_id, metric: r.metric, value: r.value, source: r.source };
}
function rowToDecision(r: any): DecisionLogItem {
  return { id: r.id, cycleId: r.cycle_id, gateType: r.gate_type, decision: r.decision, rationale: r.rationale, ts: r.ts };
}
function rowToEvent(r: any): EventLogItem {
  return { id: r.id, cycleIdx: r.cycle_idx, actor: r.actor, tableName: r.table_name, op: r.op, before: r.before, after: r.after, ts: r.ts };
}
function rowToLlm(r: any): LlmCall {
  return {
    id: r.id, cycleId: r.cycle_id, agent: r.agent,
    provider: r.provider ?? "mock", model: r.model ?? "mock", routeReason: r.route_reason ?? "default",
    promptVersion: r.prompt_version,
    inputSummary: r.input_summary, outputSummary: r.output_summary, schemaValid: r.schema_valid,
    llmFailureType: r.llm_failure_type ?? null,
    retryCount: r.retry_count, latencyMs: r.latency_ms,
    inputTokenCount: r.input_token_count ?? r.token_count ?? 0,
    outputTokenCount: r.output_token_count ?? 0,
    tokenCount: r.token_count,
    tokenSource: r.token_source ?? "estimated",
    estimatedCost: r.estimated_cost, ts: r.ts,
  };
}
function rowToTraceEvent(r: any): TraceEventItem {
  return {
    id: r.id, traceId: r.trace_id, spanId: r.span_id, parentSpanId: r.parent_span_id,
    projectId: r.project_id, cycleId: r.cycle_id, cycleIdx: r.cycle_idx,
    kind: r.kind, name: r.name, agent: r.agent, status: r.status,
    attributes: r.attributes, startedAt: r.started_at, endedAt: r.ended_at,
    durationMs: r.duration_ms,
  };
}
function rowToActionLedger(r: any): ActionLedgerRow {
  return {
    id: r.id, projectId: r.project_id, cycleId: r.cycle_id,
    actionType: r.action_type, target: r.target, riskLevel: r.risk_level,
    requiresApproval: r.requires_approval, approvalGateId: r.approval_gate_id,
    idempotencyKey: r.idempotency_key, status: r.status,
    rollbackPlan: r.rollback_plan, auditSummary: r.audit_summary, payload: r.payload,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToAgentRun(r: any): AgentRun {
  return { id: r.id, cycleId: r.cycle_id, cycleIdx: r.cycle_idx, agent: r.agent, action: r.action, outputSummary: r.output_summary, knowledgeRefsUsed: r.knowledge_refs_used, ts: r.ts };
}
function rowToExternalFeedbackSource(r: any): ExternalFeedbackSource {
  return {
    id: r.id, projectId: r.project_id, kind: r.kind, config: r.config,
    status: r.status, lastSyncedAt: r.last_synced_at, createdAt: r.created_at, version: r.version,
  };
}
function rowToKnowledgeReview(r: any): KnowledgeReviewItem {
  return {
    id: r.id, projectId: r.project_id, cycleId: r.cycle_id,
    reviewType: r.review_type, status: r.status,
    primaryKnowledgeId: r.primary_knowledge_id, relatedKnowledgeId: r.related_knowledge_id,
    reason: r.reason, evidence: r.evidence, recommendedAction: r.recommended_action,
    createdAt: r.created_at, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    resolution: r.resolution, version: r.version,
  };
}
function rowToExternalBusinessSignal(r: any): ExternalBusinessSignal {
  return {
    id: r.id, source: r.source, sourceId: r.source_id, projectId: r.project_id,
    signalType: r.signal_type, observedAt: r.observed_at, payload: r.payload,
    sensitivityLevel: r.sensitivity_level, dedupeKey: r.dedupe_key, riskLevel: r.risk_level,
    feedbackId: r.feedback_id, gateId: r.gate_id, createdAt: r.created_at, version: r.version,
  };
}
function rowToSensorErrorAccumulator(r: any): SensorErrorAccumulator {
  return {
    fingerprint: r.fingerprint, projectId: r.project_id, source: r.source, errorKind: r.error_kind,
    occurrenceCount: r.occurrence_count, eventTimestampsMs: r.event_timestamps_ms,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, version: r.version,
  };
}
function rowToPendingAttribution(r: any): PendingAttribution {
  return {
    id: r.id, projectId: r.project_id, fingerprint: r.fingerprint,
    errorType: r.error_type, claimError: r.claim_error, context: r.context,
    confidence: r.confidence, status: r.status, gateId: r.gate_id,
    resolvedAt: r.resolved_at, createdAt: r.created_at, version: r.version,
  };
}
function rowToDistillerProposal(r: any): DistillerProposal {
  return {
    id: r.id,
    projectId: r.project_id,
    cycleId: r.cycle_id,
    proposalType: r.proposal_type,
    targetKnowledgeId: r.target_knowledge_id,
    proposedContent: r.proposed_content,
    attributionBasis: r.attribution_basis,
    regressionStatus: r.regression_status,
    regressionFailedCases: r.regression_failed_cases,
    gateId: r.gate_id,
    status: r.status,
    createdAt: r.created_at,
  };
}
function rowToGoldCase(r: any): GoldCase {
  return {
    id: r.id,
    projectId: r.project_id,
    fingerprint: r.fingerprint,
    input: r.input,
    expectedErrorType: r.expected_error_type,
    expectedRoute: r.expected_route,
    active: r.active,
    retiredReason: r.retired_reason,
    lastConfirmedAt: r.last_confirmed_at,
    sourceProposalId: r.source_proposal_id,
    createdAt: r.created_at,
  };
}
function rowToOrgModule(r: any): OrgModule {
  return {
    id: r.id, projectId: r.project_id, moduleName: r.module_name,
    problemSolved: r.problem_solved, ownerRole: r.owner_role,
    responsibilityBoundaries: r.responsibility_boundaries,
    upstreamDependencies: r.upstream_dependencies,
    downstreamConsumers: r.downstream_consumers,
    dataInputs: r.data_inputs, dataOutputs: r.data_outputs, callChain: r.call_chain,
    mvpDefinition: r.mvp_definition, testPlan: r.test_plan, executionPlan: r.execution_plan,
    knownPitfalls: r.known_pitfalls, redlines: r.redlines,
    versionLabel: r.version_label, knowledgeId: r.knowledge_id,
    createdAt: r.created_at, updatedAt: r.updated_at, version: r.version,
  };
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type LlmCallInsert = Omit<LlmCall, "id" | "provider" | "model" | "routeReason" | "inputTokenCount" | "outputTokenCount" | "llmFailureType" | "tokenSource"> &
  Partial<Pick<LlmCall, "provider" | "model" | "routeReason" | "inputTokenCount" | "outputTokenCount" | "llmFailureType" | "tokenSource">>;

export interface IStorage {
  withTransaction?<T>(fn: () => T): T;
  // projects
  createProject(p: Project): Project;
  getProject(id: string): Project | undefined;
  listProjects(): Project[];
  getProjects(): Array<{ id: string; name: string }>;
  updateProject(id: string, patch: Partial<Project>): Project | undefined;
  // cycles
  createCycle(c: Cycle): Cycle;
  getCycle(id: string): Cycle | undefined;
  listCycles(projectId: string): Cycle[];
  updateCycle(id: string, patch: Partial<Cycle>): Cycle | undefined;
  // agents
  createAgent(a: Agent): Agent;
  listAgents(projectId: string): Agent[];
  // tasks
  createTask(t: Task): Task;
  listTasks(cycleId: string): Task[];
  updateTask(id: string, patch: Partial<Task>): Task | undefined;
  // feedback
  createFeedback(f: FeedbackItem): FeedbackItem;
  getFeedback(id: string): FeedbackItem | undefined;
  listFeedback(cycleId: string): FeedbackItem[];
  listFeedbackByProject(projectId: string): FeedbackItem[];
  // predictions
  createPrediction(p: Prediction): Prediction;
  getPrediction(id: string): Prediction | undefined;
  listPredictions(cycleId: string): Prediction[];
  listPredictionsByProject(projectId: string): Prediction[];
  updatePrediction(id: string, patch: Partial<Prediction>): Prediction | undefined;
  // observations
  createObservation(o: Observation): Observation;
  listObservations(cycleId: string): Observation[];
  // knowledge
  createKnowledge(k: KnowledgeItem): KnowledgeItem;
  getKnowledge(id: string): KnowledgeItem | undefined;
  listKnowledge(projectId: string): KnowledgeItem[];
  updateKnowledge(id: string, patch: Partial<KnowledgeItem> & { actor?: string }): KnowledgeItem | undefined;
  searchKnowledge(projectId: string, query: string): KnowledgeItem[];
  // gates
  createGate(g: HumanGateItem): HumanGateItem;
  getGate(id: string): HumanGateItem | undefined;
  listGates(projectId?: string): HumanGateItem[];
  getPendingGates(projectId: string): HumanGateItem[];
  getProjectState(projectId: string): { currentCycle: number; lastCycleAt: string | null };
  getKnowledgeCount(projectId: string): number;
  updateGate(id: string, patch: Partial<HumanGateItem> & { actor?: string }): HumanGateItem | undefined;
  // review windows
  createReviewSession(s: ReviewSessionItem): ReviewSessionItem;
  getOpenReviewSession(projectId: string): ReviewSessionItem | undefined;
  listReviewSessions(projectId?: string): ReviewSessionItem[];
  updateReviewSession(id: string, patch: Partial<ReviewSessionItem>): ReviewSessionItem | undefined;
  createNotificationDigest(d: NotificationDigestItem): NotificationDigestItem;
  getNotificationDigest(projectId: string, windowDate: string, windowLabel: string): NotificationDigestItem | undefined;
  // decision log
  createDecision(d: DecisionLogItem): DecisionLogItem;
  listDecisions(projectId?: string): DecisionLogItem[];
  // event log
  recordEvent(e: Omit<EventLogItem, "id">): void;
  listEvents(): EventLogItem[];
  getKnowledgeCreditEvent(cycleId: string, knowledgeId: string): EventLogItem | undefined;
  getReviewPauseState(): boolean | undefined;
  setReviewPauseState(paused: boolean, actor?: string, at?: string): void;
  // llm calls
  recordLlmCall(c: LlmCallInsert): void;
  listLlmCalls(): LlmCall[];
  // traces
  recordTraceEvent(e: TraceEventItem): void;
  listTraceEventsByCycle(cycleId: string, limit?: number): TraceEventItem[];
  listTraceEventsByProject(projectId: string, limit?: number): TraceEventItem[];
  // action ledger
  upsertActionLedger(a: ActionLedgerRow): ActionLedgerRow;
  listActionLedger(projectId?: string): ActionLedgerRow[];
  // knowledge reviews
  createKnowledgeReview(r: KnowledgeReviewItem): KnowledgeReviewItem;
  getKnowledgeReview(id: string): KnowledgeReviewItem | undefined;
  listKnowledgeReviews(projectId?: string): KnowledgeReviewItem[];
  updateKnowledgeReview(id: string, patch: Partial<KnowledgeReviewItem>): KnowledgeReviewItem | undefined;
  // business signals
  createExternalBusinessSignal(s: ExternalBusinessSignal): ExternalBusinessSignal;
  getExternalBusinessSignal(id: string): ExternalBusinessSignal | undefined;
  getExternalBusinessSignalByDedupe(projectId: string, dedupeKey: string): ExternalBusinessSignal | undefined;
  listExternalBusinessSignals(projectId: string): ExternalBusinessSignal[];
  updateExternalBusinessSignal(id: string, patch: Partial<ExternalBusinessSignal>): ExternalBusinessSignal | undefined;
  // sensor firewall
  upsertSensorErrorAccumulator(a: SensorErrorAccumulator): SensorErrorAccumulator;
  getSensorErrorAccumulator(fingerprint: string): SensorErrorAccumulator | undefined;
  listSensorErrorAccumulators(projectId: string): SensorErrorAccumulator[];
  // pending attributions
  createPendingAttribution(a: PendingAttribution): PendingAttribution;
  getPendingAttribution(id: string): PendingAttribution | undefined;
  listPendingAttributions(projectId: string, options?: { fingerprint?: string; since?: string; status?: string }): PendingAttribution[];
  updatePendingAttribution(id: string, patch: Partial<PendingAttribution>): PendingAttribution | undefined;
  // distiller proposals
  createDistillerProposal(p: DistillerProposal): DistillerProposal;
  getDistillerProposal(id: string): DistillerProposal | undefined;
  getDistillerProposalByGate(gateId: string): DistillerProposal | undefined;
  listDistillerProposals(projectId?: string, options?: { status?: string; gateId?: string }): DistillerProposal[];
  updateDistillerProposal(id: string, patch: Partial<DistillerProposal>): DistillerProposal | undefined;
  // gold cases
  createGoldCase(c: GoldCase): GoldCase;
  getGoldCase(id: string): GoldCase | undefined;
  listGoldCases(projectId?: string, options?: { active?: boolean; sourceProposalId?: string }): GoldCase[];
  updateGoldCase(id: string, patch: Partial<GoldCase>): GoldCase | undefined;
  // org modules
  createOrgModule(m: OrgModule): OrgModule;
  getOrgModule(id: string): OrgModule | undefined;
  listOrgModules(projectId: string): OrgModule[];
  updateOrgModule(id: string, patch: Partial<OrgModule>): OrgModule | undefined;
  deleteOrgModule(id: string): boolean;
  // agent runs
  recordAgentRun(r: Omit<AgentRun, "id">): void;
  listAgentRuns(cycleId?: string): AgentRun[];
  listAgentRunsReferencingKnowledge(knowledgeId: string, projectId: string, limit?: number): AgentRun[];
  // external feedback sources
  createExternalFeedbackSource(s: ExternalFeedbackSource): ExternalFeedbackSource;
  getExternalFeedbackSource(id: string): ExternalFeedbackSource | undefined;
  listExternalFeedbackSources(projectId: string): ExternalFeedbackSource[];
  updateExternalFeedbackSource(id: string, patch: Partial<ExternalFeedbackSource>): ExternalFeedbackSource | undefined;
}

export class DatabaseStorage implements IStorage {
  withTransaction<T>(fn: () => T): T {
    return rawDb.transaction(fn)();
  }

  private cycleIdxFor(cycleId?: string | null, fallback = 0): number {
    if (!cycleId) return fallback;
    const row = rawDb.prepare(`SELECT idx FROM cycles WHERE id=?`).get(cycleId) as { idx?: number } | undefined;
    return typeof row?.idx === "number" ? row.idx : fallback;
  }

  private auditWrite(actor: string, tableName: string, op: string, before: unknown, after: unknown, cycleIdx = 0): void {
    rawDb.prepare(`INSERT INTO event_log (cycle_idx,actor,table_name,op,before,after,ts) VALUES (?,?,?,?,?,?,?)`)
      .run(cycleIdx, actor, tableName, op, safeJson(before), safeJson(after), now());
  }

  // ---- projects ----
  createProject(p: Project): Project {
    rawDb.prepare(`INSERT INTO projects (id,name,direction,target_user,redlines,weekly_human_minutes,weekly_llm_budget_cents,first_claim_metric,first_claim_operator,first_claim_target,seed_identity,world_model,current_cycle_idx,version)
      VALUES (@id,@name,@direction,@target_user,@redlines,@weekly_human_minutes,@weekly_llm_budget_cents,@first_claim_metric,@first_claim_operator,@first_claim_target,@seed_identity,@world_model,@current_cycle_idx,@version)`).run({
      id: p.id, name: p.name, direction: p.direction, target_user: p.targetUser, redlines: p.redlines,
      weekly_human_minutes: p.weeklyHumanMinutes, weekly_llm_budget_cents: p.weeklyLlmBudgetCents,
      first_claim_metric: p.firstClaimMetric, first_claim_operator: p.firstClaimOperator, first_claim_target: p.firstClaimTarget,
      seed_identity: p.seedIdentity, world_model: p.worldModel,
      current_cycle_idx: p.currentCycleIdx, version: p.version,
    });
    this.auditWrite("owner", "projects", "insert", null, p, p.currentCycleIdx);
    return p;
  }
  getProject(id: string): Project | undefined {
    const r = rawDb.prepare(`SELECT * FROM projects WHERE id=?`).get(id);
    return r ? rowToProject(r) : undefined;
  }
  listProjects(): Project[] {
    return rawDb.prepare(`SELECT * FROM projects`).all().map(rowToProject);
  }
  getProjects(): Array<{ id: string; name: string }> {
    return rawDb.prepare(`SELECT id, name FROM projects ORDER BY name ASC, id ASC`).all() as Array<{ id: string; name: string }>;
  }
  updateProject(id: string, patch: Partial<Project>): Project | undefined {
    const cur = this.getProject(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE projects SET name=@name,direction=@direction,target_user=@target_user,redlines=@redlines,weekly_human_minutes=@weekly_human_minutes,weekly_llm_budget_cents=@weekly_llm_budget_cents,first_claim_metric=@first_claim_metric,first_claim_operator=@first_claim_operator,first_claim_target=@first_claim_target,seed_identity=@seed_identity,world_model=@world_model,current_cycle_idx=@current_cycle_idx,version=@version WHERE id=@id`).run({
      id, name: n.name, direction: n.direction, target_user: n.targetUser, redlines: n.redlines,
      weekly_human_minutes: n.weeklyHumanMinutes, weekly_llm_budget_cents: n.weeklyLlmBudgetCents,
      first_claim_metric: n.firstClaimMetric, first_claim_operator: n.firstClaimOperator, first_claim_target: n.firstClaimTarget,
      seed_identity: n.seedIdentity, world_model: n.worldModel,
      current_cycle_idx: n.currentCycleIdx, version: n.version,
    });
    this.auditWrite("owner", "projects", "update", cur, n, n.currentCycleIdx);
    return n;
  }
  // ---- cycles ----
  createCycle(c: Cycle): Cycle {
    const n = {
      ...c,
      speculative: c.speculative ?? 0,
      parentCycleId: c.parentCycleId ?? null,
      dependsOn: c.dependsOn ?? null,
      assumedOutcomes: c.assumedOutcomes ?? null,
      draftStatus: c.draftStatus ?? null,
      applyScheduledAt: c.applyScheduledAt ?? null,
      appliedAt: c.appliedAt ?? null,
      coAppliedSet: c.coAppliedSet ?? null,
    };
    rawDb.prepare(`INSERT INTO cycles (id,project_id,idx,goal,status,e_cycle,worst_claim_error,reasoning,speculative,parent_cycle_id,depends_on,assumed_outcomes,draft_status,apply_scheduled_at,applied_at,co_applied_set,version)
      VALUES (@id,@project_id,@idx,@goal,@status,@e_cycle,@worst_claim_error,@reasoning,@speculative,@parent_cycle_id,@depends_on,@assumed_outcomes,@draft_status,@apply_scheduled_at,@applied_at,@co_applied_set,@version)`).run({
      id: c.id, project_id: c.projectId, idx: c.idx, goal: c.goal, status: c.status,
      e_cycle: c.eCycle, worst_claim_error: c.worstClaimError, reasoning: c.reasoning,
      speculative: n.speculative,
      parent_cycle_id: n.parentCycleId,
      depends_on: n.dependsOn,
      assumed_outcomes: n.assumedOutcomes,
      draft_status: n.draftStatus,
      apply_scheduled_at: n.applyScheduledAt,
      applied_at: n.appliedAt,
      co_applied_set: n.coAppliedSet,
      version: c.version,
    });
    this.auditWrite("orchestrator", "cycles", "insert", null, n, n.idx);
    return n;
  }
  getCycle(id: string): Cycle | undefined {
    const r = rawDb.prepare(`SELECT * FROM cycles WHERE id=?`).get(id);
    return r ? rowToCycle(r) : undefined;
  }
  listCycles(projectId: string): Cycle[] {
    return rawDb.prepare(`SELECT * FROM cycles WHERE project_id=? ORDER BY idx ASC`).all(projectId).map(rowToCycle);
  }
  updateCycle(id: string, patch: Partial<Cycle>): Cycle | undefined {
    const cur = this.getCycle(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE cycles SET goal=@goal,status=@status,e_cycle=@e_cycle,worst_claim_error=@worst_claim_error,reasoning=@reasoning,speculative=@speculative,parent_cycle_id=@parent_cycle_id,depends_on=@depends_on,assumed_outcomes=@assumed_outcomes,draft_status=@draft_status,apply_scheduled_at=@apply_scheduled_at,applied_at=@applied_at,co_applied_set=@co_applied_set,version=@version WHERE id=@id`).run({
      id,
      goal: n.goal,
      status: n.status,
      e_cycle: n.eCycle,
      worst_claim_error: n.worstClaimError,
      reasoning: n.reasoning,
      speculative: n.speculative ?? 0,
      parent_cycle_id: n.parentCycleId ?? null,
      depends_on: n.dependsOn ?? null,
      assumed_outcomes: n.assumedOutcomes ?? null,
      draft_status: n.draftStatus ?? null,
      apply_scheduled_at: n.applyScheduledAt ?? null,
      applied_at: n.appliedAt ?? null,
      co_applied_set: n.coAppliedSet ?? null,
      version: n.version,
    });
    this.auditWrite("orchestrator", "cycles", "update", cur, n, n.idx);
    return n;
  }
  // ---- agents ----
  createAgent(a: Agent): Agent {
    rawDb.prepare(`INSERT INTO agents (id,project_id,name,role) VALUES (?,?,?,?)`).run(a.id, a.projectId, a.name, a.role);
    this.auditWrite("orchestrator", "agents", "insert", null, a, 0);
    return a;
  }
  listAgents(projectId: string): Agent[] {
    return rawDb.prepare(`SELECT * FROM agents WHERE project_id=?`).all(projectId).map(rowToAgent);
  }
  // ---- tasks ----
  createTask(t: Task): Task {
    rawDb.prepare(`INSERT INTO tasks (id,cycle_id,agent,kind,status,spec) VALUES (?,?,?,?,?,?)`).run(t.id, t.cycleId, t.agent, t.kind, t.status, t.spec);
    this.auditWrite(t.agent || "builder", "tasks", "insert", null, t, this.cycleIdxFor(t.cycleId));
    return t;
  }
  listTasks(cycleId: string): Task[] {
    return rawDb.prepare(`SELECT * FROM tasks WHERE cycle_id=?`).all(cycleId).map(rowToTask);
  }
  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const cur = rawDb.prepare(`SELECT * FROM tasks WHERE id=?`).get(id);
    if (!cur) return undefined;
    const curTask = rowToTask(cur);
    const n = { ...curTask, ...patch };
    rawDb.prepare(`UPDATE tasks SET agent=@agent,kind=@kind,status=@status,spec=@spec WHERE id=@id`).run({
      id, agent: n.agent, kind: n.kind, status: n.status, spec: n.spec,
    });
    this.auditWrite(n.agent || "builder", "tasks", "update", curTask, n, this.cycleIdxFor(n.cycleId));
    return n;
  }
  // ---- feedback ----
  createFeedback(f: FeedbackItem): FeedbackItem {
    rawDb.prepare(`INSERT INTO feedback_items (id,cycle_id,text,category,sentiment,source_type,source_ref,source_url,topic_key,summary,external_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.id, f.cycleId, f.text, f.category, f.sentiment, f.sourceType, f.sourceRef,
      f.sourceUrl, f.topicKey, f.summary, f.externalUpdatedAt,
    );
    this.auditWrite("sensor", "feedback_items", "insert", null, f, this.cycleIdxFor(f.cycleId));
    return f;
  }
  getFeedback(id: string): FeedbackItem | undefined {
    const r = rawDb.prepare(`SELECT * FROM feedback_items WHERE id=?`).get(id);
    return r ? rowToFeedback(r) : undefined;
  }
  listFeedback(cycleId: string): FeedbackItem[] {
    return rawDb.prepare(`SELECT * FROM feedback_items WHERE cycle_id=?`).all(cycleId).map(rowToFeedback);
  }
  listFeedbackByProject(projectId: string): FeedbackItem[] {
    return rawDb.prepare(`SELECT f.* FROM feedback_items f JOIN cycles c ON f.cycle_id=c.id WHERE c.project_id=? ORDER BY c.idx ASC, f.id ASC`).all(projectId).map(rowToFeedback);
  }
  // ---- predictions ----
  createPrediction(p: Prediction): Prediction {
    rawDb.prepare(`INSERT INTO predictions (id,cycle_id,belief,prediction,action,claims,observation,prediction_error,worst_claim_error,error_type,update_target,status,knowledge_refs)
      VALUES (@id,@cycle_id,@belief,@prediction,@action,@claims,@observation,@prediction_error,@worst_claim_error,@error_type,@update_target,@status,@knowledge_refs)`).run({
      id: p.id, cycle_id: p.cycleId, belief: p.belief, prediction: p.prediction, action: p.action,
      claims: p.claims, observation: p.observation, prediction_error: p.predictionError,
      worst_claim_error: p.worstClaimError, error_type: p.errorType, update_target: p.updateTarget,
      status: p.status, knowledge_refs: p.knowledgeRefs,
    });
    this.auditWrite("orchestrator", "predictions", "insert", null, p, this.cycleIdxFor(p.cycleId));
    return p;
  }
  getPrediction(id: string): Prediction | undefined {
    const r = rawDb.prepare(`SELECT * FROM predictions WHERE id=?`).get(id);
    return r ? rowToPrediction(r) : undefined;
  }
  listPredictions(cycleId: string): Prediction[] {
    return rawDb.prepare(`SELECT * FROM predictions WHERE cycle_id=?`).all(cycleId).map(rowToPrediction);
  }
  listPredictionsByProject(projectId: string): Prediction[] {
    return rawDb.prepare(`SELECT p.* FROM predictions p JOIN cycles c ON p.cycle_id=c.id WHERE c.project_id=? ORDER BY c.idx ASC`).all(projectId).map(rowToPrediction);
  }
  updatePrediction(id: string, patch: Partial<Prediction>): Prediction | undefined {
    const cur = this.getPrediction(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    rawDb.prepare(`UPDATE predictions SET belief=@belief,prediction=@prediction,action=@action,claims=@claims,observation=@observation,prediction_error=@prediction_error,worst_claim_error=@worst_claim_error,error_type=@error_type,update_target=@update_target,status=@status,knowledge_refs=@knowledge_refs WHERE id=@id`).run({
      id, belief: n.belief, prediction: n.prediction, action: n.action, claims: n.claims,
      observation: n.observation, prediction_error: n.predictionError, worst_claim_error: n.worstClaimError,
      error_type: n.errorType, update_target: n.updateTarget, status: n.status, knowledge_refs: n.knowledgeRefs,
    });
    this.auditWrite("sensor", "predictions", "update", cur, n, this.cycleIdxFor(n.cycleId));
    return n;
  }
  // ---- observations ----
  createObservation(o: Observation): Observation {
    rawDb.prepare(`INSERT INTO observations (id,cycle_id,prediction_id,metric,value,source) VALUES (?,?,?,?,?,?)`).run(o.id, o.cycleId, o.predictionId, o.metric, o.value, o.source);
    this.auditWrite("sensor", "observations", "insert", null, o, this.cycleIdxFor(o.cycleId));
    return o;
  }
  listObservations(cycleId: string): Observation[] {
    return rawDb.prepare(`SELECT * FROM observations WHERE cycle_id=?`).all(cycleId).map(rowToObservation);
  }
  // ---- knowledge ----
  createKnowledge(k: KnowledgeItem): KnowledgeItem {
    const n = {
      ...k,
      usageCount: k.usageCount ?? 0,
      lastInjectedAt: k.lastInjectedAt ?? null,
      lastVerifiedAt: k.lastVerifiedAt ?? null,
      lastDecayedAt: k.lastDecayedAt ?? null,
      grayStreak: k.grayStreak ?? 0,
      storageStrength: k.storageStrength ?? 1,
      noveltyScore: k.noveltyScore ?? null,
      sourceRound: k.sourceRound ?? k.createdByCycle ?? null,
      supersededBy: k.supersededBy ?? null,
      semanticKey: k.semanticKey ?? "",
    };
    rawDb.prepare(`INSERT INTO knowledge_items (id,project_id,type,title,content,source_type,source_ref,evidence_alpha,evidence_beta,confidence_score,confidence_level,status,human_approved_count,external_verified_count,valid_from,valid_until,last_validated_cycle,created_by_cycle,created_by,approved_by,usage_count,last_injected_at,last_verified_at,last_decayed_at,gray_streak,storage_strength,novelty_score,source_round,tags,notes,superseded_by,semantic_key,version)
      VALUES (@id,@project_id,@type,@title,@content,@source_type,@source_ref,@evidence_alpha,@evidence_beta,@confidence_score,@confidence_level,@status,@human_approved_count,@external_verified_count,@valid_from,@valid_until,@last_validated_cycle,@created_by_cycle,@created_by,@approved_by,@usage_count,@last_injected_at,@last_verified_at,@last_decayed_at,@gray_streak,@storage_strength,@novelty_score,@source_round,@tags,@notes,@superseded_by,@semantic_key,@version)`).run({
      id: k.id, project_id: k.projectId, type: k.type, title: k.title, content: k.content,
      source_type: k.sourceType, source_ref: k.sourceRef, evidence_alpha: k.evidenceAlpha, evidence_beta: k.evidenceBeta,
      confidence_score: k.confidenceScore, confidence_level: k.confidenceLevel, status: k.status,
      human_approved_count: k.humanApprovedCount, external_verified_count: k.externalVerifiedCount,
      valid_from: k.validFrom, valid_until: k.validUntil, last_validated_cycle: k.lastValidatedCycle,
      created_by_cycle: k.createdByCycle, created_by: k.createdBy, approved_by: k.approvedBy,
      usage_count: n.usageCount,
      last_injected_at: n.lastInjectedAt,
      last_verified_at: n.lastVerifiedAt,
      last_decayed_at: n.lastDecayedAt,
      gray_streak: n.grayStreak,
      storage_strength: n.storageStrength,
      novelty_score: n.noveltyScore,
      source_round: n.sourceRound,
      tags: k.tags, notes: k.notes,
      superseded_by: n.supersededBy, semantic_key: n.semanticKey, version: k.version,
    });
    this.auditWrite(k.createdBy || "distiller", "knowledge_items", "insert", null, n, k.createdByCycle);
    return n;
  }
  getKnowledge(id: string): KnowledgeItem | undefined {
    const r = rawDb.prepare(`SELECT * FROM knowledge_items WHERE id=?`).get(id);
    return r ? rowToKnowledge(r) : undefined;
  }
  listKnowledge(projectId: string): KnowledgeItem[] {
    return rawDb.prepare(`SELECT * FROM knowledge_items WHERE project_id=? ORDER BY created_by_cycle ASC, id ASC`).all(projectId).map(rowToKnowledge);
  }
  updateKnowledge(id: string, patch: Partial<KnowledgeItem> & { actor?: string }): KnowledgeItem | undefined {
    const cur = this.getKnowledge(id);
    if (!cur) return undefined;
    const { actor: actorHint, ...rawPatch } = patch;
    const n = {
      ...cur,
      ...rawPatch,
      usageCount: rawPatch.usageCount ?? cur.usageCount ?? 0,
      lastInjectedAt: rawPatch.lastInjectedAt ?? cur.lastInjectedAt ?? null,
      lastVerifiedAt: rawPatch.lastVerifiedAt ?? cur.lastVerifiedAt ?? null,
      lastDecayedAt: rawPatch.lastDecayedAt ?? cur.lastDecayedAt ?? null,
      grayStreak: rawPatch.grayStreak ?? cur.grayStreak ?? 0,
      storageStrength: rawPatch.storageStrength ?? cur.storageStrength ?? 1,
      noveltyScore: rawPatch.noveltyScore ?? cur.noveltyScore ?? null,
      sourceRound: rawPatch.sourceRound ?? cur.sourceRound ?? cur.createdByCycle ?? null,
      supersededBy: Object.prototype.hasOwnProperty.call(rawPatch, "supersededBy")
        ? rawPatch.supersededBy ?? null
        : cur.supersededBy ?? null,
      semanticKey: rawPatch.semanticKey ?? cur.semanticKey ?? "",
      version: cur.version + 1,
    };
    rawDb.prepare(`UPDATE knowledge_items SET type=@type,title=@title,content=@content,source_type=@source_type,source_ref=@source_ref,evidence_alpha=@evidence_alpha,evidence_beta=@evidence_beta,confidence_score=@confidence_score,confidence_level=@confidence_level,status=@status,human_approved_count=@human_approved_count,external_verified_count=@external_verified_count,valid_from=@valid_from,valid_until=@valid_until,last_validated_cycle=@last_validated_cycle,created_by_cycle=@created_by_cycle,created_by=@created_by,approved_by=@approved_by,usage_count=@usage_count,last_injected_at=@last_injected_at,last_verified_at=@last_verified_at,last_decayed_at=@last_decayed_at,gray_streak=@gray_streak,storage_strength=@storage_strength,novelty_score=@novelty_score,source_round=@source_round,tags=@tags,notes=@notes,superseded_by=@superseded_by,semantic_key=@semantic_key,version=@version WHERE id=@id`).run({
      id, type: n.type, title: n.title, content: n.content, source_type: n.sourceType, source_ref: n.sourceRef,
      evidence_alpha: n.evidenceAlpha, evidence_beta: n.evidenceBeta, confidence_score: n.confidenceScore,
      confidence_level: n.confidenceLevel, status: n.status, human_approved_count: n.humanApprovedCount,
      external_verified_count: n.externalVerifiedCount, valid_from: n.validFrom, valid_until: n.validUntil,
      last_validated_cycle: n.lastValidatedCycle, created_by_cycle: n.createdByCycle, created_by: n.createdBy,
      approved_by: n.approvedBy, usage_count: n.usageCount,
      last_injected_at: n.lastInjectedAt,
      last_verified_at: n.lastVerifiedAt,
      last_decayed_at: n.lastDecayedAt,
      gray_streak: n.grayStreak,
      storage_strength: n.storageStrength,
      novelty_score: n.noveltyScore,
      source_round: n.sourceRound,
      tags: n.tags, notes: n.notes,
      superseded_by: n.supersededBy, semantic_key: n.semanticKey, version: n.version,
    });
    const actor = actorHint ?? (rawPatch.approvedBy ? "human" : "librarian");
    this.auditWrite(actor, "knowledge_items", "update", cur, n, n.lastValidatedCycle || n.createdByCycle);
    return n;
  }
  searchKnowledge(projectId: string, query: string): KnowledgeItem[] {
    // Sanitize query into FTS5 prefix-OR terms
    const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"*`);
    if (terms.length === 0) return [];
    const match = terms.join(" OR ");
    const HIGH_RISK_EXCLUDED = ["stale", "expired", "quarantined", "conflict", "deprecated", "rejected"];
    try {
      const rows = rawDb.prepare(`
        SELECT k.* FROM knowledge_fts f
        JOIN knowledge_items k ON k.rowid = f.rowid
        WHERE knowledge_fts MATCH ? AND k.project_id = ?
          AND (k.superseded_by IS NULL OR k.superseded_by = '')
        ORDER BY rank
      `).all(match, projectId);
      return rows.map(rowToKnowledge).filter((k) => !HIGH_RISK_EXCLUDED.includes(k.status));
    } catch {
      return [];
    }
  }
  // ---- gates ----
  createGate(g: HumanGateItem): HumanGateItem {
    const n = normalizeGate(g);
    if (isLongRunMode(runModeFromEnv())) assertDecisionBriefPayload(n);
    rawDb.prepare(`INSERT INTO human_gate_items (id,cycle_id,type,blocking,title,payload,status,estimated_minutes,decision,notify_policy,defer_until,reject_reason_code,review_dwell_ms,evidence_revalidated_at,evidence_changed,missed_windows,version)
      VALUES (@id,@cycle_id,@type,@blocking,@title,@payload,@status,@estimated_minutes,@decision,@notify_policy,@defer_until,@reject_reason_code,@review_dwell_ms,@evidence_revalidated_at,@evidence_changed,@missed_windows,@version)`).run({
      id: n.id, cycle_id: n.cycleId, type: n.type, blocking: n.blocking, title: n.title,
      payload: n.payload, status: n.status, estimated_minutes: n.estimatedMinutes,
      decision: n.decision,
      notify_policy: n.notifyPolicy,
      defer_until: n.deferUntil,
      reject_reason_code: n.rejectReasonCode,
      review_dwell_ms: n.reviewDwellMs,
      evidence_revalidated_at: n.evidenceRevalidatedAt,
      evidence_changed: n.evidenceChanged,
      missed_windows: n.missedWindows,
      version: n.version,
    });
    this.auditWrite("orchestrator", "human_gate_items", "insert", null, n, this.cycleIdxFor(n.cycleId));
    return n;
  }
  getGate(id: string): HumanGateItem | undefined {
    const r = rawDb.prepare(`SELECT * FROM human_gate_items WHERE id=?`).get(id);
    return r ? rowToGate(r) : undefined;
  }
  listGates(projectId?: string): HumanGateItem[] {
    if (!projectId) return rawDb.prepare(`SELECT * FROM human_gate_items ORDER BY rowid ASC`).all().map(rowToGate);
    return rawDb.prepare(`SELECT g.* FROM human_gate_items g JOIN cycles c ON g.cycle_id=c.id WHERE c.project_id=? ORDER BY c.idx ASC, g.rowid ASC`).all(projectId).map(rowToGate);
  }
  getPendingGates(projectId: string): HumanGateItem[] {
    return rawDb.prepare(`
      SELECT g.* FROM human_gate_items g
      JOIN cycles c ON g.cycle_id = c.id
      WHERE c.project_id = ? AND g.status = 'pending'
      ORDER BY g.blocking DESC, g.rowid ASC
    `).all(projectId).map(rowToGate);
  }
  getProjectState(projectId: string): { currentCycle: number; lastCycleAt: string | null } {
    const project = this.getProject(projectId);
    const currentCycle = project?.currentCycleIdx ?? 0;
    const projectJsonNeedle = `%"projectId":"${escapeSqlLike(projectId)}"%`;
    const lastEvent = rawDb.prepare(`
      SELECT e.ts FROM event_log e
      WHERE e.after LIKE ? ESCAPE '\\'
      ORDER BY e.id DESC
      LIMIT 1
    `).get(projectJsonNeedle) as { ts?: string } | undefined;
    return { currentCycle, lastCycleAt: lastEvent?.ts ?? null };
  }
  getKnowledgeCount(projectId: string): number {
    const row = rawDb.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_items
      WHERE project_id = ? AND status NOT IN ('expired', 'quarantined')
    `).get(projectId) as { count?: number } | undefined;
    return row?.count ?? 0;
  }
  updateGate(id: string, patch: Partial<HumanGateItem> & { actor?: string }): HumanGateItem | undefined {
    const { actor: requestedActor, ...gatePatch } = patch;
    const cur = this.getGate(id);
    if (!cur) return undefined;
    const resolvedNow = gatePatch.status != null && gatePatch.status !== cur.status && gatePatch.status !== "pending";
    const payload = resolvedNow && gatePatch.payload == null
      ? JSON.stringify({ ...parseJsonObject(cur.payload), resolvedAt: now() })
      : gatePatch.payload;
    const n = normalizeGate({ ...cur, ...gatePatch, ...(payload != null ? { payload } : {}), version: cur.version + 1 });
    rawDb.prepare(`UPDATE human_gate_items SET type=@type,blocking=@blocking,title=@title,payload=@payload,status=@status,estimated_minutes=@estimated_minutes,decision=@decision,notify_policy=@notify_policy,defer_until=@defer_until,reject_reason_code=@reject_reason_code,review_dwell_ms=@review_dwell_ms,evidence_revalidated_at=@evidence_revalidated_at,evidence_changed=@evidence_changed,missed_windows=@missed_windows,version=@version WHERE id=@id`).run({
      id, type: n.type, blocking: n.blocking, title: n.title, payload: n.payload, status: n.status,
      estimated_minutes: n.estimatedMinutes, decision: n.decision,
      notify_policy: n.notifyPolicy,
      defer_until: n.deferUntil,
      reject_reason_code: n.rejectReasonCode,
      review_dwell_ms: n.reviewDwellMs,
      evidence_revalidated_at: n.evidenceRevalidatedAt,
      evidence_changed: n.evidenceChanged,
      missed_windows: n.missedWindows,
      version: n.version,
    });
    const actor = requestedActor ?? (gatePatch.decision?.includes("auto_approved") || gatePatch.decision?.startsWith("merged_into:")
      ? "scheduler"
      : gatePatch.status === "resolved" ? "human" : "librarian");
    this.auditWrite(actor, "human_gate_items", "update", cur, n, this.cycleIdxFor(n.cycleId));
    return n;
  }
  // ---- review windows ----
  createReviewSession(s: ReviewSessionItem): ReviewSessionItem {
    rawDb.prepare(`INSERT INTO review_sessions (id,project_id,source,opened_at,closed_at,gates_total,gates_resolved,gates_deferred,digest_message_id,summary_message_id)
      VALUES (@id,@project_id,@source,@opened_at,@closed_at,@gates_total,@gates_resolved,@gates_deferred,@digest_message_id,@summary_message_id)`).run({
      id: s.id,
      project_id: s.projectId,
      source: s.source,
      opened_at: s.openedAt,
      closed_at: s.closedAt,
      gates_total: s.gatesTotal,
      gates_resolved: s.gatesResolved,
      gates_deferred: s.gatesDeferred,
      digest_message_id: s.digestMessageId,
      summary_message_id: s.summaryMessageId,
    });
    this.auditWrite("scheduler", "review_sessions", "insert", null, s, 0);
    return s;
  }
  getOpenReviewSession(projectId: string): ReviewSessionItem | undefined {
    const r = rawDb.prepare(`SELECT * FROM review_sessions WHERE project_id=? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`).get(projectId);
    return r ? rowToReviewSession(r) : undefined;
  }
  listReviewSessions(projectId?: string): ReviewSessionItem[] {
    const rows = projectId
      ? rawDb.prepare(`SELECT * FROM review_sessions WHERE project_id=? ORDER BY opened_at ASC`).all(projectId)
      : rawDb.prepare(`SELECT * FROM review_sessions ORDER BY opened_at ASC`).all();
    return rows.map(rowToReviewSession);
  }
  updateReviewSession(id: string, patch: Partial<ReviewSessionItem>): ReviewSessionItem | undefined {
    const curRow = rawDb.prepare(`SELECT * FROM review_sessions WHERE id=?`).get(id);
    if (!curRow) return undefined;
    const cur = rowToReviewSession(curRow);
    const n = { ...cur, ...patch };
    rawDb.prepare(`UPDATE review_sessions SET project_id=@project_id,source=@source,opened_at=@opened_at,closed_at=@closed_at,gates_total=@gates_total,gates_resolved=@gates_resolved,gates_deferred=@gates_deferred,digest_message_id=@digest_message_id,summary_message_id=@summary_message_id WHERE id=@id`).run({
      id: n.id,
      project_id: n.projectId,
      source: n.source,
      opened_at: n.openedAt,
      closed_at: n.closedAt,
      gates_total: n.gatesTotal,
      gates_resolved: n.gatesResolved,
      gates_deferred: n.gatesDeferred,
      digest_message_id: n.digestMessageId,
      summary_message_id: n.summaryMessageId,
    });
    this.auditWrite("scheduler", "review_sessions", "update", cur, n, 0);
    return n;
  }
  createNotificationDigest(d: NotificationDigestItem): NotificationDigestItem {
    rawDb.prepare(`INSERT OR IGNORE INTO notification_digests (project_id,window_date,window_label,sent_at,message_id)
      VALUES (@project_id,@window_date,@window_label,@sent_at,@message_id)`).run({
      project_id: d.projectId,
      window_date: d.windowDate,
      window_label: d.windowLabel,
      sent_at: d.sentAt,
      message_id: d.messageId,
    });
    const created = this.getNotificationDigest(d.projectId, d.windowDate, d.windowLabel) ?? d;
    this.auditWrite("scheduler", "notification_digests", "insert", null, created, 0);
    return created;
  }
  getNotificationDigest(projectId: string, windowDate: string, windowLabel: string): NotificationDigestItem | undefined {
    const r = rawDb.prepare(`SELECT * FROM notification_digests WHERE project_id=? AND window_date=? AND window_label=?`).get(projectId, windowDate, windowLabel);
    return r ? rowToNotificationDigest(r) : undefined;
  }
  // ---- decision log ----
  createDecision(d: DecisionLogItem): DecisionLogItem {
    rawDb.prepare(`INSERT INTO decision_log (id,cycle_id,gate_type,decision,rationale,ts) VALUES (?,?,?,?,?,?)`).run(d.id, d.cycleId, d.gateType, d.decision, d.rationale, d.ts);
    this.auditWrite("human", "decision_log", "insert", null, d, this.cycleIdxFor(d.cycleId));
    return d;
  }
  listDecisions(projectId?: string): DecisionLogItem[] {
    if (!projectId) return rawDb.prepare(`SELECT * FROM decision_log ORDER BY ts ASC`).all().map(rowToDecision);
    return rawDb.prepare(`SELECT d.* FROM decision_log d JOIN cycles c ON d.cycle_id=c.id WHERE c.project_id=? ORDER BY d.ts ASC`).all(projectId).map(rowToDecision);
  }
  // ---- event log ----
  recordEvent(e: Omit<EventLogItem, "id">): void {
    rawDb.prepare(`INSERT INTO event_log (cycle_idx,actor,table_name,op,before,after,ts) VALUES (?,?,?,?,?,?,?)`)
      .run(e.cycleIdx, e.actor, e.tableName, e.op, safeLogText(e.before), safeLogText(e.after), e.ts);
  }
  listEvents(): EventLogItem[] {
    return rawDb.prepare(`SELECT * FROM event_log ORDER BY id DESC LIMIT 500`).all().map(rowToEvent);
  }
  getKnowledgeCreditEvent(cycleId: string, knowledgeId: string): EventLogItem | undefined {
    const rows = rawDb.prepare(`
      SELECT * FROM event_log
      WHERE actor = 'knowledge_credit'
        AND table_name = 'knowledge_items'
        AND op = 'credit'
      ORDER BY id DESC
    `).all();
    for (const row of rows) {
      const event = rowToEvent(row);
      const after = parseJsonObject(event.after ?? "{}");
      if (after.cycleId === cycleId && after.knowledgeId === knowledgeId) return event;
    }
    return undefined;
  }
  getReviewPauseState(): boolean | undefined {
    const row = rawDb.prepare(`
      SELECT op, after FROM event_log
      WHERE table_name = 'review_sessions' AND op IN ('review_paused', 'review_resumed')
      ORDER BY id DESC
      LIMIT 1
    `).get() as { op?: string; after?: string | null } | undefined;
    if (!row) return undefined;
    const payload = parseJsonObject(row.after ?? "{}");
    if (typeof payload.paused === "boolean") return payload.paused;
    if (row.op === "review_paused") return true;
    if (row.op === "review_resumed") return false;
    return undefined;
  }
  setReviewPauseState(paused: boolean, actor = "human_telegram", at = now()): void {
    this.recordEvent({
      cycleIdx: 0,
      actor,
      tableName: "review_sessions",
      op: paused ? "review_paused" : "review_resumed",
      before: null,
      after: JSON.stringify({ paused, ts: at }),
      ts: at,
    });
  }
  // ---- llm calls ----
  recordLlmCall(c: LlmCallInsert): void {
    const n = {
      ...c,
      provider: c.provider ?? "mock",
      model: c.model ?? "mock",
      routeReason: c.routeReason ?? "default",
      llmFailureType: c.llmFailureType ?? null,
      inputTokenCount: c.inputTokenCount ?? c.tokenCount ?? 0,
      outputTokenCount: c.outputTokenCount ?? 0,
      tokenSource: c.tokenSource ?? "estimated",
    };
    rawDb.prepare(`INSERT INTO llm_calls (cycle_id,agent,provider,model,route_reason,prompt_version,input_summary,output_summary,schema_valid,llm_failure_type,retry_count,latency_ms,input_token_count,output_token_count,token_count,token_source,estimated_cost,ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      n.cycleId, n.agent, n.provider, n.model, n.routeReason, n.promptVersion,
      n.inputSummary, n.outputSummary, n.schemaValid, n.llmFailureType, n.retryCount, n.latencyMs,
      n.inputTokenCount, n.outputTokenCount, n.tokenCount, n.tokenSource, n.estimatedCost, n.ts,
    );
    this.auditWrite(c.agent || "llm", "llm_calls", "insert", null, n, this.cycleIdxFor(c.cycleId));
  }
  listLlmCalls(): LlmCall[] {
    return rawDb.prepare(`SELECT * FROM llm_calls ORDER BY id ASC`).all().map(rowToLlm);
  }
  // ---- trace events ----
  recordTraceEvent(e: TraceEventItem): void {
    rawDb.prepare(`INSERT OR REPLACE INTO trace_events (id,trace_id,span_id,parent_span_id,project_id,cycle_id,cycle_idx,kind,name,agent,status,attributes,started_at,ended_at,duration_ms)
      VALUES (@id,@trace_id,@span_id,@parent_span_id,@project_id,@cycle_id,@cycle_idx,@kind,@name,@agent,@status,@attributes,@started_at,@ended_at,@duration_ms)`).run({
      id: e.id, trace_id: e.traceId, span_id: e.spanId, parent_span_id: e.parentSpanId,
      project_id: e.projectId, cycle_id: e.cycleId, cycle_idx: e.cycleIdx,
      kind: e.kind, name: e.name, agent: e.agent, status: e.status,
      attributes: e.attributes, started_at: e.startedAt, ended_at: e.endedAt,
      duration_ms: e.durationMs,
    });
    this.auditWrite(e.agent || "trace", "trace_events", "insert", null, e, e.cycleIdx ?? 0);
  }
  listTraceEventsByCycle(cycleId: string, limit = 1000): TraceEventItem[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 5000);
    return rawDb.prepare(`SELECT * FROM trace_events WHERE cycle_id=? ORDER BY started_at ASC, id ASC LIMIT ?`)
      .all(cycleId, safeLimit)
      .map(rowToTraceEvent);
  }
  listTraceEventsByProject(projectId: string, limit = 1000): TraceEventItem[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 5000);
    return rawDb.prepare(`SELECT * FROM trace_events WHERE project_id=? ORDER BY started_at ASC, id ASC LIMIT ?`)
      .all(projectId, safeLimit)
      .map(rowToTraceEvent);
  }
  // ---- action ledger ----
  upsertActionLedger(a: ActionLedgerRow): ActionLedgerRow {
    rawDb.prepare(`INSERT INTO action_ledger (id,project_id,cycle_id,action_type,target,risk_level,requires_approval,approval_gate_id,idempotency_key,status,rollback_plan,audit_summary,payload,created_at,updated_at)
      VALUES (@id,@project_id,@cycle_id,@action_type,@target,@risk_level,@requires_approval,@approval_gate_id,@idempotency_key,@status,@rollback_plan,@audit_summary,@payload,@created_at,@updated_at)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        approval_gate_id=excluded.approval_gate_id,
        status=excluded.status,
        rollback_plan=excluded.rollback_plan,
        audit_summary=excluded.audit_summary,
        payload=excluded.payload,
        updated_at=excluded.updated_at`).run({
      id: a.id, project_id: a.projectId, cycle_id: a.cycleId,
      action_type: a.actionType, target: a.target, risk_level: a.riskLevel,
      requires_approval: a.requiresApproval, approval_gate_id: a.approvalGateId,
      idempotency_key: a.idempotencyKey, status: a.status,
      rollback_plan: a.rollbackPlan, audit_summary: a.auditSummary, payload: a.payload,
      created_at: a.createdAt, updated_at: a.updatedAt,
    });
    this.auditWrite("safety", "action_ledger", "upsert", null, a, this.cycleIdxFor(a.cycleId));
    const row = rawDb.prepare(`SELECT * FROM action_ledger WHERE idempotency_key=?`).get(a.idempotencyKey);
    return rowToActionLedger(row);
  }
  listActionLedger(projectId?: string): ActionLedgerRow[] {
    if (!projectId) return rawDb.prepare(`SELECT * FROM action_ledger ORDER BY created_at ASC, id ASC`).all().map(rowToActionLedger);
    return rawDb.prepare(`SELECT * FROM action_ledger WHERE project_id=? ORDER BY created_at ASC, id ASC`).all(projectId).map(rowToActionLedger);
  }
  // ---- knowledge reviews ----
  createKnowledgeReview(r: KnowledgeReviewItem): KnowledgeReviewItem {
    rawDb.prepare(`INSERT INTO knowledge_review_items (id,project_id,cycle_id,review_type,status,primary_knowledge_id,related_knowledge_id,reason,evidence,recommended_action,created_at,resolved_at,resolved_by,resolution,version)
      VALUES (@id,@project_id,@cycle_id,@review_type,@status,@primary_knowledge_id,@related_knowledge_id,@reason,@evidence,@recommended_action,@created_at,@resolved_at,@resolved_by,@resolution,@version)`).run({
      id: r.id, project_id: r.projectId, cycle_id: r.cycleId,
      review_type: r.reviewType, status: r.status, primary_knowledge_id: r.primaryKnowledgeId,
      related_knowledge_id: r.relatedKnowledgeId, reason: r.reason, evidence: r.evidence,
      recommended_action: r.recommendedAction, created_at: r.createdAt,
      resolved_at: r.resolvedAt, resolved_by: r.resolvedBy, resolution: r.resolution,
      version: r.version,
    });
    this.auditWrite("librarian", "knowledge_review_items", "insert", null, r, this.cycleIdxFor(r.cycleId));
    return r;
  }
  getKnowledgeReview(id: string): KnowledgeReviewItem | undefined {
    const r = rawDb.prepare(`SELECT * FROM knowledge_review_items WHERE id=?`).get(id);
    return r ? rowToKnowledgeReview(r) : undefined;
  }
  listKnowledgeReviews(projectId?: string): KnowledgeReviewItem[] {
    if (!projectId) return rawDb.prepare(`SELECT * FROM knowledge_review_items ORDER BY created_at ASC, id ASC`).all().map(rowToKnowledgeReview);
    return rawDb.prepare(`SELECT * FROM knowledge_review_items WHERE project_id=? ORDER BY created_at ASC, id ASC`).all(projectId).map(rowToKnowledgeReview);
  }
  updateKnowledgeReview(id: string, patch: Partial<KnowledgeReviewItem>): KnowledgeReviewItem | undefined {
    const cur = this.getKnowledgeReview(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE knowledge_review_items SET project_id=@project_id,cycle_id=@cycle_id,review_type=@review_type,status=@status,primary_knowledge_id=@primary_knowledge_id,related_knowledge_id=@related_knowledge_id,reason=@reason,evidence=@evidence,recommended_action=@recommended_action,created_at=@created_at,resolved_at=@resolved_at,resolved_by=@resolved_by,resolution=@resolution,version=@version WHERE id=@id`).run({
      id, project_id: n.projectId, cycle_id: n.cycleId,
      review_type: n.reviewType, status: n.status, primary_knowledge_id: n.primaryKnowledgeId,
      related_knowledge_id: n.relatedKnowledgeId, reason: n.reason, evidence: n.evidence,
      recommended_action: n.recommendedAction, created_at: n.createdAt,
      resolved_at: n.resolvedAt, resolved_by: n.resolvedBy, resolution: n.resolution,
      version: n.version,
    });
    this.auditWrite("human", "knowledge_review_items", "update", cur, n, this.cycleIdxFor(n.cycleId));
    return n;
  }
  // ---- business signals ----
  createExternalBusinessSignal(s: ExternalBusinessSignal): ExternalBusinessSignal {
    rawDb.prepare(`INSERT INTO external_business_signals (id,source,source_id,project_id,signal_type,observed_at,payload,sensitivity_level,dedupe_key,risk_level,feedback_id,gate_id,created_at,version)
      VALUES (@id,@source,@source_id,@project_id,@signal_type,@observed_at,@payload,@sensitivity_level,@dedupe_key,@risk_level,@feedback_id,@gate_id,@created_at,@version)`).run({
      id: s.id, source: s.source, source_id: s.sourceId, project_id: s.projectId,
      signal_type: s.signalType, observed_at: s.observedAt, payload: s.payload,
      sensitivity_level: s.sensitivityLevel, dedupe_key: s.dedupeKey, risk_level: s.riskLevel,
      feedback_id: s.feedbackId, gate_id: s.gateId, created_at: s.createdAt, version: s.version,
    });
    this.auditWrite("sensor", "external_business_signals", "insert", null, {
      ...s,
      payload: parseJsonObject(s.payload),
    }, 0);
    return s;
  }
  getExternalBusinessSignal(id: string): ExternalBusinessSignal | undefined {
    const r = rawDb.prepare(`SELECT * FROM external_business_signals WHERE id=?`).get(id);
    return r ? rowToExternalBusinessSignal(r) : undefined;
  }
  getExternalBusinessSignalByDedupe(projectId: string, dedupeKey: string): ExternalBusinessSignal | undefined {
    const r = rawDb.prepare(`SELECT * FROM external_business_signals WHERE project_id=? AND dedupe_key=?`).get(projectId, dedupeKey);
    return r ? rowToExternalBusinessSignal(r) : undefined;
  }
  listExternalBusinessSignals(projectId: string): ExternalBusinessSignal[] {
    return rawDb.prepare(`SELECT * FROM external_business_signals WHERE project_id=? ORDER BY observed_at ASC, id ASC`).all(projectId).map(rowToExternalBusinessSignal);
  }
  updateExternalBusinessSignal(id: string, patch: Partial<ExternalBusinessSignal>): ExternalBusinessSignal | undefined {
    const cur = this.getExternalBusinessSignal(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE external_business_signals SET source=@source,source_id=@source_id,project_id=@project_id,signal_type=@signal_type,observed_at=@observed_at,payload=@payload,sensitivity_level=@sensitivity_level,dedupe_key=@dedupe_key,risk_level=@risk_level,feedback_id=@feedback_id,gate_id=@gate_id,created_at=@created_at,version=@version WHERE id=@id`).run({
      id, source: n.source, source_id: n.sourceId, project_id: n.projectId,
      signal_type: n.signalType, observed_at: n.observedAt, payload: n.payload,
      sensitivity_level: n.sensitivityLevel, dedupe_key: n.dedupeKey, risk_level: n.riskLevel,
      feedback_id: n.feedbackId, gate_id: n.gateId, created_at: n.createdAt, version: n.version,
    });
    this.auditWrite("sensor", "external_business_signals", "update", cur, {
      ...n,
      payload: parseJsonObject(n.payload),
    }, 0);
    return n;
  }
  // ---- sensor firewall ----
  upsertSensorErrorAccumulator(a: SensorErrorAccumulator): SensorErrorAccumulator {
    const cur = this.getSensorErrorAccumulator(a.fingerprint);
    const n = { ...a, version: cur ? cur.version + 1 : a.version };
    rawDb.prepare(`INSERT INTO sensor_error_accumulators (fingerprint,project_id,source,error_kind,occurrence_count,event_timestamps_ms,first_seen_at,last_seen_at,version)
      VALUES (@fingerprint,@project_id,@source,@error_kind,@occurrence_count,@event_timestamps_ms,@first_seen_at,@last_seen_at,@version)
      ON CONFLICT(fingerprint) DO UPDATE SET
        project_id=excluded.project_id,
        source=excluded.source,
        error_kind=excluded.error_kind,
        occurrence_count=excluded.occurrence_count,
        event_timestamps_ms=excluded.event_timestamps_ms,
        first_seen_at=excluded.first_seen_at,
        last_seen_at=excluded.last_seen_at,
        version=excluded.version`).run({
      fingerprint: n.fingerprint,
      project_id: n.projectId,
      source: n.source,
      error_kind: n.errorKind,
      occurrence_count: n.occurrenceCount,
      event_timestamps_ms: n.eventTimestampsMs,
      first_seen_at: n.firstSeenAt,
      last_seen_at: n.lastSeenAt,
      version: n.version,
    });
    this.auditWrite("sensor", "sensor_error_accumulators", cur ? "update" : "insert", cur ?? null, n, 0);
    return this.getSensorErrorAccumulator(n.fingerprint) ?? n;
  }
  getSensorErrorAccumulator(fingerprint: string): SensorErrorAccumulator | undefined {
    const r = rawDb.prepare(`SELECT * FROM sensor_error_accumulators WHERE fingerprint=?`).get(fingerprint);
    return r ? rowToSensorErrorAccumulator(r) : undefined;
  }
  listSensorErrorAccumulators(projectId: string): SensorErrorAccumulator[] {
    return rawDb.prepare(`SELECT * FROM sensor_error_accumulators WHERE project_id=? ORDER BY last_seen_at ASC, fingerprint ASC`)
      .all(projectId)
      .map(rowToSensorErrorAccumulator);
  }
  // ---- pending attributions ----
  createPendingAttribution(a: PendingAttribution): PendingAttribution {
    rawDb.prepare(`INSERT INTO pending_attributions (id,project_id,fingerprint,error_type,claim_error,context,confidence,status,gate_id,resolved_at,created_at,version)
      VALUES (@id,@project_id,@fingerprint,@error_type,@claim_error,@context,@confidence,@status,@gate_id,@resolved_at,@created_at,@version)`).run({
      id: a.id,
      project_id: a.projectId,
      fingerprint: a.fingerprint,
      error_type: a.errorType,
      claim_error: a.claimError,
      context: a.context,
      confidence: a.confidence,
      status: a.status,
      gate_id: a.gateId,
      resolved_at: a.resolvedAt,
      created_at: a.createdAt,
      version: a.version,
    });
    this.auditWrite("sensor", "pending_attributions", "insert", null, a, 0);
    return a;
  }
  getPendingAttribution(id: string): PendingAttribution | undefined {
    const r = rawDb.prepare(`SELECT * FROM pending_attributions WHERE id=?`).get(id);
    return r ? rowToPendingAttribution(r) : undefined;
  }
  listPendingAttributions(projectId: string, options: { fingerprint?: string; since?: string; status?: string } = {}): PendingAttribution[] {
    const conditions = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.fingerprint) {
      conditions.push("fingerprint = ?");
      params.push(options.fingerprint);
    }
    if (options.since) {
      conditions.push("created_at >= ?");
      params.push(options.since);
    }
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    return rawDb.prepare(`SELECT * FROM pending_attributions WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC, id ASC`)
      .all(...params)
      .map(rowToPendingAttribution);
  }
  updatePendingAttribution(id: string, patch: Partial<PendingAttribution>): PendingAttribution | undefined {
    const cur = this.getPendingAttribution(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE pending_attributions SET project_id=@project_id,fingerprint=@fingerprint,error_type=@error_type,claim_error=@claim_error,context=@context,confidence=@confidence,status=@status,gate_id=@gate_id,resolved_at=@resolved_at,created_at=@created_at,version=@version WHERE id=@id`).run({
      id,
      project_id: n.projectId,
      fingerprint: n.fingerprint,
      error_type: n.errorType,
      claim_error: n.claimError,
      context: n.context,
      confidence: n.confidence,
      status: n.status,
      gate_id: n.gateId,
      resolved_at: n.resolvedAt,
      created_at: n.createdAt,
      version: n.version,
    });
    this.auditWrite("sensor", "pending_attributions", "update", cur, n, 0);
    return n;
  }
  // ---- distiller proposals ----
  createDistillerProposal(p: DistillerProposal): DistillerProposal {
    rawDb.prepare(`INSERT INTO distiller_proposals (id,project_id,cycle_id,proposal_type,target_knowledge_id,proposed_content,attribution_basis,regression_status,regression_failed_cases,gate_id,status,created_at)
      VALUES (@id,@project_id,@cycle_id,@proposal_type,@target_knowledge_id,@proposed_content,@attribution_basis,@regression_status,@regression_failed_cases,@gate_id,@status,@created_at)`).run({
      id: p.id,
      project_id: p.projectId,
      cycle_id: p.cycleId,
      proposal_type: p.proposalType,
      target_knowledge_id: p.targetKnowledgeId,
      proposed_content: p.proposedContent,
      attribution_basis: p.attributionBasis,
      regression_status: p.regressionStatus,
      regression_failed_cases: p.regressionFailedCases,
      gate_id: p.gateId,
      status: p.status,
      created_at: p.createdAt,
    });
    this.auditWrite("distiller", "distiller_proposals", "insert", null, p, this.cycleIdxFor(p.cycleId));
    return p;
  }
  getDistillerProposal(id: string): DistillerProposal | undefined {
    const r = rawDb.prepare(`SELECT * FROM distiller_proposals WHERE id=?`).get(id);
    return r ? rowToDistillerProposal(r) : undefined;
  }
  getDistillerProposalByGate(gateId: string): DistillerProposal | undefined {
    const r = rawDb.prepare(`SELECT * FROM distiller_proposals WHERE gate_id=? ORDER BY created_at DESC LIMIT 1`).get(gateId);
    return r ? rowToDistillerProposal(r) : undefined;
  }
  listDistillerProposals(projectId?: string, options: { status?: string; gateId?: string } = {}): DistillerProposal[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (projectId) {
      conditions.push("project_id = ?");
      params.push(projectId);
    }
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.gateId) {
      conditions.push("gate_id = ?");
      params.push(options.gateId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return rawDb.prepare(`SELECT * FROM distiller_proposals ${where} ORDER BY created_at ASC, id ASC`)
      .all(...params)
      .map(rowToDistillerProposal);
  }
  updateDistillerProposal(id: string, patch: Partial<DistillerProposal>): DistillerProposal | undefined {
    const cur = this.getDistillerProposal(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    rawDb.prepare(`UPDATE distiller_proposals SET project_id=@project_id,cycle_id=@cycle_id,proposal_type=@proposal_type,target_knowledge_id=@target_knowledge_id,proposed_content=@proposed_content,attribution_basis=@attribution_basis,regression_status=@regression_status,regression_failed_cases=@regression_failed_cases,gate_id=@gate_id,status=@status,created_at=@created_at WHERE id=@id`).run({
      id,
      project_id: n.projectId,
      cycle_id: n.cycleId,
      proposal_type: n.proposalType,
      target_knowledge_id: n.targetKnowledgeId,
      proposed_content: n.proposedContent,
      attribution_basis: n.attributionBasis,
      regression_status: n.regressionStatus,
      regression_failed_cases: n.regressionFailedCases,
      gate_id: n.gateId,
      status: n.status,
      created_at: n.createdAt,
    });
    this.auditWrite("distiller", "distiller_proposals", "update", cur, n, this.cycleIdxFor(n.cycleId));
    return n;
  }
  // ---- gold cases ----
  createGoldCase(c: GoldCase): GoldCase {
    rawDb.prepare(`INSERT INTO gold_cases (id,project_id,fingerprint,input,expected_error_type,expected_route,active,retired_reason,last_confirmed_at,source_proposal_id,created_at)
      VALUES (@id,@project_id,@fingerprint,@input,@expected_error_type,@expected_route,@active,@retired_reason,@last_confirmed_at,@source_proposal_id,@created_at)`).run({
      id: c.id,
      project_id: c.projectId,
      fingerprint: c.fingerprint,
      input: c.input,
      expected_error_type: c.expectedErrorType,
      expected_route: c.expectedRoute,
      active: c.active,
      retired_reason: c.retiredReason,
      last_confirmed_at: c.lastConfirmedAt,
      source_proposal_id: c.sourceProposalId,
      created_at: c.createdAt,
    });
    this.auditWrite("librarian", "gold_cases", "insert", null, c, 0);
    return c;
  }
  getGoldCase(id: string): GoldCase | undefined {
    const r = rawDb.prepare(`SELECT * FROM gold_cases WHERE id=?`).get(id);
    return r ? rowToGoldCase(r) : undefined;
  }
  listGoldCases(projectId?: string, options: { active?: boolean; sourceProposalId?: string } = {}): GoldCase[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (projectId) {
      conditions.push("project_id = ?");
      params.push(projectId);
    }
    if (typeof options.active === "boolean") {
      conditions.push("active = ?");
      params.push(options.active ? 1 : 0);
    }
    if (options.sourceProposalId) {
      conditions.push("source_proposal_id = ?");
      params.push(options.sourceProposalId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return rawDb.prepare(`SELECT * FROM gold_cases ${where} ORDER BY created_at ASC, id ASC`)
      .all(...params)
      .map(rowToGoldCase);
  }
  updateGoldCase(id: string, patch: Partial<GoldCase>): GoldCase | undefined {
    const cur = this.getGoldCase(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    rawDb.prepare(`UPDATE gold_cases SET project_id=@project_id,fingerprint=@fingerprint,input=@input,expected_error_type=@expected_error_type,expected_route=@expected_route,active=@active,retired_reason=@retired_reason,last_confirmed_at=@last_confirmed_at,source_proposal_id=@source_proposal_id,created_at=@created_at WHERE id=@id`).run({
      id,
      project_id: n.projectId,
      fingerprint: n.fingerprint,
      input: n.input,
      expected_error_type: n.expectedErrorType,
      expected_route: n.expectedRoute,
      active: n.active,
      retired_reason: n.retiredReason,
      last_confirmed_at: n.lastConfirmedAt,
      source_proposal_id: n.sourceProposalId,
      created_at: n.createdAt,
    });
    this.auditWrite("librarian", "gold_cases", "update", cur, n, 0);
    return n;
  }
  // ---- org modules ----
  createOrgModule(m: OrgModule): OrgModule {
    rawDb.prepare(`INSERT INTO org_modules (id,project_id,module_name,problem_solved,owner_role,responsibility_boundaries,upstream_dependencies,downstream_consumers,data_inputs,data_outputs,call_chain,mvp_definition,test_plan,execution_plan,known_pitfalls,redlines,version_label,knowledge_id,created_at,updated_at,version)
      VALUES (@id,@project_id,@module_name,@problem_solved,@owner_role,@responsibility_boundaries,@upstream_dependencies,@downstream_consumers,@data_inputs,@data_outputs,@call_chain,@mvp_definition,@test_plan,@execution_plan,@known_pitfalls,@redlines,@version_label,@knowledge_id,@created_at,@updated_at,@version)`).run({
      id: m.id, project_id: m.projectId, module_name: m.moduleName,
      problem_solved: m.problemSolved, owner_role: m.ownerRole,
      responsibility_boundaries: m.responsibilityBoundaries,
      upstream_dependencies: m.upstreamDependencies,
      downstream_consumers: m.downstreamConsumers,
      data_inputs: m.dataInputs, data_outputs: m.dataOutputs, call_chain: m.callChain,
      mvp_definition: m.mvpDefinition, test_plan: m.testPlan, execution_plan: m.executionPlan,
      known_pitfalls: m.knownPitfalls, redlines: m.redlines,
      version_label: m.versionLabel, knowledge_id: m.knowledgeId,
      created_at: m.createdAt, updated_at: m.updatedAt, version: m.version,
    });
    this.auditWrite("owner", "org_modules", "insert", null, m, 0);
    return m;
  }
  getOrgModule(id: string): OrgModule | undefined {
    const r = rawDb.prepare(`SELECT * FROM org_modules WHERE id=?`).get(id);
    return r ? rowToOrgModule(r) : undefined;
  }
  listOrgModules(projectId: string): OrgModule[] {
    return rawDb.prepare(`SELECT * FROM org_modules WHERE project_id=? ORDER BY module_name ASC, id ASC`).all(projectId).map(rowToOrgModule);
  }
  updateOrgModule(id: string, patch: Partial<OrgModule>): OrgModule | undefined {
    const cur = this.getOrgModule(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, updatedAt: patch.updatedAt ?? now(), version: cur.version + 1 };
    rawDb.prepare(`UPDATE org_modules SET project_id=@project_id,module_name=@module_name,problem_solved=@problem_solved,owner_role=@owner_role,responsibility_boundaries=@responsibility_boundaries,upstream_dependencies=@upstream_dependencies,downstream_consumers=@downstream_consumers,data_inputs=@data_inputs,data_outputs=@data_outputs,call_chain=@call_chain,mvp_definition=@mvp_definition,test_plan=@test_plan,execution_plan=@execution_plan,known_pitfalls=@known_pitfalls,redlines=@redlines,version_label=@version_label,knowledge_id=@knowledge_id,created_at=@created_at,updated_at=@updated_at,version=@version WHERE id=@id`).run({
      id, project_id: n.projectId, module_name: n.moduleName,
      problem_solved: n.problemSolved, owner_role: n.ownerRole,
      responsibility_boundaries: n.responsibilityBoundaries,
      upstream_dependencies: n.upstreamDependencies,
      downstream_consumers: n.downstreamConsumers,
      data_inputs: n.dataInputs, data_outputs: n.dataOutputs, call_chain: n.callChain,
      mvp_definition: n.mvpDefinition, test_plan: n.testPlan, execution_plan: n.executionPlan,
      known_pitfalls: n.knownPitfalls, redlines: n.redlines,
      version_label: n.versionLabel, knowledge_id: n.knowledgeId,
      created_at: n.createdAt, updated_at: n.updatedAt, version: n.version,
    });
    this.auditWrite("owner", "org_modules", "update", cur, n, 0);
    return n;
  }
  deleteOrgModule(id: string): boolean {
    const cur = this.getOrgModule(id);
    if (!cur) return false;
    rawDb.prepare(`DELETE FROM org_modules WHERE id=?`).run(id);
    this.auditWrite("owner", "org_modules", "delete", cur, null, 0);
    return true;
  }
  // ---- agent runs ----
  recordAgentRun(r: Omit<AgentRun, "id">): void {
    rawDb.prepare(`INSERT INTO agent_runs (cycle_id,cycle_idx,agent,action,output_summary,knowledge_refs_used,ts) VALUES (?,?,?,?,?,?,?)`).run(r.cycleId, r.cycleIdx, r.agent, r.action, r.outputSummary, r.knowledgeRefsUsed, r.ts);
    this.auditWrite(r.agent || "agent", "agent_runs", "insert", null, r, r.cycleIdx);
  }
  listAgentRuns(cycleId?: string): AgentRun[] {
    if (!cycleId) return rawDb.prepare(`SELECT * FROM agent_runs ORDER BY id ASC`).all().map(rowToAgentRun);
    return rawDb.prepare(`SELECT * FROM agent_runs WHERE cycle_id=? ORDER BY id ASC`).all(cycleId).map(rowToAgentRun);
  }
  listAgentRunsReferencingKnowledge(knowledgeId: string, projectId: string, limit = 50): AgentRun[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const pattern = `%"${escapeLike(knowledgeId)}"%`;
    const rows = rawDb.prepare(`
      SELECT r.*
      FROM agent_runs r
      JOIN cycles c ON c.id = r.cycle_id
      WHERE c.project_id = ?
        AND r.knowledge_refs_used LIKE ? ESCAPE '\\'
      ORDER BY r.cycle_idx DESC, r.id DESC
      LIMIT ?
    `).all(projectId, pattern, safeLimit);
    return rows
      .map(rowToAgentRun)
      .filter((run) => {
        try {
          return (JSON.parse(run.knowledgeRefsUsed) as string[]).includes(knowledgeId);
        } catch {
          return false;
        }
      })
      .slice(0, safeLimit);
  }
  // ---- external feedback sources ----
  createExternalFeedbackSource(s: ExternalFeedbackSource): ExternalFeedbackSource {
    rawDb.prepare(`INSERT INTO external_feedback_sources (id,project_id,kind,config,status,last_synced_at,created_at,version)
      VALUES (@id,@project_id,@kind,@config,@status,@last_synced_at,@created_at,@version)`).run({
      id: s.id, project_id: s.projectId, kind: s.kind, config: s.config, status: s.status,
      last_synced_at: s.lastSyncedAt, created_at: s.createdAt, version: s.version,
    });
    this.auditWrite("owner", "external_feedback_sources", "insert", null, s, 0);
    return s;
  }
  getExternalFeedbackSource(id: string): ExternalFeedbackSource | undefined {
    const r = rawDb.prepare(`SELECT * FROM external_feedback_sources WHERE id=?`).get(id);
    return r ? rowToExternalFeedbackSource(r) : undefined;
  }
  listExternalFeedbackSources(projectId: string): ExternalFeedbackSource[] {
    return rawDb.prepare(`SELECT * FROM external_feedback_sources WHERE project_id=? ORDER BY created_at ASC`).all(projectId).map(rowToExternalFeedbackSource);
  }
  updateExternalFeedbackSource(id: string, patch: Partial<ExternalFeedbackSource>): ExternalFeedbackSource | undefined {
    const cur = this.getExternalFeedbackSource(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE external_feedback_sources SET kind=@kind,config=@config,status=@status,last_synced_at=@last_synced_at,created_at=@created_at,version=@version WHERE id=@id`).run({
      id, kind: n.kind, config: n.config, status: n.status, last_synced_at: n.lastSyncedAt,
      created_at: n.createdAt, version: n.version,
    });
    this.auditWrite("sensor", "external_feedback_sources", "update", cur, n, 0);
    return n;
  }
}

export const storage = new DatabaseStorage();
export { now };
