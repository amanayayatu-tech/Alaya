/**
 * Alaya 核心类型定义。
 * 对应 PRD 第 6、8、10 章。
 */

// ---------------- 预测账本 (PRD 6.2, 10.4, 10.7) ----------------

/** 可测量断言类型 (PRD 10.4) */
export type ClaimType =
  | "metric_threshold"
  | "binary"
  | "categorical"
  | "directional"
  | "qualitative";

/** 比较操作符。修复漏洞A:由 operator 推导方向因子 d,不再手填。 */
export type Operator = ">=" | "<=";

export interface Claim {
  id: string;
  type: ClaimType;
  metric?: string;
  operator?: Operator; // metric_threshold 必填 (修复漏洞A)
  target?: number; // metric_threshold / directional
  observed?: number | null; // 观察值
  /** binary/categorical: 期望结果与实际结果 */
  expected?: string;
  actual?: string | null;
  /** directional: 期望方向 up/down/flat,实际方向 */
  expectedDirection?: "up" | "down" | "flat";
  actualDirection?: "up" | "down" | "flat" | null;
  /** 容差尺度,修复漏洞B:必须为正 */
  scale?: number;
  weight: number; // 关键预测应 >=3 (修复漏洞C)
  /** 预测编码闭环契约:没有这些字段,预测无法作为可靠学习信号。 */
  expectedObservation?: string;
  timeWindow?: string;
  successThreshold?: string;
  failureThreshold?: string;
  uncertainty?: number; // 0..1,越高代表越不确定
  error?: number | null; // 单 claim 归一化误差 [0,1]
}

export type ErrorType = "perception" | "execution" | "model" | "value" | null;

export interface Prediction {
  id: string;
  cycleId: string;
  belief: string;
  prediction: string;
  action: string;
  claims: Claim[];
  observation?: string | null;
  predictionError?: number | null; // E_cycle 级别由 cycle 汇总,这里存单预测误差
  errorType?: ErrorType;
  worstClaimError?: number | null; // 修复漏洞C:暴露最差 claim
  updateTarget?: string | null;
  status: "open" | "resolved";
  knowledgeRefs?: string[]; // 本预测引用了哪些知识 (复利追溯)
}

// ---------------- 误差归因输入 (PRD 10.6) ----------------

export interface AttributionContext {
  /** observation 数据源是否缺失/口径不一致/采集失败 */
  perceptionFailure: boolean;
  /** 关联 task 的 build 是否失败/测试缺失/发布未完成 */
  executionFailure: boolean;
  /** 指标达标但人类标记"方向不对/违背 identity" */
  humanFlaggedValueMismatch: boolean;
  /** 该 claim 是否为 qualitative */
  isQualitative: boolean;
}

// ---------------- 知识库 (PRD 8) ----------------

export type KnowledgeType =
  | "identity"
  | "world_model"
  | "playbook"
  | "case"
  | "fact"
  | "principle";

export type KnowledgeStatus =
  | "candidate"
  | "draft"
  | "active"
  | "strong"
  | "provisional"
  | "stale"
  | "expired"
  | "conflict"
  | "quarantined"
  | "deprecated"
  | "rejected";

export type ConfidenceLevel = "low" | "medium" | "high" | "verified";

export interface KnowledgeItem {
  id: string;
  projectId: string;
  type: KnowledgeType;
  title: string;
  content: string;
  sourceType:
    | "human_decision"
    | "feedback"
    | "metric"
    | "agent_observation"
    | "external_doc";
  sourceRef: string;
  /** 修复漏洞D:置信度由证据计数计算,Beta 先验 alpha=beta=1 */
  evidenceAlpha: number;
  evidenceBeta: number;
  confidenceScore: number; // alpha/(alpha+beta),可被衰减
  confidenceLevel: ConfidenceLevel;
  status: KnowledgeStatus;
  humanApprovedCount: number;
  externalVerifiedCount: number;
  validFrom: string;
  validUntil?: string | null;
  lastValidatedCycle: number; // 修复漏洞F:衰减按 cycle 触发
  createdByCycle: number;
  createdBy: string;
  approvedBy?: string | null;
  usageCount: number;
  lastInjectedAt?: number | null;
  lastVerifiedAt?: number | null;
  lastDecayedAt?: number | null;
  storageStrength?: number;
  noveltyScore?: number | null;
  sourceRound?: number | null;
  tags: string[];
  notes: string;
  /** 熵减合并后指向主知识；保留原条目，不物理删除。 */
  supersededBy?: string | null;
  /** server/agent 层生成的近义聚类稳定指纹；纯函数不读取外部知识。 */
  semanticKey?: string;
}

/** evidence_count 口径:修复漏洞D,剔除 Beta 先验后的真实证据条数 */
export function evidenceCount(k: { evidenceAlpha: number; evidenceBeta: number }): number {
  return Math.max(0, k.evidenceAlpha - 1) + Math.max(0, k.evidenceBeta - 1);
}

// ---------------- 人类闸门 (PRD 11) ----------------

export type GateType = "direction" | "meaning" | "risk";

export interface HumanGate {
  id: string;
  cycleId: string;
  type: GateType;
  blocking: boolean;
  title: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "modified";
  estimatedMinutes: number;
  decision?: string | null;
}

// ---------------- Trace / safety / model routing ----------------

export type TraceEventKind =
  | "cycle_state"
  | "agent_run"
  | "llm_call"
  | "knowledge_injection"
  | "error_classification"
  | "principle_transition"
  | "approval"
  | "action_risk";

export interface TraceEvent {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  projectId: string;
  cycleId?: string | null;
  cycleIdx?: number | null;
  kind: TraceEventKind;
  name: string;
  agent?: string | null;
  status: "ok" | "error" | "blocked";
  attributes: Record<string, unknown>;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
}

export type RiskLevel =
  | "read_only"
  | "draft_only"
  | "local_write"
  | "external_write"
  | "destructive"
  | "financial"
  | "compliance_sensitive";

export interface ActionLedgerItem {
  id: string;
  projectId: string;
  cycleId?: string | null;
  actionType: string;
  target: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  approvalGateId?: string | null;
  idempotencyKey: string;
  status: "proposed" | "approved" | "blocked" | "executed" | "rolled_back";
  rollbackPlan?: string | null;
  auditSummary?: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRoute {
  role: string;
  provider: string;
  model: string;
  routeReason: string;
}
