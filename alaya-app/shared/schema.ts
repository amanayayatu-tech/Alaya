import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// NOTE: schema.ts must NOT import shared/core to avoid cycles.
// Core pure functions are only imported on the server.

// ---------------- 1. projects ----------------
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  direction: text("direction").notNull(),
  targetUser: text("target_user").notNull(),
  redlines: text("redlines").notNull().default("[]"), // JSON string[]
  weeklyHumanMinutes: integer("weekly_human_minutes").notNull().default(150),
  weeklyLlmBudgetCents: integer("weekly_llm_budget_cents").notNull().default(100),
  firstClaimMetric: text("first_claim_metric").notNull().default("activation_rate"),
  firstClaimOperator: text("first_claim_operator").notNull().default(">="),
  firstClaimTarget: real("first_claim_target").notNull().default(0.3),
  seedIdentity: text("seed_identity").notNull().default(""),
  worldModel: text("world_model").notNull().default(""),
  currentCycleIdx: integer("current_cycle_idx").notNull().default(0),
  version: integer("version").notNull().default(1),
});

// ---------------- 2. cycles ----------------
export const cycles = sqliteTable("cycles", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  idx: integer("idx").notNull(),
  goal: text("goal").notNull().default(""),
  status: text("status").notNull().default("planning"), // planning/running/closed
  eCycle: real("e_cycle"),
  worstClaimError: real("worst_claim_error"),
  reasoning: text("reasoning").notNull().default(""),
  version: integer("version").notNull().default(1),
});

// ---------------- 3. agents ----------------
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
});

// ---------------- 4. tasks ----------------
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  agent: text("agent").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("open"),
  spec: text("spec").notNull().default("{}"), // JSON
});

// ---------------- 5. feedbackItems ----------------
export const feedbackItems = sqliteTable("feedback_items", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  text: text("text").notNull(),
  category: text("category").notNull(),
  sentiment: text("sentiment").notNull(),
  sourceType: text("source_type").notNull().default("scenario"),
  sourceRef: text("source_ref").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  topicKey: text("topic_key").notNull().default(""),
  summary: text("summary").notNull().default(""),
  externalUpdatedAt: text("external_updated_at").notNull().default(""),
});

// ---------------- 6. predictions ----------------
export const predictions = sqliteTable("predictions", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  belief: text("belief").notNull().default(""),
  prediction: text("prediction").notNull().default(""),
  action: text("action").notNull().default(""),
  claims: text("claims").notNull().default("[]"), // JSON Claim[]
  observation: text("observation"),
  predictionError: real("prediction_error"),
  worstClaimError: real("worst_claim_error"),
  errorType: text("error_type"), // perception/execution/model/value/null
  updateTarget: text("update_target"),
  status: text("status").notNull().default("open"), // open/resolved
  knowledgeRefs: text("knowledge_refs").notNull().default("[]"), // JSON string[]
});

// ---------------- 7. observations ----------------
export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  predictionId: text("prediction_id").notNull(),
  metric: text("metric").notNull(),
  value: real("value").notNull(),
  source: text("source").notNull(),
});

// ---------------- 8. knowledgeItems ----------------
export const knowledgeItems = sqliteTable("knowledge_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  sourceType: text("source_type").notNull(),
  sourceRef: text("source_ref").notNull().default(""),
  evidenceAlpha: real("evidence_alpha").notNull().default(1),
  evidenceBeta: real("evidence_beta").notNull().default(1),
  confidenceScore: real("confidence_score").notNull().default(0.5),
  confidenceLevel: text("confidence_level").notNull().default("low"),
  status: text("status").notNull().default("draft"),
  humanApprovedCount: integer("human_approved_count").notNull().default(0),
  externalVerifiedCount: integer("external_verified_count").notNull().default(0),
  validFrom: text("valid_from").notNull().default(""),
  validUntil: text("valid_until"),
  lastValidatedCycle: integer("last_validated_cycle").notNull().default(0),
  createdByCycle: integer("created_by_cycle").notNull().default(0),
  createdBy: text("created_by").notNull().default("distiller"),
  approvedBy: text("approved_by"),
  usageCount: integer("usage_count").notNull().default(0),
  tags: text("tags").notNull().default("[]"), // JSON string[]
  notes: text("notes").notNull().default(""),
  supersededBy: text("superseded_by"),
  semanticKey: text("semantic_key").notNull().default(""),
  version: integer("version").notNull().default(1),
});

// ---------------- 9. humanGateItems ----------------
export const humanGateItems = sqliteTable("human_gate_items", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  type: text("type").notNull(), // direction/meaning/risk
  blocking: integer("blocking").notNull().default(0),
  title: text("title").notNull(),
  payload: text("payload").notNull().default("{}"), // JSON
  status: text("status").notNull().default("pending"),
  estimatedMinutes: integer("estimated_minutes").notNull().default(10),
  decision: text("decision"),
  version: integer("version").notNull().default(1),
});

// ---------------- 10. decisionLog ----------------
export const decisionLog = sqliteTable("decision_log", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  gateType: text("gate_type").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale").notNull().default(""),
  ts: text("ts").notNull(),
});

// ---------------- 11. eventLog ----------------
export const eventLog = sqliteTable("event_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleIdx: integer("cycle_idx").notNull().default(0),
  actor: text("actor").notNull(),
  tableName: text("table_name").notNull(),
  op: text("op").notNull(),
  before: text("before"), // JSON
  after: text("after"), // JSON
  ts: text("ts").notNull(),
});

// ---------------- llmCalls ----------------
export const llmCalls = sqliteTable("llm_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: text("cycle_id").notNull(),
  agent: text("agent").notNull(),
  promptVersion: text("prompt_version").notNull(),
  inputSummary: text("input_summary").notNull().default(""),
  outputSummary: text("output_summary").notNull().default(""),
  schemaValid: integer("schema_valid").notNull().default(1),
  retryCount: integer("retry_count").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  tokenCount: integer("token_count").notNull().default(0),
  estimatedCost: real("estimated_cost").notNull().default(0),
  ts: text("ts").notNull(),
});

// ---------------- agentRuns (PRD 17.3: 每 Agent 每轮运行记录) ----------------
export const agentRuns = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: text("cycle_id").notNull(),
  cycleIdx: integer("cycle_idx").notNull(),
  agent: text("agent").notNull(),
  action: text("action").notNull(),
  outputSummary: text("output_summary").notNull().default(""),
  knowledgeRefsUsed: text("knowledge_refs_used").notNull().default("[]"),
  ts: text("ts").notNull(),
});

// ---------------- externalFeedbackSources ----------------
export const externalFeedbackSources = sqliteTable("external_feedback_sources", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  kind: text("kind").notNull(),
  config: text("config").notNull().default("{}"),
  status: text("status").notNull().default("active"),
  lastSyncedAt: text("last_synced_at"),
  createdAt: text("created_at").notNull(),
  version: integer("version").notNull().default(1),
});

// ---------------- Insert schemas & types ----------------
export const insertProjectSchema = createInsertSchema(projects).omit({ id: true, version: true, currentCycleIdx: true, seedIdentity: true, worldModel: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

export type Cycle = typeof cycles.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type FeedbackItem = typeof feedbackItems.$inferSelect;
export type Prediction = typeof predictions.$inferSelect;
export type Observation = typeof observations.$inferSelect;
type KnowledgeItemRow = typeof knowledgeItems.$inferSelect;
export type KnowledgeItem = Omit<KnowledgeItemRow, "supersededBy" | "semanticKey"> & {
  supersededBy?: string | null;
  semanticKey?: string;
};
export type HumanGateItem = typeof humanGateItems.$inferSelect;
export type DecisionLogItem = typeof decisionLog.$inferSelect;
export type EventLogItem = typeof eventLog.$inferSelect;
export type LlmCall = typeof llmCalls.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type ExternalFeedbackSource = typeof externalFeedbackSources.$inferSelect;

// onboarding interview payload (PRD 13.1)
export const onboardingSchema = z.object({
  name: z.string().min(1),
  oneLiner: z.string().min(1),       // 产品一句话
  targetUser: z.string().min(1),     // 目标用户
  currentHypothesis: z.string().min(1), // 当前假设
  neverDo: z.string().default(""),   // 绝不做什么
  redlines: z.array(z.string()).default([]), // 高风险红线
  founderPreference: z.string().default(""), // 创始人偏好
  competitors: z.string().default(""),       // 已知竞品
  feedbackSources: z.string().default(""),   // 反馈来源
  weeklyHumanMinutes: z.number().default(150), // 每周人工预算
  weeklyLlmBudgetCents: z.number().default(100), // 每周 LLM 成本预算, cents
  firstClaimMetric: z.string().default("activation_rate"), // 第一轮可观测指标
  firstClaimOperator: z.enum([">=", "<=", "=="]).default(">="), // 第一轮 claim operator
  firstClaimTarget: z.number().default(0.3), // 第一轮目标阈值
  firstSignal: z.string().min(1),    // 第一轮希望看到的信号
});
export type OnboardingInput = z.infer<typeof onboardingSchema>;
