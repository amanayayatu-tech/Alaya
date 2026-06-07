import Database from "better-sqlite3";
import { assertEnvValid, isLongRunMode, isSchemaMigrationAllowed, runModeFromEnv } from "./config/env";
import { redactSensitiveData, redactSensitiveText } from "./security/redact";
import type {
  Project, Cycle, Agent, Task, FeedbackItem, Prediction, Observation,
  KnowledgeItem, HumanGateItem, DecisionLogItem, EventLogItem, LlmCall, AgentRun,
  ExternalFeedbackSource, TraceEventItem, ActionLedgerRow,
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
  "decision_log",
  "event_log",
  "llm_calls",
  "agent_runs",
  "external_feedback_sources",
  "trace_events",
  "action_ledger",
];

const REQUIRED_COLUMNS: Record<string, string[]> = {
  llm_calls: ["input_token_count", "output_token_count"],
  knowledge_items: ["usage_count", "last_injected_at", "last_verified_at", "last_decayed_at", "semantic_key"],
  external_feedback_sources: ["config", "status", "last_synced_at"],
  action_ledger: ["idempotency_key", "status", "payload"],
  trace_events: ["trace_id", "span_id", "attributes"],
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
    storage_strength REAL NOT NULL DEFAULT 1.0, novelty_score REAL, source_round INTEGER,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '', superseded_by TEXT, semantic_key TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS human_gate_items (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, type TEXT NOT NULL,
    blocking INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending', estimated_minutes INTEGER NOT NULL DEFAULT 10,
    decision TEXT, version INTEGER NOT NULL DEFAULT 1
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
    token_count INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0, ts TEXT NOT NULL
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
    ["storage_strength", "REAL NOT NULL DEFAULT 1.0"],
    ["novelty_score", "REAL"],
    ["source_round", "INTEGER"],
    ["superseded_by", "TEXT"],
    ["semantic_key", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, spec] of knowledgeColumnSpecs) {
    if (!knowledgeColumns.has(name)) sqlite.exec(`ALTER TABLE knowledge_items ADD COLUMN ${name} ${spec}`);
  }

  const llmColumns = tableColumns("llm_calls");
  const llmColumnSpecs: Array<[string, string]> = [
    ["provider", "TEXT NOT NULL DEFAULT 'mock'"],
    ["model", "TEXT NOT NULL DEFAULT 'mock'"],
    ["route_reason", "TEXT NOT NULL DEFAULT 'default'"],
    ["input_token_count", "INTEGER NOT NULL DEFAULT 0"],
    ["output_token_count", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, spec] of llmColumnSpecs) {
    if (!llmColumns.has(name)) sqlite.exec(`ALTER TABLE llm_calls ADD COLUMN ${name} ${spec}`);
  }
  sqlite.exec(`
    UPDATE llm_calls
    SET input_token_count = token_count, output_token_count = 0
    WHERE input_token_count = 0 AND output_token_count = 0 AND token_count > 0;
  `);

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
  CREATE INDEX IF NOT EXISTS idx_tasks_cycle ON tasks(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_cycle ON feedback_items(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_predictions_cycle ON predictions(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_project_cycle ON knowledge_items(project_id, created_by_cycle, id);
  CREATE INDEX IF NOT EXISTS idx_gates_cycle ON human_gate_items(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_cycle_ts ON decision_log(cycle_id, ts);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_cycle_id ON agent_runs(cycle_id, id);
  CREATE INDEX IF NOT EXISTS idx_external_sources_project ON external_feedback_sources(project_id);
  CREATE INDEX IF NOT EXISTS idx_trace_cycle ON trace_events(cycle_id, started_at, id);
  CREATE INDEX IF NOT EXISTS idx_trace_project ON trace_events(project_id, started_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_action_ledger_idem ON action_ledger(idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_action_ledger_project ON action_ledger(project_id, created_at);
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
    eCycle: r.e_cycle, worstClaimError: r.worst_claim_error, reasoning: r.reasoning, version: r.version,
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
    decision: r.decision, version: r.version,
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
    retryCount: r.retry_count, latencyMs: r.latency_ms,
    inputTokenCount: r.input_token_count ?? r.token_count ?? 0,
    outputTokenCount: r.output_token_count ?? 0,
    tokenCount: r.token_count,
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

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type LlmCallInsert = Omit<LlmCall, "id" | "provider" | "model" | "routeReason" | "inputTokenCount" | "outputTokenCount"> &
  Partial<Pick<LlmCall, "provider" | "model" | "routeReason" | "inputTokenCount" | "outputTokenCount">>;

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
  updateGate(id: string, patch: Partial<HumanGateItem>): HumanGateItem | undefined;
  // decision log
  createDecision(d: DecisionLogItem): DecisionLogItem;
  listDecisions(projectId?: string): DecisionLogItem[];
  // event log
  recordEvent(e: Omit<EventLogItem, "id">): void;
  listEvents(): EventLogItem[];
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
    rawDb.prepare(`INSERT INTO cycles (id,project_id,idx,goal,status,e_cycle,worst_claim_error,reasoning,version)
      VALUES (@id,@project_id,@idx,@goal,@status,@e_cycle,@worst_claim_error,@reasoning,@version)`).run({
      id: c.id, project_id: c.projectId, idx: c.idx, goal: c.goal, status: c.status,
      e_cycle: c.eCycle, worst_claim_error: c.worstClaimError, reasoning: c.reasoning, version: c.version,
    });
    this.auditWrite("orchestrator", "cycles", "insert", null, c, c.idx);
    return c;
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
    rawDb.prepare(`UPDATE cycles SET goal=@goal,status=@status,e_cycle=@e_cycle,worst_claim_error=@worst_claim_error,reasoning=@reasoning,version=@version WHERE id=@id`).run({
      id, goal: n.goal, status: n.status, e_cycle: n.eCycle, worst_claim_error: n.worstClaimError, reasoning: n.reasoning, version: n.version,
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
      storageStrength: k.storageStrength ?? 1,
      noveltyScore: k.noveltyScore ?? null,
      sourceRound: k.sourceRound ?? k.createdByCycle ?? null,
      supersededBy: k.supersededBy ?? null,
      semanticKey: k.semanticKey ?? "",
    };
    rawDb.prepare(`INSERT INTO knowledge_items (id,project_id,type,title,content,source_type,source_ref,evidence_alpha,evidence_beta,confidence_score,confidence_level,status,human_approved_count,external_verified_count,valid_from,valid_until,last_validated_cycle,created_by_cycle,created_by,approved_by,usage_count,last_injected_at,last_verified_at,last_decayed_at,storage_strength,novelty_score,source_round,tags,notes,superseded_by,semantic_key,version)
      VALUES (@id,@project_id,@type,@title,@content,@source_type,@source_ref,@evidence_alpha,@evidence_beta,@confidence_score,@confidence_level,@status,@human_approved_count,@external_verified_count,@valid_from,@valid_until,@last_validated_cycle,@created_by_cycle,@created_by,@approved_by,@usage_count,@last_injected_at,@last_verified_at,@last_decayed_at,@storage_strength,@novelty_score,@source_round,@tags,@notes,@superseded_by,@semantic_key,@version)`).run({
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
      storageStrength: rawPatch.storageStrength ?? cur.storageStrength ?? 1,
      noveltyScore: rawPatch.noveltyScore ?? cur.noveltyScore ?? null,
      sourceRound: rawPatch.sourceRound ?? cur.sourceRound ?? cur.createdByCycle ?? null,
      supersededBy: rawPatch.supersededBy ?? cur.supersededBy ?? null,
      semanticKey: rawPatch.semanticKey ?? cur.semanticKey ?? "",
      version: cur.version + 1,
    };
    rawDb.prepare(`UPDATE knowledge_items SET type=@type,title=@title,content=@content,source_type=@source_type,source_ref=@source_ref,evidence_alpha=@evidence_alpha,evidence_beta=@evidence_beta,confidence_score=@confidence_score,confidence_level=@confidence_level,status=@status,human_approved_count=@human_approved_count,external_verified_count=@external_verified_count,valid_from=@valid_from,valid_until=@valid_until,last_validated_cycle=@last_validated_cycle,created_by_cycle=@created_by_cycle,created_by=@created_by,approved_by=@approved_by,usage_count=@usage_count,last_injected_at=@last_injected_at,last_verified_at=@last_verified_at,last_decayed_at=@last_decayed_at,storage_strength=@storage_strength,novelty_score=@novelty_score,source_round=@source_round,tags=@tags,notes=@notes,superseded_by=@superseded_by,semantic_key=@semantic_key,version=@version WHERE id=@id`).run({
      id, type: n.type, title: n.title, content: n.content, source_type: n.sourceType, source_ref: n.sourceRef,
      evidence_alpha: n.evidenceAlpha, evidence_beta: n.evidenceBeta, confidence_score: n.confidenceScore,
      confidence_level: n.confidenceLevel, status: n.status, human_approved_count: n.humanApprovedCount,
      external_verified_count: n.externalVerifiedCount, valid_from: n.validFrom, valid_until: n.validUntil,
      last_validated_cycle: n.lastValidatedCycle, created_by_cycle: n.createdByCycle, created_by: n.createdBy,
      approved_by: n.approvedBy, usage_count: n.usageCount,
      last_injected_at: n.lastInjectedAt,
      last_verified_at: n.lastVerifiedAt,
      last_decayed_at: n.lastDecayedAt,
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
    rawDb.prepare(`INSERT INTO human_gate_items (id,cycle_id,type,blocking,title,payload,status,estimated_minutes,decision,version)
      VALUES (@id,@cycle_id,@type,@blocking,@title,@payload,@status,@estimated_minutes,@decision,@version)`).run({
      id: g.id, cycle_id: g.cycleId, type: g.type, blocking: g.blocking, title: g.title,
      payload: g.payload, status: g.status, estimated_minutes: g.estimatedMinutes, decision: g.decision, version: g.version,
    });
    this.auditWrite("orchestrator", "human_gate_items", "insert", null, g, this.cycleIdxFor(g.cycleId));
    return g;
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
  updateGate(id: string, patch: Partial<HumanGateItem>): HumanGateItem | undefined {
    const cur = this.getGate(id);
    if (!cur) return undefined;
    const resolvedNow = patch.status != null && patch.status !== cur.status && patch.status !== "pending";
    const payload = resolvedNow && patch.payload == null
      ? JSON.stringify({ ...parseJsonObject(cur.payload), resolvedAt: now() })
      : patch.payload;
    const n = { ...cur, ...patch, ...(payload != null ? { payload } : {}), version: cur.version + 1 };
    rawDb.prepare(`UPDATE human_gate_items SET type=@type,blocking=@blocking,title=@title,payload=@payload,status=@status,estimated_minutes=@estimated_minutes,decision=@decision,version=@version WHERE id=@id`).run({
      id, type: n.type, blocking: n.blocking, title: n.title, payload: n.payload, status: n.status,
      estimated_minutes: n.estimatedMinutes, decision: n.decision, version: n.version,
    });
    const actor = patch.decision?.includes("auto_approved") || patch.decision?.startsWith("merged_into:")
      ? "scheduler"
      : patch.status === "resolved" ? "human" : "librarian";
    this.auditWrite(actor, "human_gate_items", "update", cur, n, this.cycleIdxFor(n.cycleId));
    return n;
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
  // ---- llm calls ----
  recordLlmCall(c: LlmCallInsert): void {
    const n = {
      provider: c.provider ?? "mock",
      model: c.model ?? "mock",
      routeReason: c.routeReason ?? "default",
      inputTokenCount: c.inputTokenCount ?? c.tokenCount ?? 0,
      outputTokenCount: c.outputTokenCount ?? 0,
      ...c,
    };
    rawDb.prepare(`INSERT INTO llm_calls (cycle_id,agent,provider,model,route_reason,prompt_version,input_summary,output_summary,schema_valid,retry_count,latency_ms,input_token_count,output_token_count,token_count,estimated_cost,ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      n.cycleId, n.agent, n.provider, n.model, n.routeReason, n.promptVersion,
      n.inputSummary, n.outputSummary, n.schemaValid, n.retryCount, n.latencyMs,
      n.inputTokenCount, n.outputTokenCount, n.tokenCount, n.estimatedCost, n.ts,
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
