import Database from "better-sqlite3";
import type {
  Project, Cycle, Agent, Task, FeedbackItem, Prediction, Observation,
  KnowledgeItem, HumanGateItem, DecisionLogItem, EventLogItem, LlmCall, AgentRun,
} from "@shared/schema";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

export const rawDb = sqlite;

// ---------------- DDL ----------------
function migrate() {
  sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, direction TEXT NOT NULL,
    target_user TEXT NOT NULL, redlines TEXT NOT NULL DEFAULT '[]',
    weekly_human_minutes INTEGER NOT NULL DEFAULT 150,
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
    category TEXT NOT NULL, sentiment TEXT NOT NULL
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
    usage_count INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1
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
    prompt_version TEXT NOT NULL, input_summary TEXT NOT NULL DEFAULT '',
    output_summary TEXT NOT NULL DEFAULT '', schema_valid INTEGER NOT NULL DEFAULT 1,
    retry_count INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0, ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT NOT NULL, cycle_idx INTEGER NOT NULL,
    agent TEXT NOT NULL, action TEXT NOT NULL, output_summary TEXT NOT NULL DEFAULT '',
    knowledge_refs_used TEXT NOT NULL DEFAULT '[]', ts TEXT NOT NULL
  );
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
}
migrate();

const now = () => new Date().toISOString();

// ---------------- camel<->snake mapping helpers ----------------
// Tables map cleanly via aliased SELECT. We write explicit row mappers for type safety.

function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, direction: r.direction, targetUser: r.target_user,
    redlines: r.redlines, weeklyHumanMinutes: r.weekly_human_minutes,
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
function rowToKnowledge(r: any): KnowledgeItem {
  return {
    id: r.id, projectId: r.project_id, type: r.type, title: r.title, content: r.content,
    sourceType: r.source_type, sourceRef: r.source_ref, evidenceAlpha: r.evidence_alpha,
    evidenceBeta: r.evidence_beta, confidenceScore: r.confidence_score, confidenceLevel: r.confidence_level,
    status: r.status, humanApprovedCount: r.human_approved_count, externalVerifiedCount: r.external_verified_count,
    validFrom: r.valid_from, validUntil: r.valid_until, lastValidatedCycle: r.last_validated_cycle,
    createdByCycle: r.created_by_cycle, createdBy: r.created_by, approvedBy: r.approved_by,
    usageCount: r.usage_count, tags: r.tags, notes: r.notes, version: r.version,
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
  return { id: r.id, cycleId: r.cycle_id, text: r.text, category: r.category, sentiment: r.sentiment };
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
    id: r.id, cycleId: r.cycle_id, agent: r.agent, promptVersion: r.prompt_version,
    inputSummary: r.input_summary, outputSummary: r.output_summary, schemaValid: r.schema_valid,
    retryCount: r.retry_count, latencyMs: r.latency_ms, tokenCount: r.token_count,
    estimatedCost: r.estimated_cost, ts: r.ts,
  };
}
function rowToAgentRun(r: any): AgentRun {
  return { id: r.id, cycleId: r.cycle_id, cycleIdx: r.cycle_idx, agent: r.agent, action: r.action, outputSummary: r.output_summary, knowledgeRefsUsed: r.knowledge_refs_used, ts: r.ts };
}

export interface IStorage {
  // projects
  createProject(p: Project): Project;
  getProject(id: string): Project | undefined;
  listProjects(): Project[];
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
  // feedback
  createFeedback(f: FeedbackItem): FeedbackItem;
  listFeedback(cycleId: string): FeedbackItem[];
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
  updateKnowledge(id: string, patch: Partial<KnowledgeItem>): KnowledgeItem | undefined;
  searchKnowledge(projectId: string, query: string): KnowledgeItem[];
  // gates
  createGate(g: HumanGateItem): HumanGateItem;
  getGate(id: string): HumanGateItem | undefined;
  listGates(projectId?: string): HumanGateItem[];
  updateGate(id: string, patch: Partial<HumanGateItem>): HumanGateItem | undefined;
  // decision log
  createDecision(d: DecisionLogItem): DecisionLogItem;
  listDecisions(projectId?: string): DecisionLogItem[];
  // event log
  recordEvent(e: Omit<EventLogItem, "id">): void;
  listEvents(): EventLogItem[];
  // llm calls
  recordLlmCall(c: Omit<LlmCall, "id">): void;
  listLlmCalls(): LlmCall[];
  // agent runs
  recordAgentRun(r: Omit<AgentRun, "id">): void;
  listAgentRuns(cycleId?: string): AgentRun[];
}

export class DatabaseStorage implements IStorage {
  // ---- projects ----
  createProject(p: Project): Project {
    rawDb.prepare(`INSERT INTO projects (id,name,direction,target_user,redlines,weekly_human_minutes,seed_identity,world_model,current_cycle_idx,version)
      VALUES (@id,@name,@direction,@target_user,@redlines,@weekly_human_minutes,@seed_identity,@world_model,@current_cycle_idx,@version)`).run({
      id: p.id, name: p.name, direction: p.direction, target_user: p.targetUser, redlines: p.redlines,
      weekly_human_minutes: p.weeklyHumanMinutes, seed_identity: p.seedIdentity, world_model: p.worldModel,
      current_cycle_idx: p.currentCycleIdx, version: p.version,
    });
    return p;
  }
  getProject(id: string): Project | undefined {
    const r = rawDb.prepare(`SELECT * FROM projects WHERE id=?`).get(id);
    return r ? rowToProject(r) : undefined;
  }
  listProjects(): Project[] {
    return rawDb.prepare(`SELECT * FROM projects`).all().map(rowToProject);
  }
  updateProject(id: string, patch: Partial<Project>): Project | undefined {
    const cur = this.getProject(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE projects SET name=@name,direction=@direction,target_user=@target_user,redlines=@redlines,weekly_human_minutes=@weekly_human_minutes,seed_identity=@seed_identity,world_model=@world_model,current_cycle_idx=@current_cycle_idx,version=@version WHERE id=@id`).run({
      id, name: n.name, direction: n.direction, target_user: n.targetUser, redlines: n.redlines,
      weekly_human_minutes: n.weeklyHumanMinutes, seed_identity: n.seedIdentity, world_model: n.worldModel,
      current_cycle_idx: n.currentCycleIdx, version: n.version,
    });
    return n;
  }
  // ---- cycles ----
  createCycle(c: Cycle): Cycle {
    rawDb.prepare(`INSERT INTO cycles (id,project_id,idx,goal,status,e_cycle,worst_claim_error,reasoning,version)
      VALUES (@id,@project_id,@idx,@goal,@status,@e_cycle,@worst_claim_error,@reasoning,@version)`).run({
      id: c.id, project_id: c.projectId, idx: c.idx, goal: c.goal, status: c.status,
      e_cycle: c.eCycle, worst_claim_error: c.worstClaimError, reasoning: c.reasoning, version: c.version,
    });
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
    return n;
  }
  // ---- agents ----
  createAgent(a: Agent): Agent {
    rawDb.prepare(`INSERT INTO agents (id,project_id,name,role) VALUES (?,?,?,?)`).run(a.id, a.projectId, a.name, a.role);
    return a;
  }
  listAgents(projectId: string): Agent[] {
    return rawDb.prepare(`SELECT * FROM agents WHERE project_id=?`).all(projectId).map(rowToAgent);
  }
  // ---- tasks ----
  createTask(t: Task): Task {
    rawDb.prepare(`INSERT INTO tasks (id,cycle_id,agent,kind,status,spec) VALUES (?,?,?,?,?,?)`).run(t.id, t.cycleId, t.agent, t.kind, t.status, t.spec);
    return t;
  }
  listTasks(cycleId: string): Task[] {
    return rawDb.prepare(`SELECT * FROM tasks WHERE cycle_id=?`).all(cycleId).map(rowToTask);
  }
  // ---- feedback ----
  createFeedback(f: FeedbackItem): FeedbackItem {
    rawDb.prepare(`INSERT INTO feedback_items (id,cycle_id,text,category,sentiment) VALUES (?,?,?,?,?)`).run(f.id, f.cycleId, f.text, f.category, f.sentiment);
    return f;
  }
  listFeedback(cycleId: string): FeedbackItem[] {
    return rawDb.prepare(`SELECT * FROM feedback_items WHERE cycle_id=?`).all(cycleId).map(rowToFeedback);
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
    return n;
  }
  // ---- observations ----
  createObservation(o: Observation): Observation {
    rawDb.prepare(`INSERT INTO observations (id,cycle_id,prediction_id,metric,value,source) VALUES (?,?,?,?,?,?)`).run(o.id, o.cycleId, o.predictionId, o.metric, o.value, o.source);
    return o;
  }
  listObservations(cycleId: string): Observation[] {
    return rawDb.prepare(`SELECT * FROM observations WHERE cycle_id=?`).all(cycleId).map(rowToObservation);
  }
  // ---- knowledge ----
  createKnowledge(k: KnowledgeItem): KnowledgeItem {
    rawDb.prepare(`INSERT INTO knowledge_items (id,project_id,type,title,content,source_type,source_ref,evidence_alpha,evidence_beta,confidence_score,confidence_level,status,human_approved_count,external_verified_count,valid_from,valid_until,last_validated_cycle,created_by_cycle,created_by,approved_by,usage_count,tags,notes,version)
      VALUES (@id,@project_id,@type,@title,@content,@source_type,@source_ref,@evidence_alpha,@evidence_beta,@confidence_score,@confidence_level,@status,@human_approved_count,@external_verified_count,@valid_from,@valid_until,@last_validated_cycle,@created_by_cycle,@created_by,@approved_by,@usage_count,@tags,@notes,@version)`).run({
      id: k.id, project_id: k.projectId, type: k.type, title: k.title, content: k.content,
      source_type: k.sourceType, source_ref: k.sourceRef, evidence_alpha: k.evidenceAlpha, evidence_beta: k.evidenceBeta,
      confidence_score: k.confidenceScore, confidence_level: k.confidenceLevel, status: k.status,
      human_approved_count: k.humanApprovedCount, external_verified_count: k.externalVerifiedCount,
      valid_from: k.validFrom, valid_until: k.validUntil, last_validated_cycle: k.lastValidatedCycle,
      created_by_cycle: k.createdByCycle, created_by: k.createdBy, approved_by: k.approvedBy,
      usage_count: k.usageCount, tags: k.tags, notes: k.notes, version: k.version,
    });
    return k;
  }
  getKnowledge(id: string): KnowledgeItem | undefined {
    const r = rawDb.prepare(`SELECT * FROM knowledge_items WHERE id=?`).get(id);
    return r ? rowToKnowledge(r) : undefined;
  }
  listKnowledge(projectId: string): KnowledgeItem[] {
    return rawDb.prepare(`SELECT * FROM knowledge_items WHERE project_id=? ORDER BY created_by_cycle ASC, id ASC`).all(projectId).map(rowToKnowledge);
  }
  updateKnowledge(id: string, patch: Partial<KnowledgeItem>): KnowledgeItem | undefined {
    const cur = this.getKnowledge(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE knowledge_items SET type=@type,title=@title,content=@content,source_type=@source_type,source_ref=@source_ref,evidence_alpha=@evidence_alpha,evidence_beta=@evidence_beta,confidence_score=@confidence_score,confidence_level=@confidence_level,status=@status,human_approved_count=@human_approved_count,external_verified_count=@external_verified_count,valid_from=@valid_from,valid_until=@valid_until,last_validated_cycle=@last_validated_cycle,created_by_cycle=@created_by_cycle,created_by=@created_by,approved_by=@approved_by,usage_count=@usage_count,tags=@tags,notes=@notes,version=@version WHERE id=@id`).run({
      id, type: n.type, title: n.title, content: n.content, source_type: n.sourceType, source_ref: n.sourceRef,
      evidence_alpha: n.evidenceAlpha, evidence_beta: n.evidenceBeta, confidence_score: n.confidenceScore,
      confidence_level: n.confidenceLevel, status: n.status, human_approved_count: n.humanApprovedCount,
      external_verified_count: n.externalVerifiedCount, valid_from: n.validFrom, valid_until: n.validUntil,
      last_validated_cycle: n.lastValidatedCycle, created_by_cycle: n.createdByCycle, created_by: n.createdBy,
      approved_by: n.approvedBy, usage_count: n.usageCount, tags: n.tags, notes: n.notes, version: n.version,
    });
    return n;
  }
  searchKnowledge(projectId: string, query: string): KnowledgeItem[] {
    // Sanitize query into FTS5 prefix-OR terms
    const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"*`);
    if (terms.length === 0) return [];
    const match = terms.join(" OR ");
    const HIGH_RISK_EXCLUDED = ["stale", "expired", "quarantined", "conflict"];
    try {
      const rows = rawDb.prepare(`
        SELECT k.* FROM knowledge_fts f
        JOIN knowledge_items k ON k.rowid = f.rowid
        WHERE knowledge_fts MATCH ? AND k.project_id = ?
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
  updateGate(id: string, patch: Partial<HumanGateItem>): HumanGateItem | undefined {
    const cur = this.getGate(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch, version: cur.version + 1 };
    rawDb.prepare(`UPDATE human_gate_items SET type=@type,blocking=@blocking,title=@title,payload=@payload,status=@status,estimated_minutes=@estimated_minutes,decision=@decision,version=@version WHERE id=@id`).run({
      id, type: n.type, blocking: n.blocking, title: n.title, payload: n.payload, status: n.status,
      estimated_minutes: n.estimatedMinutes, decision: n.decision, version: n.version,
    });
    return n;
  }
  // ---- decision log ----
  createDecision(d: DecisionLogItem): DecisionLogItem {
    rawDb.prepare(`INSERT INTO decision_log (id,cycle_id,gate_type,decision,rationale,ts) VALUES (?,?,?,?,?,?)`).run(d.id, d.cycleId, d.gateType, d.decision, d.rationale, d.ts);
    return d;
  }
  listDecisions(projectId?: string): DecisionLogItem[] {
    if (!projectId) return rawDb.prepare(`SELECT * FROM decision_log ORDER BY ts ASC`).all().map(rowToDecision);
    return rawDb.prepare(`SELECT d.* FROM decision_log d JOIN cycles c ON d.cycle_id=c.id WHERE c.project_id=? ORDER BY d.ts ASC`).all(projectId).map(rowToDecision);
  }
  // ---- event log ----
  recordEvent(e: Omit<EventLogItem, "id">): void {
    rawDb.prepare(`INSERT INTO event_log (cycle_idx,actor,table_name,op,before,after,ts) VALUES (?,?,?,?,?,?,?)`).run(e.cycleIdx, e.actor, e.tableName, e.op, e.before ?? null, e.after ?? null, e.ts);
  }
  listEvents(): EventLogItem[] {
    return rawDb.prepare(`SELECT * FROM event_log ORDER BY id DESC LIMIT 500`).all().map(rowToEvent);
  }
  // ---- llm calls ----
  recordLlmCall(c: Omit<LlmCall, "id">): void {
    rawDb.prepare(`INSERT INTO llm_calls (cycle_id,agent,prompt_version,input_summary,output_summary,schema_valid,retry_count,latency_ms,token_count,estimated_cost,ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(c.cycleId, c.agent, c.promptVersion, c.inputSummary, c.outputSummary, c.schemaValid, c.retryCount, c.latencyMs, c.tokenCount, c.estimatedCost, c.ts);
  }
  listLlmCalls(): LlmCall[] {
    return rawDb.prepare(`SELECT * FROM llm_calls ORDER BY id ASC`).all().map(rowToLlm);
  }
  // ---- agent runs ----
  recordAgentRun(r: Omit<AgentRun, "id">): void {
    rawDb.prepare(`INSERT INTO agent_runs (cycle_id,cycle_idx,agent,action,output_summary,knowledge_refs_used,ts) VALUES (?,?,?,?,?,?,?)`).run(r.cycleId, r.cycleIdx, r.agent, r.action, r.outputSummary, r.knowledgeRefsUsed, r.ts);
  }
  listAgentRuns(cycleId?: string): AgentRun[] {
    if (!cycleId) return rawDb.prepare(`SELECT * FROM agent_runs ORDER BY id ASC`).all().map(rowToAgentRun);
    return rawDb.prepare(`SELECT * FROM agent_runs WHERE cycle_id=? ORDER BY id ASC`).all(cycleId).map(rowToAgentRun);
  }
}

export const storage = new DatabaseStorage();
export { now };
