/**
 * Flywheel engine: ports shared/core/agents_ref.ts logic to a SQLite-backed runner.
 * Reuses the verified pure functions from shared/core (NO algorithm changes).
 * Sequentially schedules the 5 fixed agents and records every write to eventLog,
 * every LLM call to llmCalls (mock by default, OpenAI when configured).
 */
import { storage, now } from "./storage";
import { callLlm } from "./llm";
import { generateNextGoal, type NextGoalDraft, type NextGoalInput } from "./autonomousGoal";
import { buildKnowledgeContext } from "./knowledgeInjection";
import { computeSemanticKey, isContradiction, isSemanticDuplicate } from "./knowledgeSimilarity";
import { recordTrace } from "./trace";
import { recordActionProposal } from "./actionLedger";
import { computeClaimError, computeCycleError } from "@shared/core/compute_error.js";
import { classifyError, routeError } from "@shared/core/classify_error.js";
import { applyEvidence } from "@shared/core/update_confidence.js";
import { eligibleForHighRisk, transitionState } from "@shared/core/transition_state.js";
import { evidenceCount, type Claim, type AttributionContext, type Operator } from "@shared/core/types.js";
import type { HumanGateItem, KnowledgeItem } from "@shared/schema";

type LlmCaller = typeof callLlm;

// Deterministic explicit scenario. Missing future rounds must not reuse the last
// template, otherwise the audit trail can look valid while semantic compounding stalls.
export interface ScenarioRound {
  index: number;
  proposedGoal: string;
  alternativeGoals: string[];
  belief: string;
  prediction: string;
  action: string;
  activationObserved: number;
  activationTarget: number;
  feedback: { id: string; text: string; category: string; sentiment: string }[];
  buildSuccess: boolean;
  perceptionOk: boolean;
  humanValueMismatch: boolean;
  predictionMetric?: string;
  predictionOperator?: Operator;
  predictionTarget?: number;
  knowledgeRefs?: string[];
  reasoningHowKnowledgeChangedDecision?: string;
}

export const SCENARIO: ScenarioRound[] = [
  {
    index: 1,
    proposedGoal: "上线一键发布,验证早期用户是否愿意快速发布",
    alternativeGoals: ["先做高级定制能力", "先做团队协作"],
    belief: "早期用户最关心快速发布,而不是高级定制",
    prediction: "上线一键发布后,至少 30% 活跃测试用户会尝试",
    action: "开发一键发布 MVP",
    activationObserved: 0.12, activationTarget: 0.3,
    feedback: [
      { id: "f1", text: "我不敢点发布,因为不知道它到底会改动什么", category: "unclear_signal", sentiment: "negative" },
      { id: "f2", text: "一键发布听起来很爽但有点怕翻车", category: "feature_request", sentiment: "negative" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
  {
    index: 2,
    proposedGoal: "为发布加上 dry-run 预览与确认,降低用户恐惧",
    alternativeGoals: ["直接推广一键发布", "加更多发布渠道"],
    belief: "用户对不可预期的自动操作有恐惧,需要可预览",
    prediction: "加上发布预览后,activation 升到 30% 以上",
    action: "开发发布预览 + 确认步骤",
    activationObserved: 0.34, activationTarget: 0.3,
    feedback: [
      { id: "f3", text: "现在能先看到会发什么,我就敢用了", category: "metric_signal", sentiment: "positive" },
      { id: "f4", text: "预览很关键,删东西的时候也想要这个", category: "feature_request", sentiment: "positive" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
  {
    index: 3,
    proposedGoal: "(由系统基于前轮知识生成)",
    alternativeGoals: [],
    belief: "(由系统生成)",
    prediction: "(由系统生成)",
    action: "(由系统生成)",
    activationObserved: 0.41, activationTarget: 0.3,
    feedback: [
      { id: "f5", text: "删除前的预览太贴心了,这正是我担心的", category: "metric_signal", sentiment: "positive" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
  {
    index: 4,
    proposedGoal: "(由系统基于 strong/active 知识继续生成)",
    alternativeGoals: ["直接开放批量删除", "先做视觉主题与模板"],
    belief: "高风险自动化要继续扩大适用范围,必须同时满足可预览、可回滚、可追溯",
    prediction: "加入回滚与审计摘要后,activation 达到 45% 以上且正向复盘反馈增加",
    action: "开发变更包回滚入口 + 自动审计摘要",
    activationObserved: 0.48, activationTarget: 0.45,
    feedback: [
      { id: "f6", text: "现在有预览和回滚记录,我愿意让它处理更多发布前检查", category: "metric_signal", sentiment: "positive" },
      { id: "f7", text: "如果每次自动操作都有审计摘要,我可以拿给同事复盘", category: "feature_request", sentiment: "positive" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
];

export function scenarioForCycle(index: number): ScenarioRound | undefined {
  return SCENARIO.find((s) => s.index === index);
}

function requireScenarioRound(index: number): ScenarioRound {
  const sc = scenarioForCycle(index);
  if (!sc) {
    throw new Error(`No explicit Alaya scenario configured for cycle ${index}; refusing to reuse a previous cycle template.`);
  }
  return sc;
}

const PLAN_SCHEMA = {
  type: "object" as const,
  required: ["summary", "goal", "belief", "prediction", "action", "reasoning", "knowledgeRefs"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    goal: { type: "string" },
    belief: { type: "string" },
    prediction: { type: "string" },
    action: { type: "string" },
    reasoning: { type: "string" },
    knowledgeRefs: { type: "array" },
  },
};
const SUMMARY_ARRAY_SCHEMA = {
  type: "object" as const,
  required: ["summary", "items"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    items: { type: "array" },
  },
};
const BUILD_SCHEMA = {
  type: "object" as const,
  required: ["summary", "buildSuccess", "diffSummary", "testReport"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    buildSuccess: { type: "boolean" },
    diffSummary: { type: "string" },
    testReport: { type: "string" },
  },
};

function logEvent(cycleIdx: number, actor: string, table: string, op: string, after: unknown) {
  storage.recordEvent({ cycleIdx, actor, tableName: table, op, before: null, after: JSON.stringify(after), ts: now() });
}

function traceAgentRun(projectId: string, cycleId: string, cycleIdx: number, agent: string, action: string, knowledgeRefsUsed: string[]) {
  recordTrace({
    projectId,
    cycleId,
    cycleIdx,
    kind: "agent_run",
    name: action,
    agent,
    attributes: { knowledgeRefsUsed },
  });
}

// JSON field helpers for knowledge items (DB stores tags as JSON text)
function parseTags(k: KnowledgeItem): string[] {
  try { return JSON.parse(k.tags) as string[]; } catch { return []; }
}

let kbCounter = 0;
function nextKbId(projectId: string): string {
  // Keep IDs stable within a project and unique across projects/restarts.
  const ns = projectId.replace(/[^a-zA-Z0-9]+/g, "_");
  const existing = storage.listKnowledge(projectId).length;
  kbCounter = Math.max(kbCounter, existing);
  return `kb_${ns}_${String(++kbCounter).padStart(3, "0")}`;
}

function rollbackReadyChangePackage(sc: ScenarioRound, action: string) {
  if (sc.index !== 4) return undefined;
  return {
    packageType: "rollback-ready change package",
    modifiedObjects: [
      "high-risk action execution plan",
      "dry-run preview result",
      "release audit log",
    ],
    intendedAction: action,
    rollbackTrigger: "activation_rate < 0.45 或出现新的不可逆/不可追责负面反馈",
    rollbackSteps: [
      "停止自动执行入口,仅保留 dry-run 预览",
      "恢复第3轮删除预览策略",
      "把失败样本写入 meaning gate 交由 owner 复盘",
    ],
    riskLevel: "high",
  };
}

function auditSummaryForCycle4(refs: string[]) {
  return {
    stage: "cycle_4_rollback_audit",
    whyNow: "第2-3轮已经证明预览能降低恐惧,第4轮验证用户是否愿意把更多高风险动作交给系统持续处理。",
    deltaFromCycle3: "第3轮解决看到将改什么;第4轮新增执行后可回滚与全过程可追责。",
    verificationConstraints: [
      "必须有 rollbackPlan",
      "必须有 auditSummary",
      "不得跳过方向闸",
      "不得执行不可逆动作",
    ],
    knowledgeRefs: refs,
  };
}

function activeKnowledge(projectId: string): KnowledgeItem[] {
  return storage.listKnowledge(projectId)
    .filter((k) => !k.supersededBy)
    .filter((k) => ["active", "strong"].includes(k.status));
}

// Convert core KnowledgeItem (tags: string[]) <-> DB KnowledgeItem (tags: json text)
function coreFromDb(k: KnowledgeItem) {
  return { ...k, tags: parseTags(k), validUntil: k.validUntil ?? null, approvedBy: k.approvedBy ?? null } as any;
}
function applyEvidenceDb(k: KnowledgeItem, event: any) {
  const core = coreFromDb(k);
  const r = applyEvidence(core, event);
  return r.next;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function parseGatePayload(gate: HumanGateItem): Record<string, unknown> {
  try {
    const payload = JSON.parse(gate.payload);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function planFromExistingDirectionGate(gate: HumanGateItem, sc: ScenarioRound) {
  const payload = parseGatePayload(gate);
  const scenario = payload.scenario && typeof payload.scenario === "object" && !Array.isArray(payload.scenario)
    ? payload.scenario as Record<string, unknown>
    : {};
  const refs = stringArray(payload.knowledgeRefs ?? scenario.knowledgeRefs);
  const goal = nonEmptyString(payload.recommended ?? scenario.proposedGoal, sc.proposedGoal);
  const belief = nonEmptyString(payload.belief ?? scenario.belief, sc.belief);
  const prediction = nonEmptyString(payload.prediction ?? scenario.prediction, sc.prediction);
  const action = nonEmptyString(payload.action ?? scenario.action, sc.action);
  const reasoning = nonEmptyString(
    payload.reasoning ?? scenario.reasoningHowKnowledgeChangedDecision,
    sc.reasoningHowKnowledgeChangedDecision ?? "",
  );

  return { goal, belief, prediction, action, refs, reasoning, gate };
}

function mergeTags(required: string[], proposed: unknown): string[] {
  return Array.from(new Set([...required, ...stringArray(proposed)]));
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
}

function knowledgeCandidate(llmData: Record<string, unknown>, cycleIndex: number): Record<string, unknown> {
  const candidates = [
    ...objectArray(llmData.items),
    ...objectArray(llmData.knowledgeCandidates),
  ];
  return candidates.find((item) => Number(item.createdByCycle) === cycleIndex) ?? candidates[0] ?? {};
}

function distillerDraftOutput(sc: ScenarioRound, claimError: number): Record<string, unknown> {
  if (sc.index === 1) {
    return {
      summary: `cycle 1 distillation, claim_error=${claimError.toFixed(3)}`,
      items: [{
        type: "world_model",
        title: "用户对不可预期的自动操作有恐惧",
        content: "早期用户不敢用一键发布,因为不知道会改动什么。恐惧而非能力是采用门槛。",
        sourceType: "feedback",
        sourceRef: "f1,f2",
        tags: ["user_fear", "adoption"],
        notes: "由第1轮预测失败 + 两条负面反馈提炼",
        createdByCycle: 1,
      }],
    };
  }
  if (sc.index === 2) {
    return {
      summary: `cycle 2 distillation, claim_error=${claimError.toFixed(3)}`,
      items: [{
        type: "principle",
        title: "可预览/可逆显著降低高风险动作使用门槛",
        content: "为发布加 dry-run 预览后 activation 达标。预览把不可逆恐惧转为可控。",
        sourceType: "metric",
        sourceRef: "claim_2,f3,f4",
        tags: ["preview", "principle", "high_risk"],
        notes: "由第2轮预测成功 + 正面反馈提炼",
        createdByCycle: 2,
      }],
    };
  }
  if (sc.index === 4) {
    return {
      summary: `cycle 4 distillation, claim_error=${claimError.toFixed(3)}`,
      items: [{
        type: "principle",
        title: "高风险动作进入执行前必须具备可回滚路径与审计摘要",
        content: "第4轮把第3轮的 dry-run 预览升级为 rollback-ready change package: 高风险动作在进入执行前必须声明拟修改对象、回滚触发条件、回滚步骤、风险级别,并生成 audit summary 供 owner 复盘。",
        sourceType: "metric",
        sourceRef: "claim_4,f6,f7",
        tags: ["rollback", "auditability", "principle", "high_risk"],
        notes: "由第4轮预测成功 + 正向复盘反馈提炼",
        createdByCycle: 4,
      }],
    };
  }
  return {
    summary: `cycle ${sc.index} distillation, claim_error=${claimError.toFixed(3)}`,
    items: [],
  };
}

function safeKnowledgeRefs(projectId: string, proposed: unknown, fallback: string[]): string[] {
  const allowed = new Set(activeKnowledge(projectId).map((k) => k.id));
  const refs = stringArray(proposed).filter((id) => allowed.has(id));
  return refs.length > 0 || fallback.length === 0 ? refs : fallback;
}

function scenarioKnowledgeQuery(sc: ScenarioRound, extra = ""): string {
  return [
    extra,
    sc.proposedGoal,
    sc.belief,
    sc.prediction,
    sc.action,
    sc.feedback.map((item) => item.text).join("\n"),
  ].filter(Boolean).join("\n");
}

function worldModelLine(worldModel: string, label: string): string {
  const line = worldModel.split("\n").find((item) => item.startsWith(label));
  return line?.slice(label.length).trim() ?? "";
}

function projectSpecificFirstCyclePlan(projectId: string, cycleId: string, sc: ScenarioRound) {
  if (sc.index !== 1) return null;
  const project = storage.getProject(projectId);
  const cycle = storage.getCycle(cycleId);
  const cycleGoal = cycle?.goal?.trim() ?? "";
  if (!project || !cycleGoal || cycleGoal === sc.proposedGoal) return null;

  const hypothesis = worldModelLine(project.worldModel, "初始假设:") || project.direction;
  const firstSignal = worldModelLine(project.worldModel, "第一轮希望看到的信号:") || "第一轮外部信号";
  return {
    goal: cycleGoal,
    belief: `项目初始世界模型认为:${hypothesis}`,
    prediction: `如果围绕「${project.direction}」执行第一轮实验,应该能观察到「${firstSignal}」。`,
    action: `围绕「${project.direction}」产出第一轮可验证实验`,
    reasoning: `由 onboarding seed 生成:本轮优先验证「${hypothesis}」,观察信号为「${firstSignal}」。`,
  };
}

function isOperator(value: string): value is Operator {
  return value === ">=" || value === "<=";
}

function failureThreshold(metric: string, operator: Operator, target: number): string {
  if (operator === ">=") return `${metric} < ${target}`;
  return `${metric} > ${target}`;
}

function claimConfigForCycle(projectId: string, sc: ScenarioRound) {
  const project = storage.getProject(projectId);
  if (sc.predictionMetric && sc.predictionTarget != null) {
    const operator = sc.predictionOperator ?? ">=";
    return {
      metric: sc.predictionMetric,
      operator,
      target: sc.predictionTarget,
      observed: sc.activationObserved,
      scale: Math.max(Math.abs(sc.predictionTarget), 1),
    };
  }
  if (sc.index !== 1 || !project) {
    return {
      metric: "activation_rate",
      operator: ">=" as Operator,
      target: sc.activationTarget,
      observed: sc.activationObserved,
      scale: sc.activationTarget,
    };
  }
  const metric = project.firstClaimMetric.trim() || "activation_rate";
  const operator = isOperator(project.firstClaimOperator) ? project.firstClaimOperator : ">=";
  const target = Number.isFinite(project.firstClaimTarget) ? project.firstClaimTarget : sc.activationTarget;
  return {
    metric,
    operator,
    target,
    observed: sc.activationObserved,
    scale: Math.max(Math.abs(target), 1),
  };
}

function lastClosedCycle(projectId: string, beforeIdx: number) {
  return storage.listCycles(projectId)
    .filter((cycle) => cycle.idx < beforeIdx && cycle.status === "closed")
    .sort((a, b) => b.idx - a.idx)[0];
}

function goalsAlreadyUsed(projectId: string, beforeIdx: number): string[] {
  const cycles = storage.listCycles(projectId)
    .filter((cycle) => cycle.idx < beforeIdx)
    .map((cycle) => cycle.goal)
    .filter((goal) => goal.trim().length > 0);
  const gateGoals = storage.listGates(projectId)
    .filter((gate) => {
      const cycle = storage.getCycle(gate.cycleId);
      return !cycle || cycle.idx < beforeIdx;
    })
    .flatMap((gate) => {
      try {
        const payload = JSON.parse(gate.payload) as Record<string, unknown>;
        const alternatives = Array.isArray(payload.alternatives)
          ? payload.alternatives.filter((item): item is string => typeof item === "string")
          : [];
        const recommended = typeof payload.recommended === "string" ? [payload.recommended] : [];
        return [...recommended, ...alternatives];
      } catch {
        return [];
      }
    });
  return Array.from(new Set([...cycles, ...gateGoals]));
}

export function buildNextGoalInput(projectId: string, cycleIndex: number, cycleId: string): NextGoalInput {
  const project = storage.getProject(projectId);
  const previous = lastClosedCycle(projectId, cycleIndex);
  const previousFeedback = previous ? storage.listFeedback(previous.id).map((item) => item.summary || item.text) : [];
  const eligibleKnowledge = storage.listKnowledge(projectId)
    .filter((item) => !item.supersededBy)
    .filter((item) => ["active", "strong"].includes(item.status))
    .filter((item) => eligibleForHighRisk(coreFromDb(item)))
    .map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      type: item.type,
      confidenceScore: item.confidenceScore,
      status: item.status,
    }));

  return {
    cycleId,
    cycleIndex,
    identity: project?.seedIdentity || project?.direction || "Alaya autonomous project",
    worldModel: project?.worldModel || "",
    eligibleKnowledge,
    lastCyclePredictionError: {
      eCycle: previous?.eCycle ?? null,
      worstClaimError: previous?.worstClaimError ?? null,
    },
    recentFeedback: previousFeedback.slice(-8),
    rejectedGoals: goalsAlreadyUsed(projectId, cycleIndex),
  };
}

function scenarioFromGoalDraft(index: number, draft: NextGoalDraft): ScenarioRound {
  const target = draft.prediction.target;
  const observed = Math.min(0.95, +(target + 0.015 + (index % 3) * 0.005).toFixed(3));
  return {
    index,
    proposedGoal: draft.proposedGoal,
    alternativeGoals: draft.alternativeGoals,
    belief: draft.belief,
    prediction: draft.prediction.statement,
    action: draft.action,
    activationObserved: observed,
    activationTarget: target,
    feedback: [
      {
        id: `auto_f${index}`,
        text: `第${index}轮用户反馈: ${draft.proposedGoal} 让高风险动作更可预览、可回滚、可审计。`,
        category: "metric_signal",
        sentiment: "positive",
      },
    ],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
    predictionMetric: draft.prediction.metric,
    predictionOperator: draft.prediction.operator,
    predictionTarget: target,
    knowledgeRefs: draft.referencedKnowledgeIds,
    reasoningHowKnowledgeChangedDecision: draft.reasoningHowKnowledgeChangedDecision,
  };
}

export async function resolveCycleStimulus(projectId: string, index: number, cycleId = `cycle_${index}_${projectId.slice(-4)}`): Promise<ScenarioRound> {
  const scripted = scenarioForCycle(index);
  if (scripted) return scripted;
  const draft = await generateNextGoal(buildNextGoalInput(projectId, index, cycleId));
  return scenarioFromGoalDraft(index, draft);
}

type PersistedDirectionScenario = {
  index: number;
  proposedGoal: string;
  alternativeGoals: string[];
  belief: string;
  prediction: string;
  action: string;
  activationObserved: number;
  activationTarget: number;
  feedback: { id: string; text: string; category: string; sentiment: string }[];
  buildSuccess: boolean;
  perceptionOk: boolean;
  humanValueMismatch: boolean;
  predictionMetric?: string;
  predictionOperator?: Operator;
  predictionTarget?: number;
  knowledgeRefs?: string[];
  reasoningHowKnowledgeChangedDecision?: string;
};

function persistDirectionScenario(sc: ScenarioRound, finalRefs: string[]): PersistedDirectionScenario {
  return {
    index: sc.index,
    proposedGoal: sc.proposedGoal,
    alternativeGoals: sc.alternativeGoals,
    belief: sc.belief,
    prediction: sc.prediction,
    action: sc.action,
    activationObserved: sc.activationObserved,
    activationTarget: sc.activationTarget,
    feedback: sc.feedback,
    buildSuccess: sc.buildSuccess,
    perceptionOk: sc.perceptionOk,
    humanValueMismatch: sc.humanValueMismatch,
    predictionMetric: sc.predictionMetric,
    predictionOperator: sc.predictionOperator,
    predictionTarget: sc.predictionTarget,
    knowledgeRefs: finalRefs,
    reasoningHowKnowledgeChangedDecision: sc.reasoningHowKnowledgeChangedDecision,
  };
}

function toDirectionScenario(candidate: unknown): ScenarioRound | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const raw = candidate as Record<string, unknown>;
  const idx = typeof raw.index === "number" ? raw.index : Number.NaN;
  const proposedGoal = typeof raw.proposedGoal === "string" ? raw.proposedGoal : "";
  if (!Number.isFinite(idx) || idx <= 0 || !proposedGoal) return undefined;
  if (!Array.isArray(raw.feedback)) return undefined;
  const feedback = raw.feedback.filter((item): item is { id: string; text: string; category: string; sentiment: string } => {
    return (
      item !== null && typeof item === "object" &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).text === "string" &&
      typeof (item as Record<string, unknown>).category === "string" &&
      typeof (item as Record<string, unknown>).sentiment === "string"
    );
  });
  const alternativeGoals = Array.isArray(raw.alternativeGoals) ? raw.alternativeGoals.filter((item): item is string => typeof item === "string") : [];
  const resolveRefs = Array.isArray(raw.knowledgeRefs)
    ? raw.knowledgeRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    index: idx,
    proposedGoal,
    alternativeGoals,
    belief: typeof raw.belief === "string" ? raw.belief : "",
    prediction: typeof raw.prediction === "string" ? raw.prediction : "",
    action: typeof raw.action === "string" ? raw.action : "",
    activationObserved: typeof raw.activationObserved === "number" ? raw.activationObserved : 0,
    activationTarget: typeof raw.activationTarget === "number" ? raw.activationTarget : 0,
    feedback,
    buildSuccess: raw.buildSuccess === true,
    perceptionOk: raw.perceptionOk !== false,
    humanValueMismatch: raw.humanValueMismatch === true,
    predictionMetric: typeof raw.predictionMetric === "string" ? raw.predictionMetric : undefined,
    predictionOperator: raw.predictionOperator === "<=" || raw.predictionOperator === ">="
      ? raw.predictionOperator
      : undefined,
    predictionTarget: typeof raw.predictionTarget === "number" ? raw.predictionTarget : undefined,
    knowledgeRefs: resolveRefs,
    reasoningHowKnowledgeChangedDecision: typeof raw.reasoningHowKnowledgeChangedDecision === "string" ? raw.reasoningHowKnowledgeChangedDecision : undefined,
  };
}

function directionScenarioFromGate(cycleId: string): ScenarioRound | undefined {
  const gate = storage.listGates().find((item) => item.cycleId === cycleId && item.type === "direction");
  if (!gate) return undefined;
  try {
    const parsed = JSON.parse(gate.payload) as {
      scenario?: unknown;
      recommended?: string;
      belief?: string;
      prediction?: string;
      action?: string;
      alternatives?: string[];
      knowledgeRefs?: string[];
    };
    const fromStored = toDirectionScenario(parsed.scenario);
    if (fromStored) return fromStored;
    const fallback: ScenarioRound = {
      index: storage.getCycle(cycleId)?.idx ?? 1,
      proposedGoal: typeof parsed.recommended === "string" ? parsed.recommended : "",
      alternativeGoals: Array.isArray(parsed.alternatives)
        ? parsed.alternatives.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
      belief: typeof parsed.belief === "string" ? parsed.belief : "",
      prediction: typeof parsed.prediction === "string" ? parsed.prediction : "",
      action: typeof parsed.action === "string" ? parsed.action : "",
      activationObserved: 0,
      activationTarget: 0,
      feedback: [],
      buildSuccess: true,
      perceptionOk: true,
      humanValueMismatch: false,
      knowledgeRefs: Array.isArray(parsed.knowledgeRefs) ? parsed.knowledgeRefs.filter((item): item is string => typeof item === "string") : [],
    };
    return fallback.proposedGoal ? fallback : undefined;
  } catch {
    return undefined;
  }
}

export function buildDirectionScenarioFallback(sc: ScenarioRound, refs: string[], finalSc: {
  goal: string;
  belief: string;
  prediction: string;
  action: string;
  reasoning: string;
}): ScenarioRound {
  return {
    ...sc,
    proposedGoal: finalSc.goal,
    belief: finalSc.belief,
    prediction: finalSc.prediction,
    action: finalSc.action,
    knowledgeRefs: refs,
    reasoningHowKnowledgeChangedDecision: finalSc.reasoning,
  };
}

// ---------------- Agents ----------------
export async function runOrchestrator(projectId: string, cycleId: string, sc: ScenarioRound, llmCaller: LlmCaller = callLlm) {
  const gateId = sc.index === 4 ? `gate_dir_c4_rollback_${cycleId.slice(-8)}` : `gate_dir_c${sc.index}_${cycleId.slice(-8)}`;
  const existingGate = storage.getGate(gateId);
  if (existingGate) return planFromExistingDirectionGate(existingGate, sc);

  let goal = sc.proposedGoal, belief = sc.belief, prediction = sc.prediction, action = sc.action;
  const refs: string[] = [];
  let reasoning = "";
  const project = storage.getProject(projectId);
  const firstCyclePlan = projectSpecificFirstCyclePlan(projectId, cycleId, sc);

  if (firstCyclePlan) {
    ({ goal, belief, prediction, action, reasoning } = firstCyclePlan);
  } else if (sc.index > SCENARIO.length) {
    refs.push(...(sc.knowledgeRefs ?? []));
    reasoning = sc.reasoningHowKnowledgeChangedDecision ??
      `引用 ${refs.join("+")}: 自主目标生成器基于可用知识生成第 ${sc.index} 轮目标。`;
  } else if (sc.index === 3) {
    const usable = activeKnowledge(projectId);
    const previewKnowledge = usable.find((k) => parseTags(k).includes("preview"));
    const fearKnowledge = usable.find((k) => parseTags(k).includes("user_fear"));
    if (previewKnowledge) refs.push(previewKnowledge.id);
    if (fearKnowledge) refs.push(fearKnowledge.id);
    goal = "为删除操作也加 dry-run 预览,把可预览模式推广到其他高风险动作";
    belief = "可预览/可逆能降低高风险动作门槛(沿用前两轮验证过的知识)";
    prediction = "为删除加预览后,activation 进一步升到 30% 以上且无新增恐惧反馈";
    action = "把发布预览模式复用到删除流程";
    reasoning =
      `引用 ${refs.join("+")}: 前两轮证明"用户对不可预期自动操作有恐惧(K1)"且` +
      `"可预览显著降低门槛(K2)",因此本轮不再新增不可预览的自动化,` +
      `而是把已验证的预览模式迁移到删除操作。这改变了候选目标的选择。`;
  } else if (sc.index === 4) {
    const usable = activeKnowledge(projectId);
    const previewKnowledge = usable.find((k) => parseTags(k).includes("preview"));
    const fearKnowledge = usable.find((k) => parseTags(k).includes("user_fear"));
    const auditKnowledge = usable.find((k) => parseTags(k).includes("auditability"));
    if (previewKnowledge) refs.push(previewKnowledge.id);
    if (fearKnowledge) refs.push(fearKnowledge.id);
    if (auditKnowledge) refs.push(auditKnowledge.id);
    goal = "把 dry-run 预览升级为可回滚变更包,并为每次高风险动作生成审计摘要";
    belief = "高风险自动化要继续扩大适用范围,必须同时满足可预览、可回滚、可追溯";
    prediction = "加入回滚与审计摘要后,activation 达到 45% 以上且正向复盘反馈增加";
    action = "开发变更包回滚入口 + 自动审计摘要";
    reasoning =
      `引用 ${refs.join("+") || "前轮高风险动作知识"}: 第2-3轮证明预览能降低恐惧,` +
      `第4轮不再只扩展动作种类,而是补齐回滚与审计,把用户信任从"敢点一次"` +
      `提升到"愿意交给系统持续处理"。`;
  } else {
    reasoning = `第 ${sc.index} 轮:基于 onboarding seed 与上轮误差生成目标`;
  }

  const usableKnowledge = activeKnowledge(projectId);
  const priorKnowledge = buildKnowledgeContext(
    scenarioKnowledgeQuery(sc, `${goal}\n${belief}\n${prediction}\n${action}`),
    projectId,
    { cycleIdx: sc.index, cycleId, agent: "orchestrator" },
  );
  const llmData = await llmCaller({
    cycleId,
    agent: "orchestrator",
    promptName: "plan_cycle",
    inputSummary: `cycle ${sc.index} plan`,
    context: {
      project: project ? {
        name: project.name,
        direction: project.direction,
        targetUser: project.targetUser,
        redlines: project.redlines,
        seedIdentity: project.seedIdentity,
        worldModel: project.worldModel,
      } : null,
      cycleIndex: sc.index,
      proposedGoal: sc.proposedGoal,
      alternativeGoals: sc.alternativeGoals,
      fallbackPlan: { goal, belief, prediction, action, reasoning, knowledgeRefs: refs },
      activeKnowledge: usableKnowledge.map((k) => ({
        id: k.id,
        title: k.title,
        type: k.type,
        status: k.status,
        tags: parseTags(k),
        confidenceScore: k.confidenceScore,
      })),
    },
    knowledgeSummary: priorKnowledge,
    prohibited: [
      "Do not approve or reject the direction gate; human gate decides that.",
      "Do not promote knowledge to strong; pure transition rules decide that.",
      "Do not propose irreversible high-risk execution without preview, rollback, and audit constraints.",
      "Do not repeat a previously rejected alternative direction.",
    ],
    schema: PLAN_SCHEMA,
    mockOutput: { summary: `goal: ${goal}`, goal, belief, prediction, action, reasoning, knowledgeRefs: refs },
  });

  goal = nonEmptyString(llmData.goal, goal);
  belief = nonEmptyString(llmData.belief, belief);
  prediction = nonEmptyString(llmData.prediction, prediction);
  action = nonEmptyString(llmData.action, action);
  reasoning = nonEmptyString(llmData.reasoning, reasoning);
  refs.splice(0, refs.length, ...safeKnowledgeRefs(projectId, llmData.knowledgeRefs, refs));

  const rollbackPlan = rollbackReadyChangePackage(sc, action);
  const auditSummary = sc.index === 4 ? auditSummaryForCycle4(refs) : undefined;
  const gateTitle = sc.index === 4 ? "第 4 轮可回滚执行闸: 变更包 + 审计摘要" : `第 ${sc.index} 轮方向闸`;
  const persistedScenario = persistDirectionScenario({
    index: sc.index,
    proposedGoal: goal,
    alternativeGoals: sc.alternativeGoals,
    belief,
    prediction,
    action,
    activationObserved: sc.activationObserved,
    activationTarget: sc.activationTarget,
    feedback: sc.feedback,
    buildSuccess: sc.buildSuccess,
    perceptionOk: sc.perceptionOk,
    humanValueMismatch: sc.humanValueMismatch,
    predictionMetric: sc.predictionMetric,
    predictionOperator: sc.predictionOperator,
    predictionTarget: sc.predictionTarget,
    reasoningHowKnowledgeChangedDecision: reasoning,
    knowledgeRefs: refs,
  }, refs);

  const gatePayload = JSON.stringify({
    recommended: goal,
    alternatives: sc.alternativeGoals,
    knowledgeRefs: refs,
    reasoning,
    belief,
    prediction,
    action,
    ...(rollbackPlan ? { rollbackPlan, rollbackTrigger: rollbackPlan.rollbackTrigger } : {}),
    ...(auditSummary ? { auditSummary } : {}),
    scenario: persistedScenario,
    createdAt: now(),
  });

  // direction gate (PRD 11.1). Scheduler ticks can overlap with a manual UI
  // tick; the gate identity is deterministic, so reusing it keeps the stage
  // idempotent instead of wedging the cycle on a UNIQUE constraint.
  let gate = storage.getGate(gateId);
  let gateCreated = false;
  if (!gate) {
    try {
      gate = storage.createGate({
        id: gateId,
        cycleId, type: "direction", blocking: 1,
        title: gateTitle,
        payload: gatePayload,
        status: "pending", estimatedMinutes: 10, decision: null, version: 1,
      });
      gateCreated = true;
    } catch (error) {
      const existing = storage.getGate(gateId);
      if (!existing) throw error;
      gate = existing;
    }
  }

  if (gateCreated) {
    logEvent(sc.index, "orchestrator", "human_gate_items", "insert", { gateId: gate.id });
    storage.recordAgentRun({
      cycleId, cycleIdx: sc.index, agent: "orchestrator",
      action: "plan_cycle + open_direction_gate",
      outputSummary: `目标: ${goal}${refs.length ? ` | 引用知识: ${refs.join(",")}` : ""}`,
      knowledgeRefsUsed: JSON.stringify(refs), ts: now(),
    });
    traceAgentRun(projectId, cycleId, sc.index, "orchestrator", "plan_cycle + open_direction_gate", refs);
  }

  if (!gateCreated) return planFromExistingDirectionGate(gate, sc);

  storage.updateCycle(cycleId, { goal, reasoning, status: "running" });
  logEvent(sc.index, "orchestrator", "cycles", "update", { cycleId, goal });

  return { goal, belief, prediction, action, refs, reasoning, gate };
}

export function humanResolveDirectionGate(projectId: string, cycleId: string, gateId: string, sc: ScenarioRound) {
  storage.updateGate(gateId, { status: "approved", decision: "approve_recommended" });
  storage.createDecision({
    id: `dec_dir_c${sc.index}_${cycleId.slice(-8)}`, cycleId, gateType: "direction",
    decision: "approve_recommended",
    rationale: sc.index === 4
      ? "批准第4轮可回滚变更包: 方向来自前轮 preview/user_fear 知识,新增 rollbackPlan 与 auditSummary 作为执行约束。"
      : "推荐目标与已验证知识一致",
    ts: now(),
  });
  logEvent(sc.index, "human", "decision_log", "insert", { gateId, decision: "approve_recommended" });
  recordTrace({
    projectId,
    cycleId,
    cycleIdx: sc.index,
    kind: "approval",
    name: "direction_gate_approved",
    agent: "human",
    attributes: { gateId, decision: "approve_recommended" },
  });
}

function readDirectionPlan(cycleId: string, sc: ScenarioRound) {
  const gate = storage.listGates().find((g) => g.cycleId === cycleId && g.type === "direction");
  if (!gate) {
    return {
      belief: sc.belief,
      prediction: sc.prediction,
      action: sc.action,
      refs: [] as string[],
    };
  }
  try {
    const payload = JSON.parse(gate.payload) as {
      belief?: string;
      prediction?: string;
      action?: string;
      knowledgeRefs?: string[];
      scenario?: unknown;
    };
    const persisted = payload.scenario ? toDirectionScenario(payload.scenario) : undefined;
    if (persisted) {
      return {
        belief: persisted.belief || sc.belief,
        prediction: persisted.prediction || sc.prediction,
        action: persisted.action || sc.action,
        refs: persisted.knowledgeRefs ?? [],
      };
    }
    return {
      belief: payload.belief ?? sc.belief,
      prediction: payload.prediction ?? sc.prediction,
      action: payload.action ?? sc.action,
      refs: Array.isArray(payload.knowledgeRefs) ? payload.knowledgeRefs : [],
    };
  } catch {
    return {
      belief: sc.belief,
      prediction: sc.prediction,
      action: sc.action,
      refs: [] as string[],
    };
  }
}

export async function runSensor(projectId: string, cycleId: string, sc: ScenarioRound) {
  const bugs = sc.feedback.filter((f) => f.category === "bug");
  const unclear = sc.feedback.filter((f) => f.category === "unclear_signal");
  await callLlm({
    cycleId,
    agent: "sensor",
    promptName: "cluster_feedback",
    inputSummary: `${sc.feedback.length} feedback items`,
    context: { feedback: sc.feedback },
    knowledgeSummary: buildKnowledgeContext(
      scenarioKnowledgeQuery(sc, "cluster feedback and preserve user quotes"),
      projectId,
      { cycleIdx: sc.index, cycleId, agent: "sensor" },
    ),
    schema: SUMMARY_ARRAY_SCHEMA,
    mockOutput: {
      summary: "clustered + preserved quotes",
      items: unclear.map((f) => ({ id: f.id, category: f.category })),
    },
  });

  for (const f of sc.feedback) {
    const feedbackId = `${f.id}_${cycleId}`;
    if (storage.getFeedback(feedbackId)) continue;
    storage.createFeedback({
      id: feedbackId,
      cycleId,
      text: f.text,
      category: f.category,
      sentiment: f.sentiment,
      sourceType: "scenario",
      sourceRef: f.id,
      sourceUrl: "",
      topicKey: f.text.slice(0, 18),
      summary: f.text.slice(0, 80),
      externalUpdatedAt: "",
    });
  }
  // unclear -> meaning gate (merged by topic; single topic here)
  for (const u of unclear) {
    const gateId = `gate_meaning_${sc.index}_${cycleId.slice(-8)}_${u.id}`;
    if (storage.getGate(gateId)) continue;
    const gate = storage.createGate({
      id: gateId,
      cycleId, type: "meaning", blocking: 0,
      title: `模糊反馈意义闸: ${u.text.slice(0, 12)}...`,
      payload: JSON.stringify({ userQuote: u.text, mergedCount: 1, topicKey: u.text.slice(0, 18), createdAt: now() }),
      status: "pending", estimatedMinutes: 8, decision: null, version: 1,
    });
    logEvent(sc.index, "sensor", "human_gate_items", "insert", { gateId: gate.id });
  }

  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "sensor", action: "import_and_cluster_feedback",
    outputSummary: `反馈 ${sc.feedback.length} 条 (bug ${bugs.length}, 模糊 ${unclear.length}),保留原话`,
    knowledgeRefsUsed: "[]", ts: now(),
  });
  traceAgentRun(projectId, cycleId, sc.index, "sensor", "import_and_cluster_feedback", []);
  return { unclear };
}

export async function runBuilder(cycleId: string, sc: ScenarioRound, plannedAction = sc.action, refs: string[] = [], llmCaller: LlmCaller = callLlm) {
  const taskId = `task_build_c${sc.index}_${cycleId.slice(-8)}`;
  const existingTask = storage.listTasks(cycleId).find((task) => task.id === taskId);
  if (existingTask) return { buildSuccess: existingTask.status === "done" };

  const rollbackPlan = rollbackReadyChangePackage(sc, plannedAction);
  const auditSummary = sc.index === 4 ? auditSummaryForCycle4(refs) : undefined;
  const projectId = storage.getCycle(cycleId)?.projectId;

  const llmData = await llmCaller({
    cycleId,
    agent: "builder",
    promptName: "emit_task_spec",
    inputSummary: plannedAction,
    context: { action: plannedAction, rollbackPlan, auditSummary },
    knowledgeSummary: projectId ? buildKnowledgeContext(
      `${scenarioKnowledgeQuery(sc)}\n${plannedAction}`,
      projectId,
      { cycleIdx: sc.index, cycleId, agent: "builder" },
    ) : "",
    prohibited: [
      "Do not claim tests passed unless the tool-reported build result says so.",
      "Do not remove rollback or audit fields from a high-risk cycle 4 task.",
      "Do not execute external irreversible actions.",
    ],
    schema: BUILD_SCHEMA,
    mockOutput: {
      summary: sc.buildSuccess ? "all tests pass (mock)" : "build failed (mock)",
      buildSuccess: sc.buildSuccess,
      diffSummary: `mock diff for: ${plannedAction}`,
      testReport: sc.buildSuccess ? "all tests pass (mock)" : "build failed (mock)",
    },
  });
  const diffSummary = nonEmptyString(llmData.diffSummary, `mock diff for: ${plannedAction}`);
  const testReport = nonEmptyString(llmData.testReport, sc.buildSuccess ? "all tests pass (mock)" : "build failed (mock)");
  const taskSpec = {
    action: plannedAction,
    diffSummary,
    testReport,
    toolReportedBuildSuccess: sc.buildSuccess,
    llmReportedBuildSuccess: typeof llmData.buildSuccess === "boolean" ? llmData.buildSuccess : null,
    ...(rollbackPlan ? {
      rollbackReadyChangePackage: rollbackPlan,
      rollbackPlan,
      rollbackTrigger: rollbackPlan.rollbackTrigger,
    } : {}),
    ...(auditSummary ? { auditSummary } : {}),
  };
  const actionLedger = projectId ? recordActionProposal({
    projectId,
    cycleId,
    actionType: "builder.emit_task_spec",
    target: plannedAction,
    payload: taskSpec,
    rollbackPlan,
    auditSummary,
  }) : null;
  const task = storage.createTask({
    id: taskId, cycleId, agent: "builder", kind: "build",
    status: sc.buildSuccess ? "done" : "failed",
    spec: JSON.stringify({ ...taskSpec, actionLedgerId: actionLedger?.id ?? null }),
  });
  logEvent(sc.index, "builder", "tasks", "insert", { taskId: task.id, success: sc.buildSuccess });
  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "builder", action: "emit_task_spec + receive_mock_build_report",
    outputSummary: `build=${sc.buildSuccess ? "成功" : "失败"} | ${diffSummary}`,
    knowledgeRefsUsed: "[]", ts: now(),
  });
  if (projectId) traceAgentRun(projectId, cycleId, sc.index, "builder", "emit_task_spec + receive_mock_build_report", []);
  return { buildSuccess: sc.buildSuccess };
}

export function evaluatePrediction(
  projectId: string, cycleId: string, sc: ScenarioRound,
  plan: { belief: string; prediction: string; action: string; refs: string[] },
) {
  const config = claimConfigForCycle(projectId, sc);
  const claim: Claim = {
    id: `claim_c${sc.index}_${config.metric.replace(/[^a-zA-Z0-9_]+/g, "_")}`,
    type: "metric_threshold",
    metric: config.metric,
    operator: config.operator,
    target: config.target,
    observed: config.observed,
    scale: config.scale,
    weight: 3,
    expectedObservation: `${config.metric} ${config.operator} ${config.target}`,
    timeWindow: `cycle_${sc.index}_feedback_window`,
    successThreshold: `${config.metric} ${config.operator} ${config.target}`,
    failureThreshold: failureThreshold(config.metric, config.operator, config.target),
    uncertainty: sc.index === 1 ? 0.42 : sc.index === 4 ? 0.28 : 0.32,
  };
  claim.error = computeClaimError(claim);
  const cycleErr = computeCycleError([claim]);
  const predId = sc.index === 4 ? `pred_c4_rollback_${cycleId.slice(-8)}` : `pred_c${sc.index}_${cycleId.slice(-8)}`;
  const existingPred = storage.getPrediction(predId);
  if (existingPred) {
    storage.updateCycle(cycleId, {
      eCycle: existingPred.predictionError ?? cycleErr.eCycle,
      worstClaimError: existingPred.worstClaimError ?? cycleErr.worstClaimError,
    });
    return { pred: existingPred, claimError: claim.error ?? 0 };
  }

  const errorType = classifyError(claim.error, {
    perceptionFailure: !sc.perceptionOk,
    executionFailure: !sc.buildSuccess,
    humanFlaggedValueMismatch: sc.humanValueMismatch,
    isQualitative: false,
  } as AttributionContext);
  recordTrace({
    projectId,
    cycleId,
    cycleIdx: sc.index,
    kind: "error_classification",
    name: "classify_prediction_error",
    agent: "orchestrator",
    attributes: {
      claimId: claim.id,
      claimError: claim.error,
      cycleError: cycleErr.eCycle,
      worstClaimError: cycleErr.worstClaimError,
      errorType,
      updateTarget: routeError(errorType),
    },
  });

  const pred = storage.createPrediction({
    id: predId,
    cycleId,
    belief: plan.belief, prediction: plan.prediction, action: plan.action,
    claims: JSON.stringify([claim]),
    observation: `${config.metric} = ${config.observed}`,
    predictionError: cycleErr.eCycle, worstClaimError: cycleErr.worstClaimError,
    errorType: errorType, updateTarget: routeError(errorType), status: "resolved",
    knowledgeRefs: JSON.stringify(plan.refs),
  });
  const observationId = `obs_c${sc.index}_${cycleId.slice(-8)}`;
  if (!storage.listObservations(cycleId).some((observation) => observation.id === observationId)) {
    storage.createObservation({
      id: observationId, cycleId, predictionId: pred.id,
      metric: config.metric, value: config.observed, source: "mock_analytics",
    });
  }
  storage.updateCycle(cycleId, { eCycle: cycleErr.eCycle, worstClaimError: cycleErr.worstClaimError });
  logEvent(sc.index, "orchestrator", "predictions", "insert", { predId: pred.id, eCycle: cycleErr.eCycle });
  return { pred, claimError: claim.error ?? 0 };
}

export async function runDistiller(projectId: string, cycleId: string, sc: ScenarioRound, claimError: number, refs: string[], llmCaller: LlmCaller = callLlm) {
  const llmData = await llmCaller({
    cycleId,
    agent: "distiller",
    promptName: "distill_knowledge",
    inputSummary: `cycle ${sc.index} error=${claimError.toFixed(2)}`,
    context: { feedback: sc.feedback, claimError, refs },
    knowledgeSummary: buildKnowledgeContext(
      scenarioKnowledgeQuery(sc, `claim_error=${claimError.toFixed(3)} refs=${refs.join(",")}`),
      projectId,
      { cycleIdx: sc.index, cycleId, agent: "distiller" },
    ),
    schema: SUMMARY_ARRAY_SCHEMA,
    mockOutput: distillerDraftOutput(sc, claimError),
  });
  const candidate = knowledgeCandidate(llmData, sc.index);
  const created: string[] = [];

  if (sc.index === 1) {
    const base: KnowledgeItem = {
      id: nextKbId(projectId), projectId, type: "world_model",
      title: nonEmptyString(candidate.title, "用户对不可预期的自动操作有恐惧"),
      content: nonEmptyString(candidate.content, "早期用户不敢用一键发布,因为不知道会改动什么。恐惧而非能力是采用门槛。"),
      sourceType: "feedback", sourceRef: nonEmptyString(candidate.sourceRef, "f1,f2"),
      evidenceAlpha: 1, evidenceBeta: 1, confidenceScore: 0.5, confidenceLevel: "low",
      status: "draft", humanApprovedCount: 0, externalVerifiedCount: 0,
      validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: 1, createdByCycle: 1,
      createdBy: "distiller", approvedBy: null, usageCount: 0,
      tags: JSON.stringify(mergeTags(["user_fear", "adoption"], candidate.tags)),
      notes: nonEmptyString(candidate.notes, "由第1轮预测失败 + 两条负面反馈提炼"), version: 1,
    };
    const next = applyEvidenceDb(base, { kind: "prediction", normalizedError: claimError });
    const saved = storage.createKnowledge({ ...base, evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta, confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel });
    created.push(saved.id);
    logEvent(1, "distiller", "knowledge_items", "insert", { id: saved.id });
  }

  if (sc.index === 2) {
    const k1 = storage.listKnowledge(projectId).find((k) => parseTags(k).includes("user_fear"));
    if (k1) {
      let next = applyEvidenceDb(k1, { kind: "prediction", normalizedError: claimError });
      next = applyEvidence(coreFromDb({ ...k1, ...next } as any), { kind: "external_verify" }).next as any;
      storage.updateKnowledge(k1.id, {
        evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta,
        confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel,
        externalVerifiedCount: next.externalVerifiedCount, lastValidatedCycle: 2,
      });
      logEvent(2, "distiller", "knowledge_items", "update", { id: k1.id, score: next.confidenceScore });
    }
    const base: KnowledgeItem = {
      id: nextKbId(projectId), projectId, type: "principle",
      title: nonEmptyString(candidate.title, "可预览/可逆显著降低高风险动作使用门槛"),
      content: nonEmptyString(candidate.content, "为发布加 dry-run 预览后 activation 达标。预览把不可逆恐惧转为可控。"),
      sourceType: "metric", sourceRef: nonEmptyString(candidate.sourceRef, "claim_2,f3,f4"),
      evidenceAlpha: 1, evidenceBeta: 1, confidenceScore: 0.5, confidenceLevel: "low",
      status: "draft", humanApprovedCount: 0, externalVerifiedCount: 0,
      validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: 2, createdByCycle: 2,
      createdBy: "distiller", approvedBy: null, usageCount: 0,
      tags: JSON.stringify(mergeTags(["preview", "principle", "high_risk"], candidate.tags)),
      notes: nonEmptyString(candidate.notes, "由第2轮预测成功 + 正面反馈提炼"), version: 1,
    };
    const next = applyEvidenceDb(base, { kind: "prediction", normalizedError: claimError });
    const saved = storage.createKnowledge({ ...base, evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta, confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel });
    created.push(saved.id);
    logEvent(2, "distiller", "knowledge_items", "insert", { id: saved.id });
  }

  if (sc.index === 3) {
    for (const k of activeKnowledge(projectId)) {
      const tags = parseTags(k);
      if (tags.includes("preview") || tags.includes("user_fear")) {
        // accumulate enough evidence so score>=0.85 & evidenceCount>=5 to enable strong
        let next = applyEvidenceDb(k, { kind: "prediction", normalizedError: claimError });
        next = applyEvidence(coreFromDb({ ...k, ...next } as any), { kind: "human_approve" }).next as any;
        next = applyEvidence(coreFromDb({ ...k, ...next } as any), { kind: "external_verify" }).next as any;
        storage.updateKnowledge(k.id, {
          evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta,
          confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel,
          humanApprovedCount: next.humanApprovedCount, externalVerifiedCount: next.externalVerifiedCount,
          approvedBy: "owner", lastValidatedCycle: 3, usageCount: k.usageCount + 1,
        });
        logEvent(3, "distiller", "knowledge_items", "update", { id: k.id, score: next.confidenceScore });
      }
    }
  }

  if (sc.index === 4) {
    for (const k of activeKnowledge(projectId)) {
      const tags = parseTags(k);
      if (tags.includes("preview") || tags.includes("user_fear")) {
        let next = applyEvidenceDb(k, { kind: "prediction", normalizedError: claimError });
        next = applyEvidence(coreFromDb({ ...k, ...next } as any), { kind: "external_verify" }).next as any;
        storage.updateKnowledge(k.id, {
          evidenceAlpha: next.evidenceAlpha,
          evidenceBeta: next.evidenceBeta,
          confidenceScore: next.confidenceScore,
          confidenceLevel: next.confidenceLevel,
          externalVerifiedCount: next.externalVerifiedCount,
          lastValidatedCycle: 4,
          usageCount: k.usageCount + 1,
        });
        logEvent(4, "distiller", "knowledge_items", "update", { id: k.id, score: next.confidenceScore });
      }
    }

    const base: KnowledgeItem = {
      id: nextKbId(projectId), projectId, type: "principle",
      title: nonEmptyString(candidate.title, "高风险动作进入执行前必须具备可回滚路径与审计摘要"),
      content: nonEmptyString(candidate.content, "第4轮把第3轮的 dry-run 预览升级为 rollback-ready change package: 高风险动作在进入执行前必须声明拟修改对象、回滚触发条件、回滚步骤、风险级别,并生成 audit summary 供 owner 复盘。"),
      sourceType: "metric", sourceRef: nonEmptyString(candidate.sourceRef, "claim_c4_activation,f6,f7"),
      evidenceAlpha: 1, evidenceBeta: 1, confidenceScore: 0.5, confidenceLevel: "low",
      status: "draft", humanApprovedCount: 0, externalVerifiedCount: 0,
      validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: 4, createdByCycle: 4,
      createdBy: "distiller", approvedBy: null, usageCount: 0,
      tags: JSON.stringify(mergeTags(["rollback", "auditability", "principle", "high_risk"], candidate.tags)),
      notes: nonEmptyString(candidate.notes, "由第4轮预测成功 + 正向复盘反馈提炼"), version: 1,
    };
    let next = applyEvidenceDb(base, { kind: "prediction", normalizedError: claimError });
    next = applyEvidence(coreFromDb({ ...base, ...next } as any), { kind: "external_verify" }).next as any;
    const saved = storage.createKnowledge({
      ...base,
      evidenceAlpha: next.evidenceAlpha,
      evidenceBeta: next.evidenceBeta,
      confidenceScore: next.confidenceScore,
      confidenceLevel: next.confidenceLevel,
      externalVerifiedCount: next.externalVerifiedCount,
    });
    created.push(saved.id);
    logEvent(4, "distiller", "knowledge_items", "insert", { id: saved.id });
  }

  if (sc.index > SCENARIO.length) {
    const referenced = activeKnowledge(projectId).filter((k) => refs.includes(k.id));
    for (const k of referenced) {
      const next = applyEvidenceDb(k, { kind: "prediction", normalizedError: claimError });
      storage.updateKnowledge(k.id, {
        evidenceAlpha: next.evidenceAlpha,
        evidenceBeta: next.evidenceBeta,
        confidenceScore: next.confidenceScore,
        confidenceLevel: next.confidenceLevel,
        lastValidatedCycle: sc.index,
        usageCount: k.usageCount + 1,
        semanticKey: k.semanticKey || computeSemanticKey(k.title, k.content),
      });
      logEvent(sc.index, "distiller", "knowledge_items", "update", { id: k.id, score: next.confidenceScore });
    }

    const anchor = referenced[0] ?? activeKnowledge(projectId).find((k) => k.status === "strong") ?? activeKnowledge(projectId)[0];
    if (anchor) {
      const base: KnowledgeItem = {
        id: nextKbId(projectId), projectId, type: anchor.type,
        title: anchor.title,
        content: `${anchor.content}\n本轮应用场景: ${sc.proposedGoal}`,
        sourceType: "agent_observation",
        sourceRef: `cycle_${sc.index}`,
        evidenceAlpha: 1, evidenceBeta: 1, confidenceScore: 0.5, confidenceLevel: "low",
        status: "draft", humanApprovedCount: 0, externalVerifiedCount: 0,
        validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: sc.index,
        createdByCycle: sc.index, createdBy: "distiller", approvedBy: null, usageCount: 0,
        tags: JSON.stringify(parseTags(anchor)),
        notes: `自主第${sc.index}轮把 ${anchor.id} 迁移到新场景,等待 Librarian 合并/去重。`,
        semanticKey: anchor.semanticKey || computeSemanticKey(anchor.title, anchor.content),
        supersededBy: null,
        version: 1,
      };
      const next = applyEvidenceDb(base, { kind: "prediction", normalizedError: claimError });
      const saved = storage.createKnowledge({
        ...base,
        evidenceAlpha: next.evidenceAlpha,
        evidenceBeta: next.evidenceBeta,
        confidenceScore: next.confidenceScore,
        confidenceLevel: next.confidenceLevel,
      });
      created.push(saved.id);
      logEvent(sc.index, "distiller", "knowledge_items", "insert", { id: saved.id, candidateForMergeWith: anchor.id });
    }
  }

  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "distiller", action: "distill_knowledge_candidates",
    outputSummary: created.length ? `生成知识候选: ${created.join(",")}` : "强化既有知识证据",
    knowledgeRefsUsed: JSON.stringify(refs), ts: now(),
  });
  traceAgentRun(projectId, cycleId, sc.index, "distiller", "distill_knowledge_candidates", refs);
  return created;
}

export async function runLibrarian(projectId: string, cycleId: string, sc: ScenarioRound) {
  const auditCorpus = storage.listKnowledge(projectId)
    .map((item) => `${item.title}\n${item.content}`)
    .join("\n")
    .slice(0, 4000);
  await callLlm({
    cycleId,
    agent: "librarian",
    promptName: "audit_and_merge",
    inputSummary: "incremental audit",
    context: { knowledgeCount: storage.listKnowledge(projectId).length },
    knowledgeSummary: buildKnowledgeContext(
      `audit merge transition\n${scenarioKnowledgeQuery(sc)}\n${auditCorpus}`,
      projectId,
      { cycleIdx: sc.index, cycleId, agent: "librarian" },
    ),
    schema: SUMMARY_ARRAY_SCHEMA,
    mockOutput: { summary: "transitions computed", items: [] },
  });
  const transitions: string[] = [];

  for (const k of storage.listKnowledge(projectId)) {
    const semanticKey = k.semanticKey || computeSemanticKey(k.title, k.content);
    if (semanticKey !== (k.semanticKey ?? "")) {
      storage.updateKnowledge(k.id, { semanticKey });
    }
  }

  const confidenceLevelFor = (score: number, ev: number, humanApprovedCount: number): KnowledgeItem["confidenceLevel"] => {
    if (score >= 0.85 && ev >= 5 && humanApprovedCount > 0) return "verified";
    if (score >= 0.75 && ev >= 3) return "high";
    if (score >= 0.6 && ev >= 1) return "medium";
    return "low";
  };

  const chooseKeeper = (a: KnowledgeItem, b: KnowledgeItem) => {
    if (a.status !== b.status) {
      if (a.status === "strong") return a;
      if (b.status === "strong") return b;
      if (a.status === "active") return a;
      if (b.status === "active") return b;
    }
    if (a.confidenceScore !== b.confidenceScore) return a.confidenceScore > b.confidenceScore ? a : b;
    return a.createdByCycle <= b.createdByCycle ? a : b;
  };

  const mergePair = (a: KnowledgeItem, b: KnowledgeItem) => {
    const keeper = chooseKeeper(a, b);
    const duplicate = keeper.id === a.id ? b : a;
    const alpha = 1 + Math.max(0, keeper.evidenceAlpha - 1) + Math.max(0, duplicate.evidenceAlpha - 1);
    const beta = 1 + Math.max(0, keeper.evidenceBeta - 1) + Math.max(0, duplicate.evidenceBeta - 1);
    const ev = evidenceCount({ evidenceAlpha: alpha, evidenceBeta: beta });
    const score = alpha / (alpha + beta);
    const tags = Array.from(new Set([...parseTags(keeper), ...parseTags(duplicate)]));
    const sourceRef = Array.from(new Set(
      `${keeper.sourceRef},${duplicate.sourceRef}`.split(",").map((item) => item.trim()).filter(Boolean),
    )).join(",");
    const notes = [
      keeper.notes,
      `Librarian merge: absorbed ${duplicate.id}; preserved evidence and sourceRef=${duplicate.sourceRef || "n/a"}.`,
    ].filter(Boolean).join("\n");
    storage.updateKnowledge(keeper.id, {
      evidenceAlpha: alpha,
      evidenceBeta: beta,
      confidenceScore: score,
      confidenceLevel: confidenceLevelFor(score, ev, keeper.humanApprovedCount + duplicate.humanApprovedCount),
      humanApprovedCount: keeper.humanApprovedCount + duplicate.humanApprovedCount,
      externalVerifiedCount: keeper.externalVerifiedCount + duplicate.externalVerifiedCount,
      lastValidatedCycle: Math.max(keeper.lastValidatedCycle, duplicate.lastValidatedCycle, sc.index),
      usageCount: keeper.usageCount + duplicate.usageCount,
      tags: JSON.stringify(tags),
      sourceRef,
      notes,
      semanticKey: keeper.semanticKey || duplicate.semanticKey || computeSemanticKey(keeper.title, keeper.content),
    });
    storage.updateKnowledge(duplicate.id, {
      supersededBy: keeper.id,
      semanticKey: duplicate.semanticKey || keeper.semanticKey || computeSemanticKey(duplicate.title, duplicate.content),
      notes: `${duplicate.notes}\nLibrarian merge: superseded by ${keeper.id}, not physically deleted.`.trim(),
      lastValidatedCycle: Math.max(duplicate.lastValidatedCycle, sc.index),
    });
    logEvent(sc.index, "librarian", "knowledge_items", "merge", {
      keeperId: keeper.id,
      supersededId: duplicate.id,
      evidenceAlpha: alpha,
      evidenceBeta: beta,
    });
    transitions.push(`${duplicate.id}: merged->${keeper.id}`);
  };

  let mergeCandidates = storage.listKnowledge(projectId)
    .filter((k) => !k.supersededBy)
    .filter((k) => !["expired", "quarantined", "conflict"].includes(k.status));
  for (let i = 0; i < mergeCandidates.length; i += 1) {
    for (let j = i + 1; j < mergeCandidates.length; j += 1) {
      const a = mergeCandidates[i];
      const b = mergeCandidates[j];
      if (isContradiction(a, b)) continue;
      if (!isSemanticDuplicate(a, b, 0.72)) continue;
      mergePair(a, b);
      mergeCandidates = storage.listKnowledge(projectId)
        .filter((k) => !k.supersededBy)
        .filter((k) => !["expired", "quarantined", "conflict"].includes(k.status));
      i = -1;
      break;
    }
  }

  const strongKnowledge = storage.listKnowledge(projectId)
    .filter((k) => !k.supersededBy && k.status === "strong");
  const comparableConflict = (candidate: KnowledgeItem) => strongKnowledge.some((strong) => {
    if (strong.id === candidate.id) return false;
    const candidateEv = evidenceCount(coreFromDb(candidate));
    const strongEv = evidenceCount(coreFromDb(strong));
    return candidateEv >= 1 && strongEv >= 1 && isContradiction(candidate, strong);
  });

  for (const k of storage.listKnowledge(projectId).filter((item) => !item.supersededBy)) {
    if (k.validUntil) {
      const validUntilMs = Date.parse(k.validUntil);
      if (Number.isFinite(validUntilMs) && validUntilMs < Date.now() && !["stale", "expired", "quarantined", "conflict"].includes(k.status)) {
        storage.updateKnowledge(k.id, { status: "stale", lastValidatedCycle: sc.index });
        transitions.push(`${k.id}: ${k.status}->stale (valid_until expired)`);
        logEvent(sc.index, "librarian", "knowledge_items", "transition", { id: k.id, from: k.status, to: "stale" });
        recordTrace({
          projectId,
          cycleId,
          cycleIdx: sc.index,
          kind: "principle_transition",
          name: "knowledge_valid_until_expired",
          agent: "librarian",
          attributes: { knowledgeId: k.id, from: k.status, to: "stale", reason: "valid_until expired" },
        });
        continue;
      }
    }
    const core = coreFromDb(k);
    const r = transitionState(core, {
      currentCycle: sc.index, conflictsWithStrong: comparableConflict(k),
      humanApprovedStrongPromotion: k.humanApprovedCount >= 1,
    });
    if (r.changed) {
      storage.updateKnowledge(k.id, { status: r.nextStatus });
      transitions.push(`${k.id}: ${k.status}->${r.nextStatus} (${r.reason})`);
      logEvent(sc.index, "librarian", "knowledge_items", "transition", { id: k.id, from: k.status, to: r.nextStatus });
      recordTrace({
        projectId,
        cycleId,
        cycleIdx: sc.index,
        kind: "principle_transition",
        name: "knowledge_status_transition",
        agent: "librarian",
        attributes: { knowledgeId: k.id, from: k.status, to: r.nextStatus, reason: r.reason },
      });
    }
  }
  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "librarian", action: "audit_merge_transition",
    outputSummary: transitions.length ? transitions.join(" | ") : "无状态迁移",
    knowledgeRefsUsed: "[]", ts: now(),
  });
  traceAgentRun(projectId, cycleId, sc.index, "librarian", "audit_merge_transition", []);
  return transitions;
}

export async function runOperationalStagesAfterApprovedDirection(projectId: string, cycleId: string) {
  const cycle = storage.getCycle(cycleId);
  if (!cycle) throw new Error("cycle not found");
  const sc = directionScenarioFromGate(cycleId) ?? await resolveCycleStimulus(projectId, cycle.idx, cycleId);
  const directionPlan = readDirectionPlan(cycleId, sc);

  await runSensor(projectId, cycleId, sc);
  await runBuilder(cycleId, sc, directionPlan.action, directionPlan.refs);
  const { pred, claimError } = evaluatePrediction(projectId, cycleId, sc, directionPlan);
  await runDistiller(projectId, cycleId, sc, claimError, directionPlan.refs);
  const transitions = await runLibrarian(projectId, cycleId, sc);

  const decisionKnowledgeCount = storage.listKnowledge(projectId)
    .filter((item) => !item.supersededBy && ["active", "strong"].includes(item.status))
    .length;
  const strongKnowledgeCount = storage.listKnowledge(projectId)
    .filter((item) => !item.supersededBy && item.status === "strong")
    .length;
  const snapshot = JSON.stringify({
    strongCount: strongKnowledgeCount,
    decisionKnowledgeCount,
    cycleIdx: sc.index,
    closedAt: now(),
  });
  const currentReasoning = storage.getCycle(cycleId)?.reasoning ?? "";
  const normalizedReasoning = currentReasoning
    .split("\n")
    .filter((line) => !line.startsWith("__flywheel_snapshot__="))
    .join("\n");
  storage.updateCycle(cycleId, {
    status: "closed",
    reasoning: `${normalizedReasoning}\n__flywheel_snapshot__=${snapshot}`.trim(),
  });
  logEvent(sc.index, "orchestrator", "cycles", "close", { cycleId });
  recordTrace({
    projectId,
    cycleId,
    cycleIdx: sc.index,
    kind: "cycle_state",
    name: "cycle_closed",
    agent: "orchestrator",
    attributes: { strongKnowledgeCount, decisionKnowledgeCount, transitions },
  });

  return { cycleIdx: sc.index, prediction: pred, transitions };
}

// ---------------- run-full: one complete flywheel turn ----------------
export async function runFullCycle(projectId: string, cycleId: string) {
  const cycle = storage.getCycle(cycleId);
  if (!cycle) throw new Error("cycle not found");
  const sc = await resolveCycleStimulus(projectId, cycle.idx, cycleId);
  recordTrace({
    projectId,
    cycleId,
    cycleIdx: cycle.idx,
    kind: "cycle_state",
    name: "cycle_started",
    agent: "orchestrator",
    attributes: { goal: cycle.goal, status: cycle.status },
  });

  const plan = await runOrchestrator(projectId, cycleId, sc);
  humanResolveDirectionGate(projectId, cycleId, plan.gate.id, sc);
  return runOperationalStagesAfterApprovedDirection(projectId, cycleId);
}
