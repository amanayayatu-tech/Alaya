/**
 * Flywheel engine: ports shared/core/agents_ref.ts logic to a SQLite-backed runner.
 * Reuses the verified pure functions from shared/core (NO algorithm changes).
 * Sequentially schedules the 5 fixed agents and records every write to eventLog,
 * every LLM call to llmCalls (mock by default, OpenAI when configured).
 */
import { storage, now } from "./storage";
import { callLlm } from "./llm";
import { computeClaimError, computeCycleError } from "@shared/core/compute_error.js";
import { classifyError, routeError } from "@shared/core/classify_error.js";
import { applyEvidence } from "@shared/core/update_confidence.js";
import { transitionState } from "@shared/core/transition_state.js";
import type { Claim, AttributionContext, Operator } from "@shared/core/types.js";
import type { KnowledgeItem } from "@shared/schema";

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
    belief: "(由系统生成)",
    prediction: "(由系统生成)",
    action: "(由系统生成)",
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
  return storage.listKnowledge(projectId).filter((k) => ["active", "strong", "draft", "provisional"].includes(k.status));
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

function knowledgeSummary(items: KnowledgeItem[]): string {
  return items
    .map((k) => `${k.id} [${k.status}] ${k.title} tags=${parseTags(k).join(",")}`)
    .join("\n")
    .slice(0, 4000);
}

function safeKnowledgeRefs(projectId: string, proposed: unknown, fallback: string[]): string[] {
  const allowed = new Set(activeKnowledge(projectId).map((k) => k.id));
  const refs = stringArray(proposed).filter((id) => allowed.has(id));
  return refs.length > 0 || fallback.length === 0 ? refs : fallback;
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
  return value === ">=" || value === "<=" || value === "==";
}

function failureThreshold(metric: string, operator: Operator, target: number): string {
  if (operator === ">=") return `${metric} < ${target}`;
  if (operator === "<=") return `${metric} > ${target}`;
  return `${metric} != ${target}`;
}

function claimConfigForCycle(projectId: string, sc: ScenarioRound) {
  const project = storage.getProject(projectId);
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

// ---------------- Agents ----------------
export async function runOrchestrator(projectId: string, cycleId: string, sc: ScenarioRound, llmCaller: LlmCaller = callLlm) {
  let goal = sc.proposedGoal, belief = sc.belief, prediction = sc.prediction, action = sc.action;
  const refs: string[] = [];
  let reasoning = "";
  const project = storage.getProject(projectId);
  const firstCyclePlan = projectSpecificFirstCyclePlan(projectId, cycleId, sc);

  if (firstCyclePlan) {
    ({ goal, belief, prediction, action, reasoning } = firstCyclePlan);
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
    knowledgeSummary: knowledgeSummary(usableKnowledge),
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

  storage.updateCycle(cycleId, { goal, reasoning, status: "running" });
  logEvent(sc.index, "orchestrator", "cycles", "update", { cycleId, goal });

  const rollbackPlan = rollbackReadyChangePackage(sc, action);
  const auditSummary = sc.index === 4 ? auditSummaryForCycle4(refs) : undefined;
  const gateId = sc.index === 4 ? `gate_dir_c4_rollback_${cycleId.slice(-8)}` : `gate_dir_c${sc.index}_${cycleId.slice(-8)}`;
  const gateTitle = sc.index === 4 ? "第 4 轮可回滚执行闸: 变更包 + 审计摘要" : `第 ${sc.index} 轮方向闸`;

  // direction gate (PRD 11.1)
  const gate = storage.createGate({
    id: gateId,
    cycleId, type: "direction", blocking: 1,
    title: gateTitle,
    payload: JSON.stringify({
      recommended: goal,
      alternatives: sc.alternativeGoals,
      knowledgeRefs: refs,
      reasoning,
      belief,
      prediction,
      action,
      ...(rollbackPlan ? { rollbackPlan, rollbackTrigger: rollbackPlan.rollbackTrigger } : {}),
      ...(auditSummary ? { auditSummary } : {}),
      createdAt: now(),
    }),
    status: "pending", estimatedMinutes: 10, decision: null, version: 1,
  });
  logEvent(sc.index, "orchestrator", "human_gate_items", "insert", { gateId: gate.id });

  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "orchestrator",
    action: "plan_cycle + open_direction_gate",
    outputSummary: `目标: ${goal}${refs.length ? ` | 引用知识: ${refs.join(",")}` : ""}`,
    knowledgeRefsUsed: JSON.stringify(refs), ts: now(),
  });

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
    };
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
    schema: SUMMARY_ARRAY_SCHEMA,
    mockOutput: {
      summary: "clustered + preserved quotes",
      items: unclear.map((f) => ({ id: f.id, category: f.category })),
    },
  });

  for (const f of sc.feedback) {
    storage.createFeedback({
      id: `${f.id}_${cycleId}`,
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
    const gate = storage.createGate({
      id: `gate_meaning_${sc.index}_${cycleId.slice(-8)}_${u.id}`,
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
  return { unclear };
}

export async function runBuilder(cycleId: string, sc: ScenarioRound, plannedAction = sc.action, refs: string[] = [], llmCaller: LlmCaller = callLlm) {
  const rollbackPlan = rollbackReadyChangePackage(sc, plannedAction);
  const auditSummary = sc.index === 4 ? auditSummaryForCycle4(refs) : undefined;

  const llmData = await llmCaller({
    cycleId,
    agent: "builder",
    promptName: "emit_task_spec",
    inputSummary: plannedAction,
    context: { action: plannedAction, rollbackPlan, auditSummary },
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
  const task = storage.createTask({
    id: `task_build_c${sc.index}_${cycleId.slice(-8)}`, cycleId, agent: "builder", kind: "build",
    status: sc.buildSuccess ? "done" : "failed",
    spec: JSON.stringify(taskSpec),
  });
  logEvent(sc.index, "builder", "tasks", "insert", { taskId: task.id, success: sc.buildSuccess });
  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "builder", action: "emit_task_spec + receive_mock_build_report",
    outputSummary: `build=${sc.buildSuccess ? "成功" : "失败"} | ${diffSummary}`,
    knowledgeRefsUsed: "[]", ts: now(),
  });
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

  const errorType = classifyError(claim.error, {
    perceptionFailure: !sc.perceptionOk,
    executionFailure: !sc.buildSuccess,
    humanFlaggedValueMismatch: sc.humanValueMismatch,
    isQualitative: false,
  } as AttributionContext);

  const pred = storage.createPrediction({
    id: sc.index === 4 ? `pred_c4_rollback_${cycleId.slice(-8)}` : `pred_c${sc.index}_${cycleId.slice(-8)}`,
    cycleId,
    belief: plan.belief, prediction: plan.prediction, action: plan.action,
    claims: JSON.stringify([claim]),
    observation: `activation_rate = ${sc.activationObserved}`,
    predictionError: cycleErr.eCycle, worstClaimError: cycleErr.worstClaimError,
    errorType: errorType, updateTarget: routeError(errorType), status: "resolved",
    knowledgeRefs: JSON.stringify(plan.refs),
  });
  storage.createObservation({
    id: `obs_c${sc.index}_${cycleId.slice(-8)}`, cycleId, predictionId: pred.id,
    metric: config.metric, value: config.observed, source: "mock_analytics",
  });
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

  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "distiller", action: "distill_knowledge_candidates",
    outputSummary: created.length ? `生成知识候选: ${created.join(",")}` : "强化既有知识证据",
    knowledgeRefsUsed: JSON.stringify(refs), ts: now(),
  });
  return created;
}

export async function runLibrarian(projectId: string, cycleId: string, sc: ScenarioRound) {
  await callLlm({
    cycleId,
    agent: "librarian",
    promptName: "audit_and_merge",
    inputSummary: "incremental audit",
    context: { knowledgeCount: storage.listKnowledge(projectId).length },
    schema: SUMMARY_ARRAY_SCHEMA,
    mockOutput: { summary: "transitions computed", items: [] },
  });
  const transitions: string[] = [];
  for (const k of storage.listKnowledge(projectId)) {
    const core = coreFromDb(k);
    const r = transitionState(core, {
      currentCycle: sc.index, conflictsWithStrong: false,
      humanApprovedStrongPromotion: k.humanApprovedCount >= 1,
    });
    if (r.changed) {
      storage.updateKnowledge(k.id, { status: r.nextStatus });
      transitions.push(`${k.id}: ${k.status}->${r.nextStatus} (${r.reason})`);
      logEvent(sc.index, "librarian", "knowledge_items", "transition", { id: k.id, from: k.status, to: r.nextStatus });
    }
  }
  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "librarian", action: "audit_merge_transition",
    outputSummary: transitions.length ? transitions.join(" | ") : "无状态迁移",
    knowledgeRefsUsed: "[]", ts: now(),
  });
  return transitions;
}

export async function runOperationalStagesAfterApprovedDirection(projectId: string, cycleId: string) {
  const cycle = storage.getCycle(cycleId);
  if (!cycle) throw new Error("cycle not found");
  const sc = requireScenarioRound(cycle.idx);
  const directionPlan = readDirectionPlan(cycleId, sc);

  await runSensor(projectId, cycleId, sc);
  await runBuilder(cycleId, sc, directionPlan.action, directionPlan.refs);
  const { pred, claimError } = evaluatePrediction(projectId, cycleId, sc, directionPlan);
  await runDistiller(projectId, cycleId, sc, claimError, directionPlan.refs);
  const transitions = await runLibrarian(projectId, cycleId, sc);

  storage.updateCycle(cycleId, { status: "closed" });
  logEvent(sc.index, "orchestrator", "cycles", "close", { cycleId });

  return { cycleIdx: sc.index, prediction: pred, transitions };
}

// ---------------- run-full: one complete flywheel turn ----------------
export async function runFullCycle(projectId: string, cycleId: string) {
  const cycle = storage.getCycle(cycleId);
  if (!cycle) throw new Error("cycle not found");
  const sc = requireScenarioRound(cycle.idx);

  const plan = await runOrchestrator(projectId, cycleId, sc);
  humanResolveDirectionGate(projectId, cycleId, plan.gate.id, sc);
  return runOperationalStagesAfterApprovedDirection(projectId, cycleId);
}
