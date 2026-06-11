import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// NOTE: schema.ts must NOT import alaya-core runtime code to avoid cycles.
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
  speculative: integer("speculative").notNull().default(0),
  parentCycleId: text("parent_cycle_id"),
  dependsOn: text("depends_on"),
  assumedOutcomes: text("assumed_outcomes"),
  draftStatus: text("draft_status"),
  applyScheduledAt: text("apply_scheduled_at"),
  appliedAt: text("applied_at"),
  coAppliedSet: text("co_applied_set"),
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
  lastInjectedAt: integer("last_injected_at"),
  lastVerifiedAt: integer("last_verified_at"),
  lastDecayedAt: integer("last_decayed_at"),
  grayStreak: integer("gray_streak").notNull().default(0),
  storageStrength: real("storage_strength").notNull().default(1.0),
  noveltyScore: real("novelty_score"),
  sourceRound: integer("source_round"),
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
  notifyPolicy: text("notify_policy").notNull().default("next_window"),
  deferUntil: text("defer_until"),
  rejectReasonCode: text("reject_reason_code"),
  reviewDwellMs: integer("review_dwell_ms"),
  evidenceRevalidatedAt: text("evidence_revalidated_at"),
  evidenceChanged: integer("evidence_changed").notNull().default(0),
  missedWindows: integer("missed_windows").notNull().default(0),
  version: integer("version").notNull().default(1),
});

// ---------------- 10. reviewSessions ----------------
export const reviewSessions = sqliteTable("review_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  source: text("source").notNull().default("scheduled"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  gatesTotal: integer("gates_total").notNull().default(0),
  gatesResolved: integer("gates_resolved").notNull().default(0),
  gatesDeferred: integer("gates_deferred").notNull().default(0),
  digestMessageId: text("digest_message_id"),
  summaryMessageId: text("summary_message_id"),
});

// ---------------- 11. notificationDigests ----------------
export const notificationDigests = sqliteTable("notification_digests", {
  projectId: text("project_id").notNull(),
  windowDate: text("window_date").notNull(),
  windowLabel: text("window_label").notNull(),
  sentAt: text("sent_at").notNull(),
  messageId: text("message_id"),
}, (table) => ({
  uniqueWindow: uniqueIndex("idx_notification_digests_project_window").on(table.projectId, table.windowDate, table.windowLabel),
}));

// ---------------- 12. decisionLog ----------------
export const decisionLog = sqliteTable("decision_log", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  gateType: text("gate_type").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale").notNull().default(""),
  ts: text("ts").notNull(),
});

// ---------------- 13. eventLog ----------------
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
  provider: text("provider").notNull().default("mock"),
  model: text("model").notNull().default("mock"),
  routeReason: text("route_reason").notNull().default("default"),
  promptVersion: text("prompt_version").notNull(),
  inputSummary: text("input_summary").notNull().default(""),
  outputSummary: text("output_summary").notNull().default(""),
  schemaValid: integer("schema_valid").notNull().default(1),
  llmFailureType: text("llm_failure_type"),
  retryCount: integer("retry_count").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  inputTokenCount: integer("input_token_count").notNull().default(0),
  outputTokenCount: integer("output_token_count").notNull().default(0),
  tokenCount: integer("token_count").notNull().default(0),
  tokenSource: text("token_source").notNull().default("estimated"),
  estimatedCost: real("estimated_cost").notNull().default(0),
  ts: text("ts").notNull(),
});

// ---------------- traceEvents ----------------
export const traceEvents = sqliteTable("trace_events", {
  id: text("id").primaryKey(),
  traceId: text("trace_id").notNull(),
  spanId: text("span_id").notNull(),
  parentSpanId: text("parent_span_id"),
  projectId: text("project_id").notNull(),
  cycleId: text("cycle_id"),
  cycleIdx: integer("cycle_idx"),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  agent: text("agent"),
  status: text("status").notNull().default("ok"),
  attributes: text("attributes").notNull().default("{}"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationMs: integer("duration_ms"),
});

// ---------------- actionLedger ----------------
export const actionLedger = sqliteTable("action_ledger", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  cycleId: text("cycle_id"),
  actionType: text("action_type").notNull(),
  target: text("target").notNull().default(""),
  riskLevel: text("risk_level").notNull(),
  requiresApproval: integer("requires_approval").notNull().default(0),
  approvalGateId: text("approval_gate_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("proposed"),
  rollbackPlan: text("rollback_plan"),
  auditSummary: text("audit_summary"),
  payload: text("payload").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
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

// ---------------- knowledgeReviewItems ----------------
export const knowledgeReviewItems = sqliteTable("knowledge_review_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  cycleId: text("cycle_id"),
  reviewType: text("review_type").notNull(),
  status: text("status").notNull().default("review_required"),
  primaryKnowledgeId: text("primary_knowledge_id").notNull(),
  relatedKnowledgeId: text("related_knowledge_id"),
  reason: text("reason").notNull().default(""),
  evidence: text("evidence").notNull().default("{}"),
  recommendedAction: text("recommended_action").notNull().default(""),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
  resolution: text("resolution"),
  version: integer("version").notNull().default(1),
});

// ---------------- externalBusinessSignals ----------------
export const externalBusinessSignals = sqliteTable("external_business_signals", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  sourceId: text("source_id").notNull(),
  projectId: text("project_id").notNull(),
  signalType: text("signal_type").notNull(),
  observedAt: text("observed_at").notNull(),
  payload: text("payload").notNull().default("{}"),
  sensitivityLevel: text("sensitivity_level").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  riskLevel: text("risk_level").notNull(),
  feedbackId: text("feedback_id"),
  gateId: text("gate_id"),
  createdAt: text("created_at").notNull(),
  version: integer("version").notNull().default(1),
});

// ---------------- orgModules ----------------
export const orgModules = sqliteTable("org_modules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  moduleName: text("module_name").notNull(),
  problemSolved: text("problem_solved").notNull().default(""),
  ownerRole: text("owner_role").notNull().default(""),
  responsibilityBoundaries: text("responsibility_boundaries").notNull().default("[]"),
  upstreamDependencies: text("upstream_dependencies").notNull().default("[]"),
  downstreamConsumers: text("downstream_consumers").notNull().default("[]"),
  dataInputs: text("data_inputs").notNull().default("[]"),
  dataOutputs: text("data_outputs").notNull().default("[]"),
  callChain: text("call_chain").notNull().default("[]"),
  mvpDefinition: text("mvp_definition").notNull().default(""),
  testPlan: text("test_plan").notNull().default(""),
  executionPlan: text("execution_plan").notNull().default(""),
  knownPitfalls: text("known_pitfalls").notNull().default("[]"),
  redlines: text("redlines").notNull().default("[]"),
  versionLabel: text("version_label").notNull().default("v1"),
  knowledgeId: text("knowledge_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  version: integer("version").notNull().default(1),
});

// ---------------- Insert schemas & types ----------------
export const insertProjectSchema = createInsertSchema(projects).omit({ id: true, version: true, currentCycleIdx: true, seedIdentity: true, worldModel: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

type CycleRow = typeof cycles.$inferSelect;
export type Cycle = Omit<
  CycleRow,
  "speculative" | "parentCycleId" | "dependsOn" | "assumedOutcomes" | "draftStatus" | "applyScheduledAt" | "appliedAt" | "coAppliedSet"
> & {
  speculative?: number;
  parentCycleId?: string | null;
  dependsOn?: string | null;
  assumedOutcomes?: string | null;
  draftStatus?: string | null;
  applyScheduledAt?: string | null;
  appliedAt?: string | null;
  coAppliedSet?: string | null;
};
export type Agent = typeof agents.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type FeedbackItem = typeof feedbackItems.$inferSelect;
export type Prediction = typeof predictions.$inferSelect;
export type Observation = typeof observations.$inferSelect;
type KnowledgeItemRow = typeof knowledgeItems.$inferSelect;
export type KnowledgeItem = Omit<
  KnowledgeItemRow,
  "supersededBy" | "semanticKey" | "lastInjectedAt" | "lastVerifiedAt" | "lastDecayedAt" | "grayStreak" | "storageStrength" | "noveltyScore" | "sourceRound"
> & {
  supersededBy?: string | null;
  semanticKey?: string;
  lastInjectedAt?: number | null;
  lastVerifiedAt?: number | null;
  lastDecayedAt?: number | null;
  grayStreak?: number;
  storageStrength?: number;
  noveltyScore?: number | null;
  sourceRound?: number | null;
};
type HumanGateItemRow = typeof humanGateItems.$inferSelect;
export type GateNotifyPolicy = "immediate" | "next_window";
export type HumanGateItem = Omit<
  HumanGateItemRow,
  "notifyPolicy" | "deferUntil" | "rejectReasonCode" | "reviewDwellMs" | "evidenceRevalidatedAt" | "evidenceChanged" | "missedWindows"
> & {
  notifyPolicy?: GateNotifyPolicy;
  deferUntil?: string | null;
  rejectReasonCode?: string | null;
  reviewDwellMs?: number | null;
  evidenceRevalidatedAt?: string | null;
  evidenceChanged?: number;
  missedWindows?: number;
};
export type ReviewSessionItem = typeof reviewSessions.$inferSelect;
export type NotificationDigestItem = typeof notificationDigests.$inferSelect;
export type DecisionLogItem = typeof decisionLog.$inferSelect;
export type EventLogItem = typeof eventLog.$inferSelect;
export type LlmCall = typeof llmCalls.$inferSelect;
export type TraceEventItem = typeof traceEvents.$inferSelect;
export type ActionLedgerRow = typeof actionLedger.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type ExternalFeedbackSource = typeof externalFeedbackSources.$inferSelect;
export type KnowledgeReviewItem = typeof knowledgeReviewItems.$inferSelect;
export type ExternalBusinessSignal = typeof externalBusinessSignals.$inferSelect;
export type OrgModule = typeof orgModules.$inferSelect;

export const CLAIM_SCALE_EPS = 1e-6;
export const MIN_METRIC_THRESHOLD_WEIGHT = 3;

export const operatorSchema = z.enum([">=", "<="]);
const finiteNumberSchema = z.number().finite();
const positiveWeightSchema = finiteNumberSchema.positive();
const positiveScaleSchema = finiteNumberSchema.min(CLAIM_SCALE_EPS, "scale must be positive and >= 1e-6");
const predictionContractFields = {
  expectedObservation: z.string().trim().min(1).optional(),
  timeWindow: z.string().trim().min(1).optional(),
  successThreshold: z.string().trim().min(1).optional(),
  failureThreshold: z.string().trim().min(1).optional(),
  uncertainty: finiteNumberSchema.min(0).max(1).optional(),
};

export const metricThresholdClaimSchema = z.object({
  id: z.string().trim().min(1),
  type: z.literal("metric_threshold"),
  metric: z.string().trim().min(1),
  operator: operatorSchema,
  target: finiteNumberSchema,
  observed: finiteNumberSchema.nullable().optional(),
  scale: positiveScaleSchema.optional(),
  weight: finiteNumberSchema.min(MIN_METRIC_THRESHOLD_WEIGHT),
  ...predictionContractFields,
  error: finiteNumberSchema.min(0).max(1).nullable().optional(),
}).strict();

const binaryLikeClaimBase = z.object({
  id: z.string().trim().min(1),
  expected: z.string().trim().min(1),
  actual: z.string().trim().min(1).nullable().optional(),
  weight: positiveWeightSchema.default(1),
  ...predictionContractFields,
  error: finiteNumberSchema.min(0).max(1).nullable().optional(),
}).strict();

export const binaryClaimSchema = binaryLikeClaimBase.extend({ type: z.literal("binary") });
export const categoricalClaimSchema = binaryLikeClaimBase.extend({ type: z.literal("categorical") });
export const directionalClaimSchema = z.object({
  id: z.string().trim().min(1),
  type: z.literal("directional"),
  expectedDirection: z.enum(["up", "down", "flat"]),
  actualDirection: z.enum(["up", "down", "flat"]).nullable().optional(),
  weight: positiveWeightSchema.default(1),
  ...predictionContractFields,
  error: finiteNumberSchema.min(0).max(1).nullable().optional(),
}).strict();
export const qualitativeClaimSchema = z.object({
  id: z.string().trim().min(1),
  type: z.literal("qualitative"),
  weight: positiveWeightSchema.default(1),
  error: finiteNumberSchema.min(0).max(1).nullable().optional(),
}).strict();

export const claimSchema = z.discriminatedUnion("type", [
  metricThresholdClaimSchema,
  binaryClaimSchema,
  categoricalClaimSchema,
  directionalClaimSchema,
  qualitativeClaimSchema,
]);
export type ClaimInput = z.infer<typeof claimSchema>;

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
  firstClaimMetric: z.string().trim().min(1), // 第一轮可观测指标
  firstClaimOperator: operatorSchema, // 第一轮 claim operator
  firstClaimTarget: z.number().finite(), // 第一轮目标阈值
  firstSignal: z.string().min(1),    // 第一轮希望看到的信号
});
export type OnboardingInput = z.infer<typeof onboardingSchema>;
